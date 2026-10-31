/**
 * 封面与歌词的「在线」获取策略（不再落任何本地磁盘）。
 *
 * 降级为「曲库 + 在线播放」之后：
 *   · 封面：优先 302 到 COS 上的 `music/covers/<hash>.jpg`；没有就 302 到酷狗的图片地址
 *     （白名单见 safeCoverUrl —— 只放行 *.kugou.com，防的是「把浏览器/服务端当跳板」）。
 *   · 歌词：优先 fetch CDN 上的 `music/<hash>.lrc` 文本并解析；CDN 没有才回退酷狗接口；
 *     都没有就返回空数组（**绝不 500**，歌词缺失不该让播放页报错）。
 *
 * 歌词必须返回**已解析的** `[{time, text}]` 数组：`<music-player>` 只认这个形状，
 * 喂 LRC 原文会被静默吞成「暂无歌词」。
 */
import { db } from '../db.js'
import { putObject } from '../storage.js'
import {
  hashOf,
  lyricKey,
  lyricPublicUrl,
  coverPublicUrl,
  mimeFor,
  objectExists,
} from './media.js'
import { getLyric } from './kugou.js'
import { parseLrc } from './normalize.js'

const MAX_LYRIC_BYTES = 256 * 1024
const LYRICS_TIMEOUT_MS = 6000

function httpError(message, status = 400) {
  const e = new Error(message)
  e.status = status
  return e
}

// ---------------------------------------------------------------- 封面

/**
 * SSRF / 跳转白名单：封面 URL 虽然来自我们自己的 DB（同步时由酷狗响应写入），
 * 但只要它还是「一个 URL」，就必须假设它可能被污染 —— 服务端替客户端去取任意地址
 * 正是 SSRF 的经典形态（内网 169.254.169.254、127.0.0.1:3000 之类）。
 * 这里只放行 kugou.com 及其子域。
 */
const COVER_HOST_RE = /(^|\.)kugou\.com$/i

export function safeCoverUrl(raw) {
  let u
  try {
    u = new URL(String(raw || ''))
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (!COVER_HOST_RE.test(u.hostname)) return null
  return u
}

/**
 * 解析封面的最终跳转地址；返回 '' 表示「确实没有封面」。
 *
 * 顺序：库里已标记 cover_cached → COS 对象 → 酷狗上游（白名单）→ 无。
 *
 * 为什么要探测 COS 对象：迁移脚本只写对象、不回填列，库里可能没有任何「有封面」的标记；
 * 而封面的观感最敏感 —— 302 到一个不存在的对象，页面就是一块破图。
 */
export async function resolveCoverUrl(track) {
  const hash = String(track?.hash || '')
  if (!hash) return ''

  const cosUrl = coverPublicUrl(hash)
  const upstream = safeCoverUrl(track?.cover_url)

  // 迁移/同步已经标记过「封面在库里」，直接信它（本地文件可信，对象存储同样可信）
  if (track?.cover_cached === 1) return cosUrl

  const exists = await objectExists(cosUrl)
  if (exists === true) {
    // 迁移脚本只往桶里写对象、不回填数据库列，所以「有封面」这个标记常常是空的。
    // 探测成功后顺手补上（只成功一次，之后走上面的快路径）；失败不影响响应。
    if (Number(track?.cover_cached) !== 1) {
      db.run('UPDATE kg_tracks SET cover_cached = 1 WHERE hash = ?', [hash]).catch(() => {})
    }
    return cosUrl
  }
  if (exists === false) return upstream ? upstream.href : ''
  // 未知（本地 dev / 探测抖动 / HEAD 不被支持）：有上游就用上游，否则乐观用约定地址
  return upstream ? upstream.href : cosUrl
}

// ---------------------------------------------------------------- 歌词

/** hash → { at, value }，进程内短缓存：歌词是只读内容，但上游接口有成本 */
const lyricCache = new Map()
const LYRIC_TTL_MS = 10 * 60 * 1000
const LYRIC_CACHE_MAX = 500

function cacheGet(key) {
  const hit = lyricCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > LYRIC_TTL_MS) {
    lyricCache.delete(key)
    return null
  }
  return hit.value
}

