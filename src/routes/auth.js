import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { config } from '../config.js'
import { db } from '../db.js'
import { signToken, requireAuth } from '../middleware/auth.js'
import { ah } from '../middleware/async.js'
import { rateLimit } from '../middleware/ratelimit.js'

const router = Router()

// 登录失败锁定：同用户名连续 FAIL_LIMIT 次失败后锁定 LOCK_TIME 毫秒
const loginFails = new Map() // username -> { count, lockUntil }
const FAIL_LIMIT = 5
const LOCK_TIME = 15 * 60 * 1000

function recordFail(uname) {
  const cur = loginFails.get(uname) || { count: 0, lockUntil: 0 }
  // 仅当存在过锁定且锁定已过期时才重置计数（lockUntil 为 0 表示从未锁定，不能清零）
  if (cur.lockUntil && Date.now() > cur.lockUntil) {
    cur.count = 0
    cur.lockUntil = 0
  }
  cur.count += 1
  if (cur.count >= FAIL_LIMIT) {
    cur.count = 0
    cur.lockUntil = Date.now() + LOCK_TIME
  }
  loginFails.set(uname, cur)
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    nickname: u.nickname,
    avatar: u.avatar,
    bio: u.bio,
    role: u.role,
    status: u.status,
    created_at: u.created_at,
  }
}

// 弱口令黑名单：常见默认/弱密码直接拒绝，避免再被弱口令撞库提权（与弱口令报告对应）。
const WEAK_PASSWORDS = new Set([
  '123456', '1234567', '12345678', '123456789', '1234567890',
  'password', 'p@ssw0rd', 'passw0rd', '111111', '000000', '666666',
  '888888', '121212', '112233', '123123', '654321', '123321',
  'qwerty', 'abc123', 'a123456', 'admin', 'admin123', 'root',
  'letmein', 'welcome', 'iloveyou', 'password1', 'admin888', '520520',
])

// 校验密码强度：长度 >= 8、命中弱口令黑名单或包含用户名的直接拒绝（返回错误信息，合法则返回 null）。
function passwordIssue(password, username) {
  const pw = String(password || '')
  if (pw.length < 8) return '密码至少 8 位'
  if (WEAK_PASSWORDS.has(pw.toLowerCase())) return '密码强度太低，请使用更复杂的密码'
  if (username && pw.toLowerCase().includes(String(username).toLowerCase()))
    return '密码不能包含用户名'
  return null
}

// ---------- GitHub 第三方登录（OAuth2 授权码模式） ----------

// state 防 CSRF：登录跳转前生成并记录，回调时校验并一次性消费
const githubStates = new Map() // state -> { created }
const GITHUB_STATE_TTL = 10 * 60 * 1000

function newGithubState() {
  const state = crypto.randomBytes(24).toString('hex')
  githubStates.set(state, { created: Date.now() })
  return state
}

// 登录成功后回跳的前端基址：环境变量优先；后端托管前端（web/dist 存在，生产/桌面端）时用同源，否则 dev 的 5173
function githubFrontendBase(req) {
  if (config.github.frontendUrl) return config.github.frontendUrl
  if (fs.existsSync(path.resolve(config.root, '..', 'web', 'dist'))) {
    return `${req.protocol}://${req.get('host')}`
  }
  return 'http://localhost:5173'
}

// github.com 连通性在本机偶发被重置，换 token 的 fetch 加重试
async function fetchWithRetry(url, options, retries = 2) {
  let lastErr
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, options)
      if (res.ok) return res
      lastErr = new Error(`HTTP ${res.status}`)
    } catch (e) {
      lastErr = e
    }
    if (i < retries) await new Promise((r) => setTimeout(r, 400 * (i + 1)))
  }
  throw lastErr
}

