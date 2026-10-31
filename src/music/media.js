/**
 * 媒体基础设施：文件名白名单 / 对象存储地址约定 / HMAC 签名 / 对象存在性探测。
 *
 * 线上（Vercel）没有持久磁盘：音频、封面、歌词全部放腾讯云 COS（公有读 + CDN），
 * 本模块只负责「把曲目映射成可直接访问的公开地址」和「给 <audio>/<img> 签发带签名的短链」，
 * 不再有任何本地文件读写 —— 原先的「stat 判定缓存 + Range 直出 + 目录解析」已随本地下载链路一起删除。
 *
 * 桶内 key 约定（迁移脚本按这个写，这里按这个读）：
 *   音频  music/<filename>            形如 music/<32位hash>.mp3
 *   封面  music/covers/<hash>.jpg     ⚠️ 注意是 .jpg，不是 .mp3
 *   歌词  music/<hash>.lrc
 *
 * 文件名仍是 `<32 位小写 hash>.<ext>`：纯 ASCII、长度固定、由 hash 天然去重、跨机器可复现；
 * 展示用的 title/artist/album 只存 DB，不参与命名 —— 彻底绕开中文 / `/` / `?` / 超长 / 重名。
 *
 * ⚠️ 这是**唯一**的文件名入口校验。所有来自 URL 的名字都必须先过这里，
 * 且 hash 统一小写（Windows 大小写不敏感、Linux 敏感，不统一会出现同一首歌两份对象）。
 */
import crypto from 'node:crypto'
import { config } from '../config.js'
import { buildKey, publicUrl } from '../storage.js'

// ---------------------------------------------------------------- 文件名

const AUDIO_NAME_RE = /^[0-9a-f]{32}\.(mp3|flac|m4a|aac|ogg|wav|wma)$/
const COVER_NAME_RE = /^[0-9a-f]{32}\.jpg$/

export const isAudioName = (name) => AUDIO_NAME_RE.test(String(name || ''))
export const isCoverName = (name) => COVER_NAME_RE.test(String(name || ''))

/** hash 部分（不含扩展名）；非法返回 '' */
export const hashOf = (name) => {
  const s = String(name || '')
  return isAudioName(s) || isCoverName(s) ? s.slice(0, 32) : ''
}

const MIME = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  wma: 'audio/x-ms-wma',
  jpg: 'image/jpeg',
  png: 'image/png',
  lrc: 'text/plain; charset=utf-8',
}

export const mimeFor = (ext) => MIME[String(ext || '').replace(/^\./, '').toLowerCase()] || 'application/octet-stream'

/**
 * 音质档位 → 容器扩展名。
 *
 * 刻意**由配置推导**而不是取上游的 `extname`：文件名一旦定下就固化在 kg_tracks 里，
 * 换档位（128→flac）时名字不会中途变化，正在播的页面不会突然 404。
 */
export const extForQuality = (quality) => (String(quality) === 'flac' ? 'flac' : 'mp3')

// ---------------------------------------------------------------- COS 地址

/** 桶内 key：音频 `music/<filename>` */
export const audioKey = (filename) => buildKey('music', String(filename || ''))
/** 桶内 key：封面 `music/covers/<hash>.jpg` */
export const coverKey = (hash) => buildKey('music', `covers/${String(hash || '')}.jpg`)
/** 桶内 key：歌词 `music/<hash>.lrc` */
export const lyricKey = (filename) => buildKey('music', `${hashOf(filename)}.lrc`)

/** 公开（CDN）地址。本地 dev（driver=local）会映射成 /uploads/<key> */
export const audioPublicUrl = (filename) => publicUrl(audioKey(filename))
export const coverPublicUrl = (hash) => publicUrl(coverKey(hash))
export const lyricPublicUrl = (filename) => publicUrl(lyricKey(filename))

// 曲目「可播地址」的完整规则（优先 kg_tracks.cos_url，为空回退 audioPublicUrl）在
// routes.js 的 /stream 里实现 —— 那里还要额外探测对象是否存在再决定是否回源上游，
// 单独再抽一个不探测的版本只会让两处规则悄悄漂移。

// ---------------------------------------------------------------- 存在性探测

/**
 * 探测一个对象是否真的存在（HEAD）。
 *
 * 为什么需要探测：迁移脚本只往桶里写对象，不回填数据库列，所以「已迁移」不可从库里判断；
 * 而 302 到一个不存在的 CDN 对象会让 <audio>/<img> 直接 404，前端无从察觉、也没法回退。
 * 探测一次换来的是一次可靠的「COS 没有 → 回退上游」决策。
 *
 * @returns {Promise<true|false|null>} null = 未知（相对地址 / 网络抖动 / HEAD 不被支持），
 *          调用方应当按「乐观」分支处理：不要因为探测抖动就让明明有资源的歌播不了。
 *
 * 缓存：命中缓存 10 分钟；未命中只缓存 30 秒 —— 迁移可能正在进行，负缓存太久会把
 * 「刚传完的歌」一直判成缺失。缓存是**进程内**的，Serverless 冷启动后重来，语义无副作用。
 */
