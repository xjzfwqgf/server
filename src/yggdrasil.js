import crypto from 'crypto'
import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { config } from './config.js'
import { db } from './db.js'
import { ah } from './middleware/async.js'

// ============================================================================
// MC 认证服：authlib-injector 兼容的 Yggdrasil 服务端。
// 把视频站账号体系当作 Minecraft 认证源：玩家在启动器里 authlib-injector 指向
// config.mcAuth.mountPath（如 /mc），用网站用户名+密码登录，即可进你们服务器。
//
// 实现的协议端点（相对 mountPath）：
//   GET  /                                        -> metadata（authlib-injector 探测）
//   POST /authserver/authenticate                 -> 登录，签发 accessToken
//   POST /authserver/refresh                      -> 刷新 accessToken
//   POST /authserver/validate                     -> 校验 accessToken
//   POST /authserver/invalidate                   -> 使 accessToken 失效
//   POST /authserver/signout                      -> 使该玩家全部会话失效
//   GET  /sessionserver/session/profile/:uuid     -> 玩家档案 + 皮肤纹理
//   POST /sessionserver/session/join              -> 客户端进服前上报身份
//   GET  /sessionserver/session/hasJoined         -> MC 服务器核对玩家已 join
// ============================================================================

const router = Router()

// MC 用户名规则：3-16 位字母数字下划线（与注册规则一致，但 MC 上限为 16 位）
const MC_NAME_RE = /^[a-zA-Z0-9_]{3,16}$/

// 本地无连字符 UUID（32 hex，MD5），由 user.id 稳定派生，作为玩家在游戏里的唯一身份。
// 用 MD5(user.id) 而非真随机：同一个网站账号永远映射到同一个游戏身份，进服皮肤/数据稳定。
export function profileUuid(userId) {
  return crypto.createHash('md5').update(`video-site:${userId}`).digest('hex')
}

// 把可能带连字符/大小写混乱的 UUID 归一化
function normalizeUuid(input) {
  return String(input || '').replace(/-/g, '').toLowerCase()
}

function jsonProfile(uuid, name) {
  return { id: uuid, name }
}

function ygError(res, message, status = 400) {
  return res.status(status).json({ error: 'ForbiddenOperationException', errorMessage: message })
}

function newAccessToken() {
  return crypto.randomBytes(24).toString('hex')
}

function expiresAt() {
  return new Date(Date.now() + config.mcAuth.tokenTtl * 1000).toISOString()
}

async function findUserByUsername(username) {
  return db.get('SELECT * FROM users WHERE username = ?', [String(username || '').trim()])
}

// 用 accessToken 定位「会话 + 用户」；token 无效/过期/用户被封 均返回 null
async function sessionByToken(accessToken) {
  if (!accessToken) return null
  const s = await db.get('SELECT * FROM mc_sessions WHERE access_token = ?', [accessToken])
  if (!s) return null
  if (new Date(s.expires_at).getTime() < Date.now()) return null
  const u = await db.get('SELECT * FROM users WHERE id = ?', [s.user_id])
  if (!u || u.status === 0) return null
  return { s, u }
}

// 构造含纹理的 profile 响应：配置了默认皮肤才带 textures（未配置则玩家显示默认存档皮肤）
function profileWithTextures(uuid, name) {
  const out = { id: uuid, name, properties: [] }
  if (config.mcAuth.defaultSkinUrl) {
    const textures = {
      timestamp: Date.now(),
      profileId: uuid,
      profileName: name,
      textures: { SKIN: { url: config.mcAuth.defaultSkinUrl } },
    }
    out.properties.push({
      name: 'textures',
      value: Buffer.from(JSON.stringify(textures)).toString('base64'),
    })
  }
  return out
}

// ---- metadata（authlib-injector 探测端点）----
router.get('/', (req, res) => {
  res.json({
    meta: {
      serverName: '夜场视频站认证服',
      implementationName: 'video-site-yggdrasil',
      implementationVersion: '1.0.0',
      feature: {
        non_email_login: true, // 用用户名（非邮箱）登录
        no_yggdrasil_session: false, // 支持 sessionserver session/join|hasJoined
        enable_fast_login: false,
      },
    },
    skinDomains: [],
  })
})

