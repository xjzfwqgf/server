/**
 * 同步酷狗「我喜欢」歌单的**元数据**。
 *
 * 线上一律在线播放（音频在 COS），所以同步**只写库**（kg_tracks），不碰任何文件。
 * 全量替换式同步：每次把「我喜欢」的当前曲目整份落进 kg_tracks，
 * 上次在、这次不在的置 in_liked=0（**不删行、不删 COS 对象** —— 版权/歌单变动是常态，
 * 删了下次再同步回来就没有历史状态了）。
 */
import { db } from '../db.js'
import { config } from '../config.js'
import { extForQuality } from './media.js'
import { getUserPlaylists, getPlaylistTracks } from './kugou.js'
import { activeSession, getBinding, saveLikedPlaylist, markSynced } from './session.js'

/** 名称归一：去空白 + 繁体「我喜歡」折成简体，兼容两种写法 */
const normName = (s) => String(s || '').replace(/\s+/g, '').replace(/我喜歡/g, '我喜欢')

/** 同步过程中需要用户介入的错误（前端据此弹出歌单选择） */
export class SyncChoiceError extends Error {
  constructor(message, candidates) {
    super(message)
    this.name = 'SyncChoiceError'
    this.code = 'KG_NEED_CHOICE'
    this.status = 409
    this.candidates = candidates
  }
}

export async function listPlaylists(session) {
  const { list } = await getUserPlaylists(session)
  return list
}

/**
 * 从歌单列表里认定「我喜欢」。
 *
 * ⚠️ 没有真实 token 时无法实测 `/user/playlist` 的确切结构，所以这里**四层兜底**，
 * 并且**宁可让用户手选也不猜**：猜错的后果是同步了一整张错误的歌单，而用户
 * 只会在看到歌名不对时才发现。
 *
 * 优先级：
 *   1. 上次已固化、且这次仍在列表里（避免每次重猜，也让手选结果生效）
 *   2. 名称归一后 === 「我喜欢」
 *   3. 自建歌单里只有一个
 *   4. 自建且 type=0 的只有一个
 * 仍不确定 → 抛 SyncChoiceError，把候选交给前端手选。
 */
export function pickLikedPlaylist(list, { userid = '', savedId = '' } = {}) {
  if (!Array.isArray(list) || !list.length) {
    return { playlist: null, reason: 'empty', candidates: [] }
  }

  if (savedId) {
    const hit = list.find((p) => p.id === String(savedId))
    if (hit) return { playlist: hit, reason: 'saved', candidates: [] }
  }

  const mine = list.filter((p) => p.creatorId && String(p.creatorId) === String(userid))
  const pool = mine.length ? mine : list

  const named = pool.find((p) => normName(p.name) === '我喜欢') || list.find((p) => normName(p.name) === '我喜欢')
  if (named) return { playlist: named, reason: 'name', candidates: [] }

  if (mine.length === 1) return { playlist: mine[0], reason: 'only-self-built', candidates: [] }

  const byType = mine.filter((p) => p.type === 0)
  if (byType.length === 1) return { playlist: byType[0], reason: 'type', candidates: [] }

  // 只在自建歌单里挑；若连自建都识别不出来（creatorId 字段没对上），把全部候选交出去
  return { playlist: null, reason: 'ambiguous', candidates: pool.length ? pool : list }
}

/** 手动指定歌单时用：直接确认该歌单存在并固化 */
export async function bindPlaylist(playlistId) {
  const session = await activeSession({ require: true })
  const list = await listPlaylists(session)
  const hit = list.find((p) => p.id === String(playlistId))
  if (!hit) {
    const e = new Error('该歌单不在你的酷狗歌单列表里')
    e.status = 404
    throw e
  }
  await saveLikedPlaylist(hit.id, hit.name)
  return hit
}

// ---------------------------------------------------------------- 批量 upsert

// 每行 13 个占位符；size/playable/cover_cached/lyric_cached/in_liked 用常量
//（新行默认「未缓存、可播、未同步封面歌词、在歌单里」）。
const ROW_SQL = '(?,?,?,?,?,?,?,?,?,?,?,?,0,1,0,0,1,?)'

const UPSERT_HEAD = `INSERT INTO kg_tracks
    (hash, name, artist, album, duration, album_id, album_audio_id, cover_url,
     filename, ext, hash_used, quality_used, size, playable, cover_cached, lyric_cached, in_liked, ord)
  VALUES `