// 1. 跳转 GitHub 授权页获取授权码
router.get('/github/login', (req, res) => {
  const { clientId, clientSecret, authorizeUrl, redirectUri } = config.github
  if (!clientId || !clientSecret) {
    return res
      .status(503)
      .json({ message: 'GitHub 登录未配置：请设置 GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET 环境变量' })
  }
  const params = new URLSearchParams({
    client_id: clientId,
    state: newGithubState(),
    scope: 'read:user', // 仅读取公开用户资料即可，无需更多权限
  })
  if (redirectUri) params.set('redirect_uri', redirectUri)
  res.redirect(`${authorizeUrl}?${params.toString()}`)
})

// 2. GitHub 授权成功后回跳：校验 state -> 换 token -> 取用户信息 -> 按 github_id 绑定本站用户并签发 JWT
router.get('/github/callback', ah(async (req, res) => {
  const { code, state } = req.query
  const st = githubStates.get(state)
  if (!st || Date.now() - st.created > GITHUB_STATE_TTL) {
    return res.redirect(`${githubFrontendBase(req)}/login?error=${encodeURIComponent('登录已过期或状态校验失败，请重试')}`)
  }
  githubStates.delete(state) // 一次性使用
  if (!code) {
    return res.redirect(`${githubFrontendBase(req)}/login?error=${encodeURIComponent('未获取到授权码')}`)
  }

  const { clientId, clientSecret, tokenUrl, userUrl, redirectUri } = config.github
  try {
    // 用授权码换 access_token（GitHub 默认返回表单编码，Accept: application/json 让其返回 JSON；网络抖动自动重试）
    const tokenRes = await fetchWithRetry(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri }).toString(),
    })
    const tokenData = await tokenRes.json()
    const accessToken = tokenData.access_token
    if (!accessToken) throw new Error(tokenData.error_description || tokenData.error || '换取 AccessToken 失败')

    // 取 GitHub 用户信息
    const userRes = await fetch(userUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'video-site', // GitHub API 要求 User-Agent
      },
    })
    const ghUser = await userRes.json()
    const ghId = String(ghUser.id ?? '').trim()
    if (!ghId) throw new Error(ghUser.message || '获取用户信息失败')

    // 按 github_id 查找或创建本地用户（GitHub 登录无本地密码，密码存随机串不可用）
    let user = await db.get('SELECT * FROM users WHERE github_id = ?', [ghId])
    if (!user) {
      const info = await db.run(
        'INSERT INTO users (username, password_hash, nickname, avatar, github_id) VALUES (?, ?, ?, ?, ?)',
        [
          `gh_${ghId}`, // 本地用户名以 gh_ 前缀 + id 保证唯一且合法
          await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10),
          String(ghUser.name || ghUser.login || '').slice(0, 30) || `gh_${ghId}`,
          String(ghUser.avatar_url || ''),
          ghId,
        ],
      )
      user = await db.get('SELECT * FROM users WHERE id = ?', [info.lastInsertRowid])
    } else {
      await db.run('UPDATE users SET nickname = ?, avatar = ? WHERE id = ?', [
        String(ghUser.name || ghUser.login || user.nickname).slice(0, 30),
        String(ghUser.avatar_url || user.avatar),
        user.id,
      ])
    }

    if (user.status === 0) {
      return res.redirect(`${githubFrontendBase(req)}/login?error=${encodeURIComponent('账号已被封禁')}`)
    }

    const token = signToken(user)
    res.redirect(`${githubFrontendBase(req)}/login?token=${encodeURIComponent(token)}`)
  } catch (e) {
    console.error('[github] 登录失败:', e.message)
    res.redirect(`${githubFrontendBase(req)}/login?error=${encodeURIComponent('GitHub 登录失败，请重试')}`)
  }
}))

// ---------- 夜场自家 OAuth Provider 第三方登录（oauth-server，授权码模式） ----------

// state 防 CSRF：与 GitHub 同机制，独立存储避免互相干扰
const oauthStates = new Map() // state -> { created }
const OAUTH_STATE_TTL = 10 * 60 * 1000

function newOauthState() {
  const state = crypto.randomBytes(24).toString('hex')
  oauthStates.set(state, { created: Date.now() })
  return state
}

