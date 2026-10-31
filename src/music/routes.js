/**
 * 音乐模块路由，挂在 /api/music（见 src/app.js）。
 *
 * 线上形态是「曲库 + 在线播放」：音频/封面/歌词都在 COS（公有读 + CDN），
 * 后端不再把音频下载到本地、也不再提供批量下载 —— 只负责三件事：
 *   1. 从库里读出曲目元数据，给每首签发 `<audio>` / `<img>` 能用的带签名地址；
 *   2. 把 /stream、/cover、/lyrics 变成「302 到 COS」或「回退上游」的薄壳；
 *   3. 酷狗的绑定 / 同步 / 解绑（管理员），以及老接口的**优雅降级**空实现。
 *
 * 响应统一走 `{ code, message, data }`（code 0 = 成功）—— 沿用 musicplayer 的 ok() 信封，
 * 前端 Music.vue 原本就读 `json.code === 0` / `json.data.items`，改造成本最低。
 *
 * 鉴权分层：
 *   tracks / lyrics / meta / status → requireAuth（与 /music 路由的 meta.auth 一致）
 *   kugou/*、download/* → requireAdmin（酷狗账号全站共用一份，
 *     放开给任意登录用户就等于谁都能覆盖别人的账号）
 *   stream / cover 另有 ?exp&sig 签名校验（<audio>/<img> 带不了 Authorization 头）
 */
import express from 'express'
import { ah } from '../middleware/async.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { rateLimit } from '../middleware/ratelimit.js'
import { db } from '../db.js'
import { config } from '../config.js'
import {
  signedUrl, requireMediaSig, isAudioName, isCoverName, hashOf,
  audioPublicUrl, objectExists,
} from './media.js'
import {
  getBinding, publicStatus, activeSession, saveBinding, clearBinding, ensureDfid,
} from './session.js'
import {
  qrKey, qrCreate, qrCheck, getSongUrl, isLoginRequired, isProxyDown, KugouError,
} from './kugou.js'
import { syncLiked, listPlaylists } from './sync.js'
import { getLyricsFor, saveLyrics, resolveCoverUrl, safeCoverUrl } from './assets.js'

const router = express.Router()

const ok = (data) => ({ code: 0, message: 'ok', data })
const bad = (message, code = 1) => ({ code, message, data: null })

/**
 * 302 到真正的媒体地址（COS/CDN 或上游）。
 *
 * 加一条**短**的私有缓存：<audio> 播一首歌期间可能为 seek 发好几次请求，
 * 让浏览器自己接住这几秒里的重定向，少打几次 Serverless 函数。
 * 跳转目标是公有读的 CDN 地址、本身不带有效期，缓存 5 分钟没有失效风险。
 */
function redirectTo(res, url, cacheSeconds = 300) {
  res.set('Cache-Control', `private, max-age=${cacheSeconds}`)
  return res.redirect(302, url)
}

// 媒体路由的限流。**必须传 scope**：路径里带动态文件名，按 req.path 计 key 时
// 每个文件各自一个桶，换一首歌即重置计数（详见 ratelimit.js 的说明）。
// 额度按浏览器的实际行为给：一首歌整曲播放期间请求是零星的（seek 才会连发几个），
// 300/分钟对正常收听绰绰有余，但足以挡住拿签名脚本狂拉上游。
// 刻意放在 requireMediaSig **之前** —— 无效签名也照样消耗配额，签名爆破同样被限住。
const streamLimit = rateLimit({ windowMs: 60_000, max: 300, scope: 'music:stream' })
const coverLimit = rateLimit({ windowMs: 60_000, max: 200, scope: 'music:cover' })
// 下载类接口已是空实现，限流只为挡住误连点，不是节流手段
const downloadLimit = rateLimit({ windowMs: 60_000, max: 30, scope: 'music:download' })

/** 同步是否正在进行（同实例内的防重入；Serverless 多实例下只能算尽力而为） */
let syncing = false

// ---------------------------------------------------------------- 曲目列表

/**
 * GET /api/music/tracks
 *
 * 一次性返回全部（不分页）：`<music-player>` 的 loadPlaylist 本来就不支持分页，
 * 而「我喜欢」的量级（几百到几千）整包下发完全够用。
 *
 * 每首都带 `playable`：
 *   线上一律在线播放，音频要么在 COS（cos_url 或按约定 music/<filename>），
 *   要么由后端 302 回源酷狗。所以**只按库里的 playable 判定**，
 *   不再有「本地有没有缓存」这一维（`cached` 字段保留但语义已变成「可在线播放」）。
 */