// ---- authserver/authenticate：玩家用网站账号登录 ----
router.post('/authserver/authenticate', ah(async (req, res) => {
  const { username, password, clientToken } = req.body || {}
  const uname = String(username || '').trim()
  const pw = String(password || '')
  if (!uname || !pw) return ygError(res, '用户名或密码不能为空')

  if (!MC_NAME_RE.test(uname)) {
    return ygError(res, '用户名不符合 Minecraft 命名规则（3-16 位字母数字下划线），无法作为游戏昵称', 401)
  }

  const user = await findUserByUsername(uname)
  const ok = user && (await bcrypt.compare(pw, user.password_hash))
  if (!ok) return ygError(res, '用户名或密码错误', 401)
  if (user.status === 0) return ygError(res, '账号已被封禁', 403)

  const uuid = profileUuid(user.id)
  const accessToken = newAccessToken()
  const ct = String(clientToken || newAccessToken()) // 客户端没带则生成一个
  const now = new Date().toISOString()

  // 稳定保存 MC 身份，供 profile 端点按 UUID 反查昵称（同名只保留最新）
  await db.run(
    'INSERT INTO mc_profiles (user_id, profile_id, profile_name, updated_at) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(user_id) DO UPDATE SET profile_id = excluded.profile_id, ' +
      'profile_name = excluded.profile_name, updated_at = excluded.updated_at',
    [user.id, uuid, uname, now],
  )

  await db.run(
    'INSERT INTO mc_sessions (user_id, access_token, client_token, profile_id, profile_name, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    [user.id, accessToken, ct, uuid, uname, expiresAt()],
  )

  res.json({
    accessToken,
    clientToken: ct,
    selectedProfile: jsonProfile(uuid, uname),
    availableProfiles: [jsonProfile(uuid, uname)],
    user: { id: uuid, properties: [] },
  })
}))

// ---- authserver/refresh：用 accessToken 刷新会话（一般换新 token 续期）----
router.post('/authserver/refresh', ah(async (req, res) => {
  const { accessToken, clientToken } = req.body || {}
  const found = await sessionByToken(accessToken)
  if (!found) return ygError(res, '无效的 accessToken', 403)
  const newTok = newAccessToken()
  const ct = String(clientToken || found.s.client_token)
  await db.run('UPDATE mc_sessions SET access_token = ?, client_token = ?, expires_at = ? WHERE id = ?', [
    newTok,
    ct,
    expiresAt(),
    found.s.id,
  ])
  res.json({
    accessToken: newTok,
    clientToken: ct,
    selectedProfile: jsonProfile(found.s.profile_id, found.s.profile_name),
    user: { id: found.s.profile_id, properties: [] },
  })
}))

// ---- authserver/validate：校验 accessToken 是否有效 ----
router.post('/authserver/validate', ah(async (req, res) => {
  const found = await sessionByToken((req.body || {}).accessToken)
  if (!found) return ygError(res, '无效的 accessToken', 403)
  res.status(204).end()
}))

// ---- authserver/invalidate：使指定 accessToken 失效（登出）----
router.post('/authserver/invalidate', ah(async (req, res) => {
  const { accessToken } = req.body || {}
  if (accessToken) await db.run('DELETE FROM mc_sessions WHERE access_token = ?', [accessToken])
  res.status(204).end()
}))

// ---- authserver/signout：按用户名+密码使该玩家全部会话失效 ----
router.post('/authserver/signout', ah(async (req, res) => {
  const { username, password } = req.body || {}
  const user = await findUserByUsername(username)
  const ok = user && (await bcrypt.compare(String(password || ''), user.password_hash))
  if (ok) await db.run('DELETE FROM mc_sessions WHERE user_id = ?', [user.id])
  res.status(204).end()
}))

// ---- sessionserver/session/profile/:uuid：返回玩家档案与皮肤纹理 ----
router.get('/sessionserver/session/profile/:uuid', ah(async (req, res) => {
  const uuid = normalizeUuid(req.params.uuid)
  if (!/^[0-9a-f]{32}$/.test(uuid)) return ygError(res, '无效的玩家 UUID', 400)
  const profile = await db.get(
    'SELECT p.*, u.status FROM mc_profiles p JOIN users u ON u.id = p.user_id WHERE p.profile_id = ?',
    [uuid],
  )
  if (!profile) return ygError(res, '未找到该玩家', 404)
  res.json(profileWithTextures(uuid, profile.profile_name))
}))

// ---- sessionserver/session/join：客户端启动游戏、连服前上报身份 ----
router.post('/sessionserver/session/join', ah(async (req, res) => {
  const { accessToken, selectedProfile, serverId } = req.body || {}
  const found = await sessionByToken(accessToken)
  if (!found) return ygError(res, '无效的 accessToken', 403)
  if (!serverId) return ygError(res, '缺少 serverId', 400)
  // 校验上报的 profile 与本会话一致，防伪冒
  const rid = normalizeUuid((selectedProfile || {}).id)
  const rname = (selectedProfile || {}).name
  if (rid && rid !== found.s.profile_id) return ygError(res, 'profile 不匹配', 403)
  if (rname && rname !== found.s.profile_name) return ygError(res, 'profile 不匹配', 403)
  await db.run('UPDATE mc_sessions SET server_id = ? WHERE id = ?', [String(serverId), found.s.id])
  res.status(204).end()
}))

// ---- sessionserver/session/hasJoined：MC 服务器核对玩家是否已 join 过 ----
router.get('/sessionserver/session/hasJoined', ah(async (req, res) => {
  const { username, serverId } = req.query
  if (!username || !serverId) return ygError(res, '缺少 username 或 serverId', 400)
  const s = await db.get('SELECT * FROM mc_sessions WHERE profile_name = ? AND server_id = ?', [
    String(username),
    String(serverId),
  ])
  if (!s || new Date(s.expires_at).getTime() < Date.now()) return res.status(204).end()
  res.json(profileWithTextures(s.profile_id, s.profile_name))
}))

export default router