// Provider 标准端点：环境变量显式覆盖优先，否则由 baseUrl 推导
function oauthProviderEndpoint(key, defaultPath) {
  return config.oauthProvider[key] || `${config.oauthProvider.baseUrl}${defaultPath}`
}

// 登录成功后回跳的前端基址（与 GitHub 同一规则）
function oauthProviderFrontendBase(req) {
  if (config.oauthProvider.frontendUrl) return config.oauthProvider.frontendUrl
  if (fs.existsSync(path.resolve(config.root, '..', 'web', 'dist'))) {
    return `${req.protocol}://${req.get('host')}`
  }
  return 'http://localhost:5173'
}

// 1. 跳转夜场 OAuth Provider 授权页
router.get('/oauth/login', (req, res) => {
  const { clientId, clientSecret, redirectUri } = config.oauthProvider
  if (!clientId || !clientSecret) {
    return res
      .status(503)
      .json({ message: '夜场账号登录未配置：请设置 OAUTH_PROVIDER_CLIENT_ID / OAUTH_PROVIDER_CLIENT_SECRET 环境变量' })
  }
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'profile', // 仅读取公开资料（username/nickname）
    state: newOauthState(),
  })
  res.redirect(`${oauthProviderEndpoint('authorizeUrl', '/oauth/authorize')}?${params.toString()}`)
})

// 2. Provider 授权后回跳：校验 state -> 换 token -> 取 userinfo -> 按 sub 绑定本站用户并签发 JWT
router.get('/oauth/callback', ah(async (req, res) => {
  const { code, state, error } = req.query
  const st = oauthStates.get(state)
  if (!st || Date.now() - st.created > OAUTH_STATE_TTL) {
    return res.redirect(`${oauthProviderFrontendBase(req)}/login?error=${encodeURIComponent('登录已过期或状态校验失败，请重试')}`)
  }
  oauthStates.delete(state) // 一次性使用
  if (error) {
    return res.redirect(`${oauthProviderFrontendBase(req)}/login?error=${encodeURIComponent('已取消夜场账号登录')}`)
  }
  if (!code) {
    return res.redirect(`${oauthProviderFrontendBase(req)}/login?error=${encodeURIComponent('未获取到授权码')}`)
  }

  const { clientId, clientSecret, redirectUri } = config.oauthProvider
  try {
    // 用授权码换 access_token（自家 Provider，网络无抖动；仍走 fetchWithRetry 保底）
    const tokenRes = await fetchWithRetry(oauthProviderEndpoint('tokenUrl', '/oauth/token'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    })
    const tokenData = await tokenRes.json()
    const accessToken = tokenData.access_token
    if (!accessToken) throw new Error(tokenData.error_description || tokenData.error || '换取 AccessToken 失败')

    // 取 Provider 用户信息（sub 即 Provider 用户 id，作为绑定键）
    const userRes = await fetch(oauthProviderEndpoint('userUrl', '/oauth/userinfo'), {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    const oaUser = await userRes.json()
    const sub = String(oaUser.sub ?? '').trim()
    if (!sub) throw new Error(oaUser.error_description || oaUser.error || '获取用户信息失败')

    // 按 oauth_provider_id 查找或创建本地用户（无本地密码，密码存随机串不可用）
    let user = await db.get('SELECT * FROM users WHERE oauth_provider_id = ?', [sub])
    if (!user) {
      const info = await db.run(
        'INSERT INTO users (username, password_hash, nickname, oauth_provider_id) VALUES (?, ?, ?, ?)',
        [
          `oauth_${sub}`, // 本地用户名以 oauth_ 前缀 + Provider sub 保证唯一且合法
          await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10),
          String(oaUser.nickname || oaUser.username || '').slice(0, 30) || `oauth_${sub}`,
          sub,
        ],
      )
      user = await db.get('SELECT * FROM users WHERE id = ?', [info.lastInsertRowid])
    } else {
      await db.run('UPDATE users SET nickname = ? WHERE id = ?', [
        String(oaUser.nickname || oaUser.username || user.nickname).slice(0, 30),
        user.id,
      ])
    }

    if (user.status === 0) {
      return res.redirect(`${oauthProviderFrontendBase(req)}/login?error=${encodeURIComponent('账号已被封禁')}`)
    }

    const token = signToken(user)
    res.redirect(`${oauthProviderFrontendBase(req)}/login?token=${encodeURIComponent(token)}`)
  } catch (e) {
    console.error('[oauth-provider] 登录失败:', e.message)
    res.redirect(`${oauthProviderFrontendBase(req)}/login?error=${encodeURIComponent('夜场账号登录失败，请重试')}`)
  }
}))

// 注册（限流防批量注册/爆破）
router.post(
  '/register',
  rateLimit({ windowMs: 10 * 60 * 1000, max: 20, message: '注册过于频繁，请 10 分钟后再试' }),
  ah(async (req, res) => {
    const { username, password, nickname } = req.body || {}
    const uname = String(username || '').trim()
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(uname)) {
      return res.status(400).json({ message: '用户名需为 3-20 位字母、数字或下划线' })
    }
    const pwIssue = passwordIssue(password, uname)
    if (pwIssue) {
      return res.status(400).json({ message: pwIssue })
    }
    const exists = await db.get('SELECT id FROM users WHERE username = ?', [uname])
    if (exists) {
      return res.status(409).json({ message: '用户名已被占用' })
    }
    const hash = await bcrypt.hash(String(password), 10)
    const nick = (nickname && String(nickname).trim()) || uname
    const info = await db.run('INSERT INTO users (username, password_hash, nickname) VALUES (?, ?, ?)', [
      uname,
      hash,
      nick.slice(0, 30),
    ])
    const user = await db.get('SELECT * FROM users WHERE id = ?', [info.lastInsertRowid])
    const token = signToken(user)
    res.json({ token, user: publicUser(user) })
  }),
)