router.get(
  '/tracks',
  requireAuth,
  ah(async (req, res) => {
    const binding = await getBinding()
    const bound = !!binding?.token

    const rows = await db.all(
      `SELECT hash, name, artist, album, duration, filename, ext, cover_url, cos_url,
              size, playable, quality_used, cover_cached, lyric_cached
         FROM kg_tracks
        WHERE in_liked = 1
        ORDER BY ord, hash`,
      [],
    )

    const items = rows.map((r) => {
      const playable = Number(r.playable) === 1
      // 封面：库里标记过「已迁移」，或手上有**通过白名单的**酷狗封面地址，才发签名地址。
      // 过不了白名单的 URL（被污染/历史脏数据）一律不发，省得页面挂一块破图。
      const hasCover = Number(r.cover_cached) === 1 || !!safeCoverUrl(r.cover_url)
      const coverUrl = hasCover ? signedUrl(`${req.baseUrl}/cover`, r.filename, { scope: 'cover' }) : ''
      return {
        filename: r.filename, // 组件里唯一的身份标识
        hash: r.hash,
        title: r.name,
        artist: r.artist,
        album: r.album,
        duration: r.duration,
        url: playable ? signedUrl(`${req.baseUrl}/stream`, r.filename, { scope: 'stream' }) : '',
        coverUrl,
        // 酷狗 mp3 无内嵌 APIC（实测），封面只能走我们自己的封面代理，
        // 所以 hasCover 完全由 coverUrl 决定 —— 页面是 v-if="hasCover && coverUrl"。
        hasCover: !!coverUrl,
        hasLyrics: Number(r.lyric_cached) === 1,
        // 语义变更：线上没有本地缓存，「cached」= 可以在线播放
        cached: playable,
        cachedSize: Number(r.size) || 0,
        hasCos: !!String(r.cos_url || '').trim(),
        quality: r.quality_used || '',
        playable,
        restricted: !playable,
      }
    })

    res.json(ok({ items, total: items.length, hasMore: false, bound }))
  }),
)

// ---------------------------------------------------------------- 音频流

/**
 * GET /api/music/stream/:filename?exp&sig
 *
 * 只做「校验签名 → 302 到真正的音频」，不在函数里透传字节流
 * （Vercel 的函数无法承载一个持续几分钟的 Range 流，而且没必要：COS 就是 CDN）。
 *
 * 回退顺序：
 *   1. 库里的 kg_tracks.cos_url（迁移时写入的完整地址）—— 命中直接跳
 *   2. publicUrl('music/<filename>')（迁移约定），探测存在才跳
 *   3. 酷狗 /song/url 拿到的上游地址（需要 KuGouMusicApi 在线）
 *   4. 都没有 → 404 JSON
 *
 * ⚠️ 这里**不挂 requireAuth**：`<audio>` 无法携带 Authorization 头，
 * 鉴权完全靠签名。而签名只有登录用户调 /tracks 时才拿得到，所以「持有有效签名」
 * 已经等价于「通过过站点鉴权」。
 */
