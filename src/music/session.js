/**
 * 全站共用的酷狗会话。
 *
 * 需求是「全站共用一份」，所以是单例行（kg_session 表 CHECK(id=1)），
 * 且绑定/解绑/同步都必须挂 requireAdmin —— 否则任何登录用户都能改掉别人共用的账号。
 *
 * ⚠️ 所有读写都是**异步**的（线上走 Turso / libSQL over HTTPS，没有同步 API），
 *    调用方必须 await。时间统一用 `datetime('now')`（UTC），不要加本地时区修饰符：
 *    Turso 的服务器时区是 UTC，本地时区写法会让两边算出来的时间不一致。
 *
 * ⚠️ token 绝不回传到任何 API 响应里。对外只暴露 publicStatus()。
 */
import { db } from '../db.js'
import { getDfid, refreshToken } from './kugou.js'

const KEY_DFID = 'dfid'
const KEY_LAST_SYNC = 'last_sync_at'

// ---------------------------------------------------------------- kg_meta 读写

export async function getMeta(k) {
  const row = await db.get('SELECT v FROM kg_meta WHERE k = ?', [k])
  return row?.v ?? null
}

export async function setMeta(k, v) {
  await db.run(
    'INSERT INTO kg_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
    [k, String(v)],
  )
}

// ---------------------------------------------------------------- 绑定行

/** 酷狗绑定行（含 token）。**只在服务端内部用**，绝不直接下发。 */
export async function getBinding() {
  return (await db.get('SELECT * FROM kg_session WHERE id = 1', [])) || null
}

export async function saveBinding({ token, userid, nickname }) {
  await db.run(
    `INSERT INTO kg_session (id, token, userid, nickname, updated_at)
     VALUES (1, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       token      = excluded.token,
       userid     = excluded.userid,
       nickname   = excluded.nickname,
       updated_at = excluded.updated_at`,
    [String(token || ''), String(userid || ''), String(nickname || '')],
  )
}

/** 学会「我喜欢」是哪个歌单后固化下来，避免每次同步都重猜 */
export async function saveLikedPlaylist(id, name) {
  await db.run(
    `UPDATE kg_session
        SET liked_playlist_id = ?, liked_playlist_name = ?, updated_at = datetime('now')
      WHERE id = 1`,
    [String(id || ''), String(name || '')],
  )
}

export async function clearBinding() {
  await db.run('DELETE FROM kg_session WHERE id = 1', [])
  await db.run('DELETE FROM kg_meta WHERE k = ?', [KEY_LAST_SYNC])
}

// ---------------------------------------------------------------- 设备指纹

/**
 * dfid 是**设备**指纹：`/song/url` 不带它会报 20028「本次请求需要验证」。
 * 匿名即可获取，且与登录态无关，所以缓存在 kg_meta 里共用。
 */
export async function ensureDfid(force = false) {
  if (!force) {
    const cached = await getMeta(KEY_DFID)
    if (cached) return cached
  }
  const dfid = await getDfid()
  await setMeta(KEY_DFID, dfid)
  return dfid
}

// ---------------------------------------------------------------- 对外会话对象

export class UnboundError extends Error {
  constructor() {
    super('尚未绑定酷狗账号')
    this.name = 'UnboundError'
    this.code = 'KG_UNBOUND'
    this.status = 403
  }
}

/**
 * 交给 kugou.js 的 request() 的登录态。
 *
 * 未绑定时**不抛错**，返回一个只有 dfid 的匿名会话 —— 因为 `/playlist/track/all`、
 * `/search/lyric`、`/song/url` 匿名都能用，只有 `/user/playlist` 才真的要登录。
 * 需要登录的调用方自己传 `{ require: true }`。
 */
export async function activeSession({ require: needLogin = false } = {}) {
  const row = await getBinding()
  const dfid = await ensureDfid()
  if (!row?.token) {
    if (needLogin) throw new UnboundError()
    return { token: '', userid: '', dfid }
  }
  return { token: row.token, userid: row.userid, dfid }
}

/**
 * 刷新 token（酷狗 token 会过期，过期后所有带 cookie 的接口都会开始报鉴权错误）。
 * 失败不致命，静默保留旧值，由上层决定是否提示重新扫码。
 */
export async function tryRefreshToken() {
  const row = await getBinding()
  if (!row?.token) return false
  try {
    const next = await refreshToken({ token: row.token, userid: row.userid })
    if (next.token) {
      await saveBinding({ token: next.token, userid: next.userid || row.userid, nickname: row.nickname })
      return true
    }
  } catch {
    /* 刷新失败按未刷新处理 */
  }
  return false
}

// ---------------------------------------------------------------- 对外状态

/** `/status` 的响应体。**刻意逐字段挑**，绝不 spread 整行，避免 token 泄漏。 */
export async function publicStatus() {
  const row = await getBinding()
  const counts = await db.get(
    `SELECT
       SUM(CASE WHEN in_liked = 1 THEN 1 ELSE 0 END)                  AS total,
       SUM(CASE WHEN in_liked = 1 AND playable = 1 THEN 1 ELSE 0 END) AS playable,
       SUM(CASE WHEN in_liked = 1 AND playable = 0 THEN 1 ELSE 0 END) AS restricted
     FROM kg_tracks`,
    [],
  )
  const lastSyncAt = (await getMeta(KEY_LAST_SYNC)) || ''
  return {
    bound: !!row?.token,
    nickname: row?.nickname || '',
    boundAt: row?.updated_at || '',
    likedPlaylistId: row?.liked_playlist_id || '',
    likedPlaylistName: row?.liked_playlist_name || '',
    trackCount: Number(counts?.total) || 0,
    playableCount: Number(counts?.playable) || 0,
    restrictedCount: Number(counts?.restricted) || 0,
    lastSyncAt,
  }
}

export const markSynced = () => setMeta(KEY_LAST_SYNC, new Date().toISOString())