// 登录（IP 限流 + 用户名失败锁定）
router.post(
  '/login',
  rateLimit({ windowMs: 10 * 60 * 1000, max: 30, message: '尝试次数过多，请 10 分钟后再试' }),
  ah(async (req, res) => {
    const { username, password } = req.body || {}
    const uname = String(username || '').trim()

    const fail = loginFails.get(uname)
    if (fail && fail.lockUntil > Date.now()) {
      return res.status(429).json({ message: '账号已锁定，请 15 分钟后再试' })
    }

    const user = await db.get('SELECT * FROM users WHERE username = ?', [uname])
    const ok = user && (await bcrypt.compare(String(password || ''), user.password_hash))
    if (!ok) {
      recordFail(uname)
      return res.status(401).json({ message: '用户名或密码错误' })
    }
    if (user.status === 0) {
      return res.status(403).json({ message: '账号已被封禁' })
    }

    loginFails.delete(uname) // 登录成功，清除失败记录
    const token = signToken(user)
    res.json({ token, user: publicUser(user) })
  }),
)

// 当前用户信息
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) })
})

// 更新资料
router.put('/me', requireAuth, ah(async (req, res) => {
  const { nickname, avatar, bio } = req.body || {}
  const u = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id])
  const nick = (nickname && String(nickname).trim()) || u.nickname
  await db.run('UPDATE users SET nickname = ?, avatar = ?, bio = ? WHERE id = ?', [
    nick.slice(0, 30),
    String(avatar || '').slice(0, 500),
    String(bio || '').slice(0, 200),
    req.user.id,
  ])
  const updated = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id])
  res.json({ user: publicUser(updated) })
}))

// 修改密码
router.put('/me/password', requireAuth, ah(async (req, res) => {
  const { oldPassword, newPassword } = req.body || {}
  const u = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id])
  if (!(await bcrypt.compare(String(oldPassword || ''), u.password_hash))) {
    return res.status(400).json({ message: '原密码错误' })
  }
  const pwIssue = passwordIssue(newPassword, u.username)
  if (pwIssue) {
    return res.status(400).json({ message: pwIssue })
  }
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [
    await bcrypt.hash(String(newPassword), 10),
    req.user.id,
  ])
  res.json({ message: '修改成功' })
}))

export default router