router.get(
  '/stream/:filename',
  streamLimit,
  requireMediaSig('stream'),
  ah(async (req, res) => {
    const filename = String(req.params.filename)
    if (!isAudioName(filename)) return res.status(400).json(bad('非法文件名'))

    const track = await db.get('SELECT * FROM kg_tracks WHERE filename = ?', [filename])
    if (!track) return res.status(404).json(bad('曲目不存在'))

    // 分支一：库里明确记了 COS 地址 —— 最可信，连探测都省了
    const stored = String(track.cos_url || '').trim()
    if (stored) return redirectTo(res, stored)

    // 分支二：按迁移约定回退 music/<filename>
    // 注意 objectExists 可能是 null（未知：本地 dev / 探测抖动 / CDN 不支持 HEAD），
    // 那种情况按乐观处理 —— 探测失败不该让本来能播的歌播不了。
    const fallback = audioPublicUrl(filename)
    if (fallback) {
      const exists = await objectExists(fallback)
      if (exists !== false) return redirectTo(res, fallback)
    }

    // 分支三：回源酷狗（未配置代理地址时直接按「没有资源」处理）
    if (!String(config.music.kugouApiBase || '').trim()) {
      return res.status(404).json(bad('该曲目暂无在线音频'))
    }

    let session
    try {
      session = await activeSession()
    } catch (e) {
      // activeSession 会在取 dfid 时连上游；代理没起来要按「服务不可用」告诉前端，
      // 而不是让它以为是自己登录态的问题（403）
      if (isProxyDown(e)) {
        return res.status(503).json({ code: 503, message: '酷狗服务未启动（KUGOU_API_BASE 不可达）', data: null })
      }
      return res.status(403).json(bad(e.message, 403))
    }

    let got
    try {
      got = await getSongUrl(
        { hash: track.hash_used || track.hash, albumId: track.album_id, albumAudioId: track.album_audio_id },
        track.quality_used || config.music.kugouQuality,
        session,
      )
    } catch (e) {
      // 明确区分「酷狗代理没起」和「这首歌播不了」，前端提示完全不同
      if (isProxyDown(e)) {
        return res.status(503).json({ code: 503, message: '酷狗服务未启动（KUGOU_API_BASE 不可达）', data: null })
      }
      if (isLoginRequired(e)) {
        return res.status(403).json({ code: 403, message: '酷狗登录态已失效，请重新扫码绑定', data: null })
      }
      throw e
    }

    if (!got.url) {
      // 学到「这首在酷狗确实拿不到」——落库，免得每次点都白跑一趟上游。
      // 只有 paywalled（确需付费）才落库；got.unavailable（status 3，无版权/下架）
      // 刻意**不**落库：版权是会更新的，留个持久标记反而让它永远回不来。
      if (got.paywalled) {
        await db.run('UPDATE kg_tracks SET playable = 0 WHERE hash = ?', [track.hash])
      }
      return res.status(404).json(bad(got.paywalled ? '该曲目在酷狗需会员或已下架' : '暂时无法获取播放地址', 404))
    }

    // 记下真正取到流用的 hash / 音质：下次回源直接沿用同一个源，避免「播的是 A、拿的是 B」
    await db.run('UPDATE kg_tracks SET hash_used = ?, quality_used = ? WHERE hash = ?', [
      track.hash_used || track.hash,
      got.quality,
      track.hash,
    ])

    return redirectTo(res, got.url)
  }),
)

// ---------------------------------------------------------------- 封面

/**
 * GET /api/music/cover/:filename?exp&sig
 *
 * 走签名而非 requireAuth：封面是 `<img src>`，带不了 Authorization 头。
 * 文件名沿用音频名 `<hash>.mp3`（`/tracks` 就是这么签的）；也容忍 `<hash>.jpg`
 * 这种直观点法 —— 两者都只用来推 hash，与实际对象的扩展名无关。
 *
 * 回退顺序（见 assets.resolveCoverUrl）：
 *   1. COS 上的 music/covers/<hash>.jpg（库标记 cover_cached，或探测到对象存在）
 *   2. 酷狗上游封面（**保留 *.kugou.com 白名单**，防 SSRF 与恶意跳转）
 *   3. 都没有 → 404 JSON
 */
router.get(
  '/cover/:filename',
  coverLimit,
  requireMediaSig('cover'),
  ah(async (req, res) => {
    const filename = String(req.params.filename)
    const hash = hashOf(filename)
    if (!hash || (!isAudioName(filename) && !isCoverName(filename))) {
      return res.status(400).json(bad('非法文件名'))
    }

    const track = await db.get('SELECT hash, cover_url, cover_cached FROM kg_tracks WHERE hash = ?', [hash])
    const url = await resolveCoverUrl(track || { hash })
    if (!url) return res.status(404).json(bad('暂无封面'))

    return redirectTo(res, url, 3600)
  }),
)

// ---------------------------------------------------------------- 歌词

/**
 * 歌词走 requireAuth 而非签名：`<music-player>` 的 fetchLyrics 用的是
 * `lyric-url` 模板 + `{filename}` 替换（dist/musicplayer.js:933），URL 在
 * 前端拼不出来带签名的版本，但**它会带 Authorization 头**（:934），所以走登录态即可。
 */
async function loadTrack(filename, res) {
  if (!isAudioName(filename)) {
    res.status(400).json(bad('非法文件名'))
    return null
  }
  const track = await db.get('SELECT * FROM kg_tracks WHERE filename = ?', [filename])
  if (!track) {
    res.status(404).json(bad('曲目不存在'))
    return null
  }
  return track
}

router.get(
  '/lyrics/:filename',
  requireAuth,
  ah(async (req, res) => {
    const track = await loadTrack(String(req.params.filename), res)
    if (!track) return
    // 必须是**已解析的数组**，给 LRC 原文会被组件静默吞成「暂无歌词」
    res.json(ok({ lyrics: await getLyricsFor(track) }))
  }),
)

