import { Router } from 'express'
import { db } from '../db.js'
import { ah } from '../middleware/async.js'
import { VIDEO_COLUMNS, BASE_JOIN, publicVideo } from '../video-util.js'

const router = Router()

// ---------- 合集列表（公共） ----------
// 注意：必须先于 /:id 注册，否则 "list" 会被当成 id 匹配
router.get('/list', ah(async (req, res) => {
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 50))
  const rows = await db.all(
    `SELECT c.id, c.title, c.description, c.cover_url, c.created_at,
      (SELECT COUNT(*) FROM videos v WHERE v.collection_id = c.id AND v.status = 1) AS episode_count,
      (SELECT v.cover_url FROM videos v WHERE v.collection_id = c.id AND v.status = 1
        ORDER BY v.episode ASC, v.id ASC LIMIT 1) AS first_cover
     FROM collections c ORDER BY c.created_at DESC, c.id DESC LIMIT ?`,
    [limit],
  )
  res.json({
    list: rows.map((c) => ({
      id: c.id,
      title: c.title,
      description: c.description,
      cover_url: c.cover_url || c.first_cover || '',
      episode_count: c.episode_count,
      created_at: c.created_at,
    })),
  })
}))

// ---------- 合集详情（公共） ----------
router.get('/:id', ah(async (req, res) => {
  const c = await db.get('SELECT * FROM collections WHERE id = ?', [req.params.id])
  if (!c) return res.status(404).json({ message: '合集不存在' })
  const eps = (
    await db.all(
      `SELECT ${VIDEO_COLUMNS} ${BASE_JOIN}
       WHERE v.collection_id = ? AND v.status = 1
       ORDER BY v.episode ASC, v.id ASC`,
      [c.id],
    )
  ).map((v) => publicVideo(v))
  res.json({
    collection: {
      id: c.id,
      title: c.title,
      description: c.description,
      cover_url: c.cover_url || eps[0]?.cover_url || '',
      episode_count: eps.length,
      episodes: eps,
    },
  })
}))

export default router