function cacheSet(key, value) {
  if (lyricCache.size >= LYRIC_CACHE_MAX) lyricCache.clear()
  lyricCache.set(key, { at: Date.now(), value })
}

/** 取一段文本（歌词）。失败一律返回 ''，由调用方决定回退路径。 */
async function fetchText(url, { timeout = LYRICS_TIMEOUT_MS } = {}) {
  const target = String(url || '')
  if (!target) return ''
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const res = await fetch(target, { signal: controller.signal, redirect: 'follow' })
    if (!res.ok) {
      try {
        await res.body?.cancel()
      } catch {
        /* 忽略 */
      }
      return ''
    }
    const len = Number(res.headers.get('content-length'))
    if (Number.isFinite(len) && len > MAX_LYRIC_BYTES) {
      try {
        await res.body?.cancel()
      } catch {
        /* 忽略 */
      }
      return ''
    }
    const text = await res.text()
    return text.length > MAX_LYRIC_BYTES ? '' : text
  } catch {
    return ''
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 歌词取到之后顺手把 `lyric_cached` 补上（迁移脚本不回填这一列）。
 * 它现在只表示「这首有歌词可用」，供 /tracks 的 hasLyrics 与歌词编辑器判断；
 * 写失败不影响本次响应。
 */
async function markLyricsAvailable(track, hash, lines) {
  if (!lines.length || Number(track?.lyric_cached) === 1) return
  try {
    await db.run('UPDATE kg_tracks SET lyric_cached = 1 WHERE hash = ?', [hash])
  } catch {
    /* 只是标记，失败无所谓 */
  }
}

/**
 * 取歌词（已解析成 `[{time, text}]`）。**永不抛错**，取不到就是 `[]`。
 *
 * 回退顺序：
 *   1. CDN 上的 `music/<hash>.lrc`（迁移脚本写入的歌词）
 *   2. 酷狗 /search/lyric + /lyric（需要 KuGouMusicApi 代理在线）
 *   3. 空数组
 */
export async function getLyricsFor(track) {
  const filename = String(track?.filename || '')
  const hash = hashOf(filename)
  if (!hash) return []

  const cached = cacheGet(hash)
  if (cached) return cached

  // 1) CDN 上的歌词文件（迁移写好的）
  const remoteText = await fetchText(lyricPublicUrl(filename))
  if (remoteText.trim()) {
    const lines = parseLrc(remoteText)
    cacheSet(hash, lines)
    await markLyricsAvailable(track, hash, lines)
    return lines
  }

  // 2) 回退酷狗接口
  try {
    const r = await getLyric({ name: track.name, singerText: track.artist, hash: track.hash })
    const lines = r.text ? parseLrc(r.text) : []
    cacheSet(hash, lines) // 空结果也缓存一小会儿：别每次开歌词面板都白打两次上游
    await markLyricsAvailable(track, hash, lines)
    return lines
  } catch (e) {
    // 网络 / 代理故障：**不写缓存**，下次播放再试
    console.warn(`[music/lyrics] ${track?.name || filename} 抓取失败：${e.message}`)
    return []
  }
}

/**
 * 保存手写歌词（歌词编辑器的 POST）。
 *
 * 写 COS 的 `music/<hash>.lrc`（本地 dev 由 storage.js 落到 server/uploads），
 * 然后更新 kg_tracks.lyric_cached。返回 sidecar 文件名（如 `<hash>.lrc`）。
 */
export async function saveLyrics(filename, lrc) {
  const name = String(filename || '')
  const hash = hashOf(name)
  if (!hash) throw httpError('非法文件名')
  const text = String(lrc ?? '')
  if (text.length > MAX_LYRIC_BYTES) throw httpError('歌词过长')

  await putObject(lyricKey(name), Buffer.from(text, 'utf8'), mimeFor('lrc'))
  await db.run('UPDATE kg_tracks SET lyric_cached = 1 WHERE hash = ?', [hash])
  lyricCache.delete(hash) // 手写歌词立即生效
  return `${hash}.lrc`
}