router.post(
  '/lyrics/:filename',
  requireAuth,
  ah(async (req, res) => {
    const track = await loadTrack(String(req.params.filename), res)
    if (!track) return
    // 写 COS 的 music/<hash>.lrc（不再落本地磁盘）
    const filename = await saveLyrics(track.filename, req.body?.lrc ?? '')
    res.json(ok({ filename }))
  }),
)

// ---------------------------------------------------------------- 英雄区统计

/** 原来指向 musicplayer 的 /m/api/v1/meta（统计的是 jays 目录），改指向酷狗曲库 */
router.get(
  '/meta',
  requireAuth,
  ah(async (req, res) => {
    const rows = await db.all(
      'SELECT ext, COUNT(*) AS c FROM kg_tracks WHERE in_liked = 1 GROUP BY ext',
      [],
    )
    const songCount = rows.reduce((s, r) => s + Number(r.c), 0)
    const formats = rows
      .map((r) => String(r.ext || '').toUpperCase())
      .filter(Boolean)
      .join(' · ')
    const binding = await getBinding()
    const bound = !!binding?.token
    res.json(
      ok({
        songCount,
        formats: formats || (bound ? '同步中' : '未绑定酷狗'),
        bound,
      }),
    )
  }),
)

// ---------------------------------------------------------------- 酷狗绑定与同步
//
// ⚠️ 这一整段必须挂 requireAdmin。酷狗账号是**全站共用一份**：
// 放开给任意登录用户，等于谁都能把大家共用的账号换成自己的、或反复触发全量同步。
// 只读的 /status 例外（在下方，requireAuth）。

/** 扫码第一步：拿 key + 二维码图（实测 /login/qr/key 一次就返回完整的 data:image/png 的 base64） */
router.get(
  '/kugou/qr',
  requireAdmin,
  ah(async (req, res) => {
    const { key, qrImage } = await qrKey()
    let img = qrImage
    if (!img) img = await qrCreate(key) // 兜底：万一该版本不返回图
    res.json(ok({ key, qrImage: img }))
  }),
)

/**
 * 扫码第三步：轮询状态。0 过期 / 1 待扫 / 2 待确认 / 4 成功。
 *
 * ⚠️ 必须每轮带不同的 timestamp 绕开服务端 2 分钟缓存，否则状态永远不动
 * （kugou.js 的 `fresh: true` 负责这件事）。
 */
router.get(
  '/kugou/qr/check',
  requireAdmin,
  ah(async (req, res) => {
    const key = String(req.query.key || '')
    if (!key) return res.status(400).json(bad('缺少 key'))

    const r = await qrCheck(key)
    if (r.status === 4 && r.token) {
      await saveBinding({ token: r.token, userid: r.userid, nickname: r.nickname })
      // dfid 与登录态无关，但登录后重新取一次更稳妥
      await ensureDfid(true).catch(() => {})
    }
    // 成功时也**不回传 token**
    res.json(ok({ status: r.status, bound: r.status === 4, nickname: r.nickname || '' }))
  }),
)

/** 当前酷狗账号下的歌单列表（手动指定「我喜欢」时用） */
router.get(
  '/kugou/playlists',
  requireAdmin,
  ah(async (req, res) => {
    const session = await activeSession({ require: true })
    res.json(ok({ items: await listPlaylists(session) }))
  }),
)

/** 同步「我喜欢」元数据。可带 ?playlistId= 手动指定歌单。 */
router.post(
  '/kugou/sync',
  requireAdmin,
  ah(async (req, res) => {
    // 同实例内防重入：一次全量同步要打几十次上游，双击按钮不该触发两轮。
    // 用 423 而不是 409 —— 前端把 409 专门留给「认不出我喜欢，请手选歌单」。
    if (syncing) return res.status(423).json(bad('正在同步歌单，请稍候', 423))
    const playlistId = String(req.body?.playlistId || req.query.playlistId || '')
    syncing = true
    try {
      const result = await syncLiked({ playlistId })
      res.json(ok(result))
    } finally {
      syncing = false
    }
  }),
)

/** 解绑：清掉共用会话（**不动 COS 里的音频**，未绑定时它们仍可正常播放） */
router.post(
  '/kugou/unbind',
  requireAdmin,
  ah(async (req, res) => {
    await clearBinding()
    res.json(ok({ bound: false }))
  }),
)

