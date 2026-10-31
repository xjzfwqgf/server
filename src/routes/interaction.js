import { Router } from 'express'
import { db } from '../db.js'
import { ah } from '../middleware/async.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()

const VIDEO_COLUMNS = `
  v.id, v.title, v.description, v.category, v.filename, v.source_url, v.cover_url,
  v.duration, v.uploader_id, v.views, v.likes, v.favorites, v.status, v.created_at,
  v.collection_id, v.episode,
  u.username AS author_name, u.nickname AS author_nick, u.avatar AS author_avatar,
  c.title AS collection_title
`
const BASE_JOIN = `
  FROM videos v
  JOIN users u ON u.id = v.uploader_id
  LEFT JOIN collections c ON c.id = v.collection_id
`

function publicVideo(v) {
  return {
    id: v.id,
    title: v.title,
    description: v.description,
    category: v.category,
    cover_url: v.cover_url,
    duration: v.duration,
    views: v.views,
    likes: v.likes,
    favorites: v.favorites,
    created_at: v.created_at,
    url: v.filename ? `/api/video/${v.id}/stream` : v.source_url,
    collection_id: v.collection_id ?? null,
    episode: v.episode ?? 0,
    collection_title: v.collection_title || null,
    author: {
      id: v.uploader_id,
      name: v.author_name,
      nickname: v.author_nick,
      avatar: v.author_avatar,
    },
  }
}

// ---------- 点赞（切换） ----------
router.post('/video/:id/like', requireAuth, ah(async (req, res) => {
  const v = await db.get('SELECT id FROM videos WHERE id = ? AND status = 1', [req.params.id])
  if (!v) return res.status(404).json({ message: '视频不存在' })
  const exists = await db.get('SELECT id FROM video_likes WHERE user_id = ? AND video_id = ?', [
    req.user.id,
    v.id,
  ])
  if (exists) {
    await db.run('DELETE FROM video_likes WHERE id = ?', [exists.id])
    await db.run('UPDATE videos SET likes = likes - 1 WHERE id = ?', [v.id])
    const row = await db.get('SELECT likes FROM videos WHERE id = ?', [v.id])
    return res.json({ liked: false, likes: row.likes })
  }
  await db.run('INSERT INTO video_likes (user_id, video_id) VALUES (?, ?)', [req.user.id, v.id])
  await db.run('UPDATE videos SET likes = likes + 1 WHERE id = ?', [v.id])
  const row = await db.get('SELECT likes FROM videos WHERE id = ?', [v.id])
  res.json({ liked: true, likes: row.likes })
}))

// ---------- 收藏（切换） ----------
router.post('/video/:id/favorite', requireAuth, ah(async (req, res) => {
  const v = await db.get('SELECT id FROM videos WHERE id = ? AND status = 1', [req.params.id])
  if (!v) return res.status(404).json({ message: '视频不存在' })
  const exists = await db.get('SELECT id FROM favorites WHERE user_id = ? AND video_id = ?', [
    req.user.id,
    v.id,
  ])
  if (exists) {
    await db.run('DELETE FROM favorites WHERE id = ?', [exists.id])
    await db.run('UPDATE videos SET favorites = favorites - 1 WHERE id = ?', [v.id])
    const row = await db.get('SELECT favorites FROM videos WHERE id = ?', [v.id])
    return res.json({ favorited: false, favorites: row.favorites })
  }
  await db.run('INSERT INTO favorites (user_id, video_id) VALUES (?, ?)', [req.user.id, v.id])
  await db.run('UPDATE videos SET favorites = favorites + 1 WHERE id = ?', [v.id])
  const row = await db.get('SELECT favorites FROM videos WHERE id = ?', [v.id])
  res.json({ favorited: true, favorites: row.favorites })
}))

// ---------- 记录观看历史 ----------
router.post('/video/:id/history', requireAuth, ah(async (req, res) => {
  const v = await db.get('SELECT id FROM videos WHERE id = ? AND status = 1', [req.params.id])
  if (!v) return res.status(404).json({ message: '视频不存在' })
  const progress = Math.max(0, parseFloat(req.body.progress) || 0)
  await db.run(
    `INSERT INTO history (user_id, video_id, progress, watched_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, video_id) DO UPDATE SET
       progress = excluded.progress,
       watched_at = excluded.watched_at`,
    [req.user.id, v.id, progress],
  )
  res.json({ ok: true })
}))

// ---------- 我的收藏 ----------
router.get('/me/favorites', requireAuth, ah(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1)
  const size = Math.min(50, Math.max(1, parseInt(req.query.size) || 12))
  const rows = await db.all(
    `SELECT ${VIDEO_COLUMNS}, f.created_at AS fav_time ${BASE_JOIN}
     JOIN favorites f ON f.video_id = v.id
     WHERE f.user_id = ? AND v.status = 1
     ORDER BY f.created_at DESC LIMIT ? OFFSET ?`,
    [req.user.id, size, (page - 1) * size],
  )
  const total = (await db.get('SELECT COUNT(*) AS c FROM favorites WHERE user_id = ?', [req.user.id])).c
  res.json({
    list: rows.map((v) => publicVideo(v)),
    total,
    hasMore: page * size < total,
  })
}))

// ---------- 我的投稿 ----------
router.get('/me/uploads', requireAuth, ah(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1)
  const size = Math.min(50, Math.max(1, parseInt(req.query.size) || 12))
  const rows = await db.all(
    `SELECT ${VIDEO_COLUMNS} ${BASE_JOIN}
     WHERE v.uploader_id = ? ORDER BY v.created_at DESC LIMIT ? OFFSET ?`,
    [req.user.id, size, (page - 1) * size],
  )
  const total = (
    await db.get('SELECT COUNT(*) AS c FROM videos WHERE uploader_id = ?', [req.user.id])
  ).c
  res.json({
    list: rows.map((v) => publicVideo(v)),
    total,
    hasMore: page * size < total,
  })
}))

// ---------- 我的观看历史 ----------
router.get('/me/history', requireAuth, ah(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1)
  const size = Math.min(50, Math.max(1, parseInt(req.query.size) || 12))
  const rows = await db.all(
    `SELECT ${VIDEO_COLUMNS}, h.progress, h.watched_at AS watched_time ${BASE_JOIN}
     JOIN history h ON h.video_id = v.id
     WHERE h.user_id = ? AND v.status = 1
     ORDER BY h.watched_at DESC LIMIT ? OFFSET ?`,
    [req.user.id, size, (page - 1) * size],
  )
  const total = (await db.get('SELECT COUNT(*) AS c FROM history WHERE user_id = ?', [req.user.id])).c
  res.json({
    list: rows.map((v) => ({ ...publicVideo(v), progress: v.progress, watched_time: v.watched_time })),
    total,
    hasMore: page * size < total,
  })
}))

// ---------- 清空历史 ----------
router.delete('/me/history', requireAuth, ah(async (req, res) => {
  await db.run('DELETE FROM history WHERE user_id = ?', [req.user.id])
  res.json({ message: '已清空' })
}))

export default router