// ⚠️ 刻意**不更新** filename / ext / quality_used / size / playable / cover_cached /
//    lyric_cached / cos_url：这些是「已经学到的状态」或文件身份。
//    被同步覆盖会导致同一首歌指向不存在的对象，或把已迁移/已缓存的标记抹掉。
const UPSERT_TAIL = `
  ON CONFLICT(hash) DO UPDATE SET
    name           = excluded.name,
    artist         = excluded.artist,
    album          = excluded.album,
    duration       = excluded.duration,
    album_id       = excluded.album_id,
    album_audio_id = excluded.album_audio_id,
    cover_url      = excluded.cover_url,
    in_liked       = 1,
    ord            = excluded.ord,
    synced_at      = datetime('now')`

/**
 * 一次事务里分批 upsert。
 *
 * 为什么不是逐行 run：线上是 Turso（libSQL over HTTPS），每次 execute 都是一次往返，
 * 1450 首逐行提交要几十秒，会撞上 Vercel 函数 30 秒上限。多行 VALUES 把往返次数
 * 压到原来的 1/CHUNK，同时仍然全在一个事务里（要么整份成功，要么整份回滚）。
 */
const CHUNK = 60

/**
 * 把归一化后的曲目行（`rows` 里每项是 13 个参数）分批写进 kg_tracks。
 *
 * 导出是为了让迁移脚本 / 自测复用**同一段** SQL：upsert 的列清单很容易在拷贝时漂移，
 * 而一旦漂移，同步就会悄悄把「已迁移」或「受限」状态覆盖掉。
 */
export async function upsertSongs(t, rows) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    const sql = `${UPSERT_HEAD}${chunk.map(() => ROW_SQL).join(',')}${UPSERT_TAIL}`
    await t.run(sql, chunk.flat())
  }
}

/**
 * 执行同步。
 *
 * @param {{playlistId?: string}} [opts] 手动指定歌单
 * @returns {{playlist, reason, total, added, updated, removed}}
 */
export async function syncLiked({ playlistId = '' } = {}) {
  const session = await activeSession({ require: true })
  const binding = await getBinding()

  const list = await listPlaylists(session)
  const { playlist, reason, candidates } = pickLikedPlaylist(list, {
    userid: session.userid,
    savedId: playlistId || binding?.liked_playlist_id || '',
  })

  if (!playlist) {
    if (reason === 'empty') {
      const e = new Error('酷狗账号下没有取到任何歌单，请确认账号状态后重试')
      e.status = 502
      throw e
    }
    throw new SyncChoiceError('无法确定哪个是你的「我喜欢」，请手动选择', candidates)
  }

  const { list: songs } = await getPlaylistTracks(playlist.id, session)
  // 绝不允许「静默同步成 0 首」把整张歌单清空 —— 那看起来和「同步成功但歌没了」一模一样
  if (!songs.length) {
    const e = new Error(`歌单「${playlist.name}」里没有取到任何歌曲（是选错歌单了吗？）`)
    e.status = 502
    throw e
  }

  const ext = extForQuality(config.music.kugouQuality)
  const quality = config.music.kugouQuality

  const existingRows = await db.all('SELECT hash FROM kg_tracks', [])
  const existing = new Set(existingRows.map((r) => r.hash))
  let added = 0
  let updated = 0

  const rows = songs.map((s, i) => {
    if (existing.has(s.hash)) updated++
    else added++
    return [
      s.hash, s.name, s.singerText, s.album, s.duration, s.albumId, s.albumAudioId,
      s.cover, `${s.hash}.${ext}`, ext, s.hash, quality, i,
    ]
  })

  await db.tx(async (t) => {
    // 先全部视为「不在歌单里」，再把本次同步到的置回 1
    await t.run('UPDATE kg_tracks SET in_liked = 0', [])
    await upsertSongs(t, rows)
  })

  await saveLikedPlaylist(playlist.id, playlist.name)
  await markSynced()

  // in_liked=0 就是「上次同步在、这次不在了」——行与 COS 对象都保留，只是不再列出
  const removedRow = await db.get('SELECT COUNT(*) AS c FROM kg_tracks WHERE in_liked = 0', [])

  return {
    playlist: { id: playlist.id, name: playlist.name },
    reason,
    total: songs.length,
    added,
    updated,
    removed: Number(removedRow?.c) || 0,
  }
}