// ---------------------------------------------------------------- 下载（优雅降级）
//
// 线上（Vercel）没有持久磁盘、函数最长 30 秒，无法再把整张歌单拉到本地。
// 这几个接口**保留形状、返回空实现**，只是为了让旧前端不报错、不卡在「下载中」。
// 新前端应当自己隐藏「下载全部」按钮（或据 reason='unsupported' 提示）。

const DOWNLOAD_UNSUPPORTED_MESSAGE = '线上版不支持离线批量下载'

/** 老前端会读这些字段做收尾（done/total/failed/cancelled/abortReason），一律给零值 */
const idleProgress = () => ({ active: false, total: 0, done: 0, failed: 0, cancelled: false, abortReason: '' })

router.post(
  '/download',
  requireAdmin,
  downloadLimit,
  (req, res) => {
    res.json(
      ok({
        started: false,
        reason: 'unsupported',
        message: DOWNLOAD_UNSUPPORTED_MESSAGE,
        ...idleProgress(),
      }),
    )
  },
)

router.post(
  '/download/cancel',
  requireAdmin,
  downloadLimit,
  (req, res) => {
    res.json(ok({ ...idleProgress(), message: DOWNLOAD_UNSUPPORTED_MESSAGE }))
  },
)

/**
 * 批量下载进度。**永远 200**（空闲时 `active:false`）：前端按 1.5s 轮询它，
 * 任何 4xx/5xx 都会被当成「网络异常」而让收尾逻辑失灵。
 */
router.get('/download/progress', requireAdmin, (req, res) => {
  res.json(ok(idleProgress()))
})

// ---------------------------------------------------------------- 绑定状态

/**
 * 只回昵称与计数，**绝不回 token**（见 session.js publicStatus 的说明）。
 *
 * `cachedCount` 保留旧字段名，但线上没有本地缓存 —— 语义已变成「可在线播放的曲目数」；
 * 另给 `cosCount`（库里显式记了 cos_url 的条数）方便观察迁移进度。
 */
router.get(
  '/status',
  requireAuth,
  ah(async (req, res) => {
    const status = await publicStatus()
    // cosCount 用 SQL 数；coverCount 必须和 /tracks 的 hasCover 口径一致（含白名单校验），
    // 所以拉两列回 JS 里判 —— 几千行两列，比在 SQL 里拼 hostname 白名单干净得多。
    const counts = await db.get(
      "SELECT SUM(CASE WHEN cos_url <> '' THEN 1 ELSE 0 END) AS cos_count FROM kg_tracks WHERE in_liked = 1",
      [],
    )
    const coverRows = await db.all('SELECT cover_cached, cover_url FROM kg_tracks WHERE in_liked = 1', [])
    const coverCount = coverRows.filter((r) => Number(r.cover_cached) === 1 || !!safeCoverUrl(r.cover_url)).length

    res.json(
      ok({
        ...status,
        cachedCount: status.playableCount,
        coverCount,
        cosCount: Number(counts?.cos_count) || 0,
        // 保持旧形状：老前端会 spread 这两个下载队列计数
        running: 0,
        queued: 0,
      }),
    )
  }),
)

// ---------------------------------------------------------------- 错误映射

/**
 * 挂在 router 上的错误出口（Express 4 不捕获 async reject，所以上面每个 handler
 * 都过了一遍 `ah`）。把领域错误翻译成前端能分辨的状态码，而不是一律 500：
 *   503 酷狗代理进程没起来   → 前端横幅「酷狗服务未启动」
 *   403 登录态失效 / 未绑定  → 前端引导重新扫码
 *   409 认不出「我喜欢」     → 前端弹歌单选择
 */
router.use((err, req, res, next) => {
  if (err?.code === 'KG_NEED_CHOICE') {
    return res.status(409).json({
      code: 409,
      message: err.message,
      data: { candidates: err.candidates || [] },
    })
  }
  if (err?.code === 'KG_UNBOUND') return res.status(403).json(bad(err.message, 403))
  if (isProxyDown(err)) {
    return res.status(503).json({ code: 503, message: '酷狗服务未启动（KUGOU_API_BASE 不可达）', data: null })
  }
  if (isLoginRequired(err)) {
    return res.status(403).json({ code: 403, message: '酷狗登录态已失效，请重新扫码绑定', data: null })
  }
  if (err instanceof KugouError) {
    // 上游返回了内容但语义是错误（如 error_code 非 0）——502 表示"上游不配合"，不是本站的锅
    return res.status(502).json({ code: 502, message: `酷狗接口异常：${err.message}`, data: null })
  }
  next(err)
})

export default router