const EXISTS_HIT_MS = 10 * 60 * 1000
const EXISTS_MISS_MS = 30 * 1000
const EXISTS_MAX = 2000
const existsCache = new Map()

export async function objectExists(url, { timeout = 2500 } = {}) {
  const target = String(url || '')
  // 只有绝对地址才探测得到；本地 dev 的 /uploads/... 交给调用方乐观处理
  if (!/^https?:\/\//i.test(target)) return null

  const now = Date.now()
  const hit = existsCache.get(target)
  if (hit) {
    const ttl = hit.exists ? EXISTS_HIT_MS : EXISTS_MISS_MS
    if (now - hit.at < ttl) return hit.exists
    existsCache.delete(target)
  }

  const remember = (exists) => {
    if (existsCache.size >= EXISTS_MAX) existsCache.clear()
    existsCache.set(target, { at: Date.now(), exists })
    return exists
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    let res = await fetch(target, { method: 'HEAD', signal: controller.signal, redirect: 'follow' })
    // 个别 CDN/WAF 不放行 HEAD（405/501）：退回「只取一个字节」的 GET
    if (res.status === 405 || res.status === 501) {
      try {
        await res.body?.cancel()
      } catch {
        /* 忽略 */
      }
      res = await fetch(target, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        signal: controller.signal,
        redirect: 'follow',
      })
    }
    try {
      await res.body?.cancel()
    } catch {
      /* 忽略 */
    }
    if (res.ok || res.status === 206) return remember(true)
    if (res.status === 403 || res.status === 404 || res.status === 410) return remember(false)
    // 5xx / 奇怪的网关错误：真伪不明，别据此把歌判死
    return null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------- 签名

/**
 * `<audio>` 与 `<img>` **无法携带 Authorization 头**，所以这两条路径的鉴权
 * 只能走查询参数签名。TTL 给 12 小时：页面长驻看一晚上也不会中途断流。
 */
export const MEDIA_TTL_MS = 12 * 60 * 60 * 1000

/**
 * `scope` 必须参与签名：否则同一首歌的 stream 与 cover 会签出**完全相同**的 sig
 * （二者都只签 `name:exp`），封面 url 被 Referer 或日志泄漏后就等于泄漏了音频链接。
 * 加上资源种类后两者互不可用。scope 取值见 SCOPES。
 */
export const SCOPES = { stream: 'stream', cover: 'cover', lyrics: 'lyrics' }

function hmac(scope, name, exp) {
  return crypto
    .createHmac('sha256', config.jwtSecret)
    .update(`${scope}:${name}:${exp}`)
    .digest('base64url')
}

/**
 * 生成 `{ exp, sig }`。base64url 天然 URL 安全 —— 这一点很重要，
 * 因为 `<music-player>` 的 `songSrc()` 是 `return song.url` **原样**赋给 `<audio>.src`，
 * 不做任何编码，签名里只要出现 `+` `/` `=` 就可能被解码坏掉。
 */
export function signQuery(name, { scope = 'stream', ttlMs = MEDIA_TTL_MS } = {}) {
  const exp = Date.now() + ttlMs
  return { exp, sig: hmac(scope, name, exp) }
}

/** 拼一个带签名的相对 URL，如 `/api/music/stream/ab12….mp3?exp=…&sig=…` */
export function signedUrl(prefix, name, { scope = 'stream', ttlMs = MEDIA_TTL_MS } = {}) {
  const { exp, sig } = signQuery(name, { scope, ttlMs })
  return `${prefix}/${name}?exp=${exp}&sig=${sig}`
}

/** 校验签名（含 TTL）。名字非法、过期、签名不符一律 false。 */
export function verifyMedia(name, exp, sig, scope = 'stream') {
  if (!isAudioName(name) && !isCoverName(name)) return false
  const e = Number(exp)
  if (!Number.isFinite(e) || e <= 0) return false
  if (Date.now() > e) return false
  const expected = hmac(scope, name, e)
  const a = Buffer.from(String(sig || ''))
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/**
 * Express 中间件：校验 ?exp&sig，失败 403。
 * 用法 `router.get('/stream/:filename', requireMediaSig('stream'), ...)`。
 */
export function requireMediaSig(scope) {
  return (req, res, next) => {
    const name = String(req.params.filename || '')
    if (!verifyMedia(name, req.query.exp, req.query.sig, scope)) {
      // 403 而非 401：这里没有「登录就能过」的说法，链接本身失效了，刷新页面重签才有效
      return res.status(403).json({ code: 403, message: '媒体链接无效或已过期，请刷新页面', data: null })
    }
    next()
  }
}
