/**
 * KuGouMusicApi 客户端。
 *
 * 请求封装移植自 E:\mic\src\api\client.js，归一化在 ./normalize.js。
 * 那边的每一条约定都来自对真实接口的实测（E:\mic\docs\api-fields.md），不是照搬文档。
 *
 * 与浏览器版的差异：没有 localStorage，登录态由调用方以 `session` 对象显式传入
 * （{ token, userid, dfid }），取自 SQLite 的 kg_session 单例行。
 */
import { config } from '../config.js'
import { normalizeSongs, normalizePlaylists, parseLrc, extractLyricText, pick } from './normalize.js'

/** KuGouMusicApi 基址。刻意用函数读，方便测试时改 config。 */
const base = () => {
  const raw = String(config.music.kugouApiBase || '').trim().replace(/\/+$/, '')
  if (!raw) return ''
  // 允许只填主机名（kgapi.example.com）：缺协议时 new URL() 会直接抛 Invalid URL。
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
}

export class KugouError extends Error {
  constructor(message, { code, httpStatus, body } = {}) {
    super(message)
    this.name = 'KugouError'
    this.code = code
    this.httpStatus = httpStatus
    this.body = body
  }
}

/**
 * 需要登录的接口在未登录时会返回这些错误码。
 *
 * 实测（对着 3100 逐个 curl 出来的）：
 *   token **为空/缺失** → 20010      如 `cookie=userid=0;token=`
 *   token 非空但无效     → 20017      如 `cookie=userid=0;token=x`
 *   152    = /search 系列未登录
 *   20018  = /user/detail 等
 *   20006  = 签名错误（/search/suggest 恒返回）
 *
 * ⚠️ 20010 同时也是通用「Bad Request」（例如 /lyric 直接传 hash 就报 20010），
 * 语义不唯一。这里按「鉴权失败」处理，是因为本项目只在 /user/playlist、/user/detail
 * 这类必须登录的接口上会撞到它，落到别的场景最多是错误文案不够精确，不会误判成成功。
 */
export const NEEDS_LOGIN_CODES = new Set([152, 20006, 20010, 20017, 20018])

export const isLoginRequired = (err) => err instanceof KugouError && NEEDS_LOGIN_CODES.has(err.code)

/** 代理服务没起来（ECONNREFUSED / 超时）——前端要能明确区分这种情况 */
export const isProxyDown = (err) =>
  err instanceof KugouError && (err.httpStatus === 0 || /超时|ECONNREFUSED|fetch failed/i.test(err.message))

/**
 * 组装 cookie 串。
 *
 * ⚠️ 服务端 util/util.js 的 cookieToJson 是 `split(';')` 后 `split('=')`，**不做 trim**。
 * 所以分隔符必须用 `;` 且**后面不能有空格** —— 否则会解析出带前导空格的键名
 * （如 `" userid"`），鉴权静默失效。
 */
export function buildCookie(session) {
  const { token, userid, dfid } = session || {}
  const parts = []
  if (token) parts.push(`token=${token}`)
  if (userid) parts.push(`userid=${userid}`)
  if (dfid) parts.push(`dfid=${dfid}`)
  return parts.join(';')
}

/** 服务端可能返回 `<!--...-->` 包裹的 JSON（实测 /search/complex），解析前剥离 */
function parseBody(text) {
  const cleaned = String(text).replace(/<!--[\s\S]*?-->/g, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    throw new KugouError('KUGOU_API_BASE 返回的不是合法 JSON（服务地址配错了？）', {
      body: cleaned.slice(0, 300),
    })
  }
}

/**
 * 发起一次接口调用。
 *
 * @param {string} path  形如 '/song/url'
 * @param {object} opts
 * @param {object}  [opts.params]  查询参数
 * @param {boolean} [opts.fresh]   附加变化的 timestamp 绕开服务端 2 分钟缓存（轮询接口必用）
 * @param {object}  [opts.session] 登录态 { token, userid, dfid }
 * @param {number}  [opts.timeout] 超时毫秒，默认 15s
 */
export async function request(path, { params = {}, fresh = false, session = null, timeout = 15000 } = {}) {
  const finalParams = { ...params }
  if (fresh) finalParams.timestamp = Date.now()

  const cookie = buildCookie(session)
  if (cookie) finalParams.cookie = cookie

  const root = base()
  if (!root) {
    throw new KugouError('KUGOU_API_BASE 未配置（形如 https://kgapi.example.com）', { httpStatus: 0 })
  }

  const url = new URL(root + path)
  for (const [k, v] of Object.entries(finalParams)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
  }

  const headers = {}
  // Authorization 与服务端注入的 cookie 是**合并**关系（不会像 body.cookie 那样覆盖），
  // 多带一条通道，兼容只认 header 的模块。
  if (session?.token) {
    headers.Authorization = [`token=${session.token}`, session.userid && `userid=${session.userid}`]
      .filter(Boolean)
      .join(';')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  let res
  try {
    res = await fetch(url, { headers, signal: controller.signal })
  } catch (e) {
    clearTimeout(timer)
    if (e.name === 'AbortError') {
      throw new KugouError(`请求 KuGouMusicApi 超时：${base()}（服务没起来或未在 ${base()} 监听）`, {
        httpStatus: 0,
      })
    }
    throw new KugouError(`无法连接 KuGouMusicApi：${base()}（${e.message}）`, {
      httpStatus: 0,
      body: e.message,
    })
  }
  clearTimeout(timer)

  const text = await res.text()
  const json = parseBody(text)

  // ⚠️ 错误判定必须同时看 HTTP 状态与响应体：
  //    - 搜索未登录返回 HTTP 502 + error_code 152
  //    - /user/playlist 未登录返回 HTTP 502 + error_code 20017（实测）
  //    - 音质不可用返回 HTTP 200 + status 2（"软失败"，由调用方判断，这里**不能**当成错误）
  const code = json?.error_code ?? json?.errcode
  const badCode = code !== undefined && code !== 0 && code !== 200

  if (!res.ok || json?.status === 0 || badCode) {
    throw new KugouError(json?.error_msg || json?.errmsg || json?.msg || `接口返回异常(${res.status})`, {
      code,
      httpStatus: res.status,
      body: json,
    })
  }

  return json
}

// ---------------------------------------------------------------- 基础

/** 匿名即可获取 dfid；/song/url 不带它会报「本次请求需要验证」 */
export async function getDfid() {
  const res = await request('/register/dev', { fresh: true })
  const dfid = pick(res, ['data.dfid'])
  if (!dfid) throw new KugouError('未能从 /register/dev 取到 dfid')
  return String(dfid)
}

// ---------------------------------------------------------------- 播放地址

/** 音质候选，从高到低 */
export const QUALITIES = ['flac', '320', '128']

/**
 * 取播放地址。
 *
 * 实测要点：
 * - 响应是**扁平结构**（没有 data 外层），`url` 是**数组**（多 CDN），失败回退 backupUrl
 * - 付费/受限返回 `{status: 2, fail_process: ["pkg","buy"]}`，**HTTP 仍是 200**
 * - 无版权/已下架返回 `{status: 3}`（没有 fail_process），同样是 HTTP 200
 * - 只**向下**降级：实测限制是单调的（匿名 128 可用、320 与 flac 一律 status 2），
 *   128 失败时再试更高档必然也失败，往上是纯浪费请求
 * - 歌单列表接口**不返回 hash_320 / hash_flac**（实测），所以各档位只能用同一个 hash，
 *   真正决定档位的是 `quality` 参数
 *
 * @param {{hash:string, albumId?:string, albumAudioId?:string}} song
 * @returns {{url:string, backupUrl:string, quality:string, paywalled:boolean,
 *            unavailable:boolean, reason:''|'restricted'|'unavailable'|'empty'}}
 *            `paywalled` 与 `unavailable` 都意味着「取不到地址」，但语义不同：
 *            前者要标 playable=0 永久跳过，后者只是这次没有，**不该**留下持久标记。
 */
export async function getSongUrl(song, quality = '128', session = null) {
  const hash = song?.hash
  const attempt = async (q) => {
    if (!hash) return { url: '', quality: q, paywalled: false, reason: 'no-hash' }

    let res
    try {
      res = await request('/song/url', {
        params: {
          hash,
          album_id: song.albumId || undefined,
          album_audio_id: song.albumAudioId || undefined,
          quality: q,
        },
        fresh: true,
        session,
      })
    } catch (e) {
      // 实测 20028「本次请求需要验证」在 dfid 缺失/失效时出现（HTTP 200，body status 2），
      // 它被判定逻辑当成错误抛出，这里还原成「受限」而非「网络故障」。
      if (e.code === 20028 || e.body?.status === 2) {
        return { url: '', quality: q, paywalled: true, reason: 'restricted' }
      }
      throw e
    }

    const url = Array.isArray(res?.url) ? res.url[0] : res?.url
    const backup = Array.isArray(res?.backupUrl) ? res.backupUrl[0] : res?.backupUrl
    if (url || backup) {
      return { url: url || backup, backupUrl: backup || '', quality: q, paywalled: false, reason: '' }
    }
    // status 2 = 需付费/购买；status 3 = 该曲目没有可用资源（版权下架，DJ 版/翻唱版尤其常见）。
    // 两者都是**上游明确答复的内容问题**，但处理方式不同：
    //   - 2 是「要花钱」，标 playable = 0 不再重试（既有行为）
    //   - 3 是「本来就没有」，**不能**标 playable = 0（版权随时可能恢复），
    //     也**不能**算进批量任务的取地址连败计数 —— 否则歌单里成片的无版权曲目
    //     会被当成「酷狗服务没起来」，整批白停。实测 6 首里就有 3 首是这种。
    // 只有 status 1（或压根没有 status 字段）却仍然没有 url 时，才是真正可疑的
    // 「上游没答复清楚」，那一种才计 'empty'。
    const st = Number(res?.status)
    return {
      url: '',
      backupUrl: '',
      quality: q,
      paywalled: st === 2,
      unavailable: st === 3,
      reason: st === 2 ? 'restricted' : st === 3 ? 'unavailable' : 'empty',
    }
  }

  const start = QUALITIES.indexOf(String(quality))
  const chain = start === -1 ? QUALITIES : QUALITIES.slice(start)

  let paywalled = false
  let unavailable = false
  for (const q of chain) {
    try {
      const r = await attempt(q)
      if (r.url) return r
      if (r.paywalled) paywalled = true
      if (r.unavailable) unavailable = true
    } catch {
      // 该档请求本身失败（网络/超时），继续降级
    }
  }
  return {
    url: '',
    backupUrl: '',
    quality,
    paywalled,
    unavailable,
    reason: paywalled ? 'restricted' : unavailable ? 'unavailable' : 'empty',
  }
}

// ---------------------------------------------------------------- 歌词

/** /search/lyric → candidates[0]，拿 id + accesskey */
export async function searchLyric(keywords, hash) {
  const res = await request('/search/lyric', { params: { keywords, hash }, fresh: true })
  return res?.candidates?.[0] ?? null
}

/**
 * 取歌词。
 * 实测 /lyric?fmt=lrc&decode=true 的 `decodeContent` 就是明文 LRC。
 * ⚠️ /lyric **不能直接传 hash**（报 400/20010），必须先 /search/lyric 换 id + accesskey。
 */
export async function getLyric(song) {
  const keywords = `${song.singerText || song.artist || ''} - ${song.name || song.title || ''}`.trim()
  const candidate = await searchLyric(keywords, song.hash)
  if (!candidate?.id || !candidate?.accesskey) return { text: '', lines: [] }

  const res = await request('/lyric', {
    params: { id: candidate.id, accesskey: candidate.accesskey, fmt: 'lrc', decode: 'true' },
    fresh: true,
  })
  const text = extractLyricText(res)
  return { text, lines: parseLrc(text) }
}

// ---------------------------------------------------------------- 歌单

/**
 * 我的歌单（分页拉全）。
 *
 * ⚠️ 该接口**必须登录**，开发期拿不到 token，字段名走多候选兜底。
 * 若用户绑定的账号返回结构与此不同，改这里的候选列表即可。
 */
export async function getUserPlaylists(session, { pagesize = 100, maxPages = 20 } = {}) {
  const seen = new Set()
  const all = []
  let total = 0

  for (let page = 1; page <= maxPages; page++) {
    const res = await request('/user/playlist', {
      params: { page, pagesize, type: 2, total_ver: 979 },
      fresh: true,
      session,
    })

    const raw =
      pick(res, ['data.info', 'data.list', 'data.playlist', 'data.special_list']) ??
      (Array.isArray(res?.data) ? res.data : [])

    total = Number(pick(res, ['data.total', 'data.count']) ?? total) || total
    if (!Array.isArray(raw) || raw.length === 0) break

    let added = 0
    for (const p of normalizePlaylists(raw)) {
      if (!p.id || seen.has(p.id)) continue
      seen.add(p.id)
      all.push(p)
      added++
    }

    // 终止条件见 getPlaylistTracks 的说明
    if (total && all.length >= total) break
    if (added === 0) break
  }

  return { list: all, total: total || all.length }
}

/**
 * 歌单里全部曲目（分页拉全）。
 *
 * 实测响应：`data.songs[]`（元素见 normalize.js 形态 C）+ `data.count`（总数）。
 * 该接口**无需登录**。
 */
export async function getPlaylistTracks(playlistId, session = null, { pagesize = 30, maxPages = 60 } = {}) {
  const seen = new Set()
  const all = []
  let count = 0

  for (let page = 1; page <= maxPages; page++) {
    const res = await request('/playlist/track/all', {
      params: { id: playlistId, page, pagesize },
      fresh: true,
      session,
    })

    const songs = pick(res, ['data.songs', 'data.info', 'data.list'])
    count = Number(pick(res, ['data.count', 'data.total']) ?? count) || count
    if (!Array.isArray(songs) || songs.length === 0) break

    let added = 0
    for (const s of normalizeSongs(songs)) {
      if (seen.has(s.hash)) continue
      seen.add(s.hash)
      all.push(s)
      added++
    }

    // 终止以「本页无新增」为主，而不是「本页不足 pagesize」——
    // 上游会悄悄截断 pagesize（实测要 300 只给回 36），那种情况下比长度会**提前中断**。
    // 另外：`count` 是原始条目数，含广告位占位（实测键只有 fileid/shield，没有 name），
    // 归一化会把它们滤掉，所以 all.length 可能永远追不上 count，不能只靠它收尾。
    if (count && all.length >= count) break
    if (added === 0) break
  }

  return { list: all, total: count || all.length }
}

// ---------------------------------------------------------------- 扫码登录

/**
 * 三步中的第一步。
 * 实测：key 在 **`data.qrcode`**（不是 `data.key`），
 * 而且同一响应里 **`data.qrcode_img` 就是完整的 `data:image/png;base64,...`**，
 * 所以一次调用即可拿到 key + 二维码图，无需再调 /login/qr/create。
 */
export async function qrKey() {
  const res = await request('/login/qr/key', { fresh: true })
  const key = pick(res, ['data.qrcode', 'data.key'])
  if (!key) throw new KugouError('未能从 /login/qr/key 取到 key')
  const img = pick(res, ['data.qrcode_img', 'data.base64']) || ''
  return { key: String(key), qrImage: String(img) }
}

/** 备用：用 key 生成二维码图（当 /login/qr/key 没带图时） */
export async function qrCreate(key) {
  const res = await request('/login/qr/create', { params: { key, qrimg: 1 }, fresh: true })
  return String(pick(res, ['data.base64']) || '')
}

/**
 * 第三步：轮询扫码状态。
 * 实测 `data.status` 是**数字**：0 过期 / 1 待扫 / 2 待确认 / 4 成功。
 * ⚠️ 必须每轮带不同的 timestamp（这里靠 fresh），否则命中服务端 2 分钟缓存、状态永不更新。
 */
export async function qrCheck(key) {
  const res = await request('/login/qr/check', { params: { key }, fresh: true })
  const d = res?.data || {}
  return {
    status: Number(d.status ?? -1),
    token: d.token ? String(d.token) : '',
    userid: d.userid ? String(d.userid) : '',
    nickname: d.nickname ? String(d.nickname) : '',
  }
}

/** 刷新 token。TTL 仓库无常量，实测未确证——失败不致命，调用方忽略即可。 */
export async function refreshToken(session) {
  const res = await request('/login/token', {
    params: { token: session?.token, userid: session?.userid },
    fresh: true,
    session,
  })
  return {
    token: String(pick(res, ['data.token']) ?? ''),
    userid: String(pick(res, ['data.userid']) ?? ''),
  }
}
