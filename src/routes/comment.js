import { Router } from 'express'
import { db } from '../db.js'
import { ah } from '../middleware/async.js'
import { requireAuth } from '../middleware/auth.js'
import { rateLimit } from '../middleware/ratelimit.js'

const router = Router()

// 评论列表：返回一层评论 + 各自的楼中楼回复
router.get('/video/:id/comments', ah(async (req, res) => {
  const v = await db.get('SELECT id FROM videos WHERE id = ? AND status = 1', [req.params.id])
  if (!v) return res.status(404).json({ message: '视频不存在' })

  const page = Math.max(1, parseInt(req.query.page) || 1)
  const size = Math.min(50, Math.max(1, parseInt(req.query.size) || 10))

  const total = (
    await db.get('SELECT COUNT(*) AS c FROM comments WHERE video_id = ? AND parent_id IS NULL', [v.id])
  ).c
  const roots = await db.all(
    `SELECT c.*, u.username, u.nickname, u.avatar, u.status AS user_status
     FROM comments c JOIN users u ON u.id = c.user_id
     WHERE c.video_id = ? AND c.parent_id IS NULL
     ORDER BY c.created_at ASC LIMIT ? OFFSET ?`,
    [v.id, size, (page - 1) * size],
  )

  const rootIds = roots.map((r) => r.id)
  let replies = []
  if (rootIds.length) {
    const placeholders = rootIds.map(() => '?').join(',')
    replies = await db.all(
      `SELECT c.*, u.username, u.nickname, u.avatar, u.status AS user_status
       FROM comments c JOIN users u ON u.id = c.user_id
       WHERE c.video_id = ? AND c.parent_id IN (${placeholders})
       ORDER BY c.created_at ASC LIMIT 100`,
      [v.id, ...rootIds],
    )
  }
  const replyMap = {}
  for (const r of replies) {
    ;(replyMap[r.parent_id] ||= []).push(r)
  }

  res.json({
    list: roots.map((r) => ({
      id: r.id,
      content: r.content,
      likes: r.likes,
      created_at: r.created_at,
      author: { id: r.user_id, name: r.username, nickname: r.nickname, avatar: r.avatar },
      user_status: r.user_status,
      replies: replyMap[r.id]?.map((rp) => ({
        id: rp.id,
        content: rp.content,
        likes: rp.likes,
        created_at: rp.created_at,
        author: { id: rp.user_id, name: rp.username, nickname: rp.nickname, avatar: rp.avatar },
        user_status: rp.user_status,
      })) || [],
    })),
    total,
    hasMore: page * size < total,
  })
}))

// 发表评论 / 回复（限流防刷屏）
router.post(
  '/video/:id/comments',
  requireAuth,
  rateLimit({ windowMs: 60 * 1000, max: 30, message: '评论太快了，歇口气再发' }),
  ah(async (req, res) => {
    const v = await db.get('SELECT id FROM videos WHERE id = ? AND status = 1', [req.params.id])
    if (!v) return res.status(404).json({ message: '视频不存在' })
    const content = String(req.body.content || '').trim()
    if (!content) return res.status(400).json({ message: '评论内容不能为空' })
    if (content.length > 500) return res.status(400).json({ message: '评论最多 500 字' })

    const parentId = req.body.parentId ? parseInt(req.body.parentId) : null
    if (parentId) {
      const parent = await db.get('SELECT id FROM comments WHERE id = ? AND video_id = ?', [
        parentId,
        v.id,
      ])
      if (!parent) return res.status(400).json({ message: '回复的评论不存在' })
    }

    const info = await db.run(
      'INSERT INTO comments (video_id, user_id, parent_id, content) VALUES (?, ?, ?, ?)',
      [v.id, req.user.id, parentId, content.slice(0, 500)],
    )
    const c = await db.get('SELECT * FROM comments WHERE id = ?', [info.lastInsertRowid])
    res.json({
      comment: {
        id: c.id,
        content: c.content,
        likes: c.likes,
        created_at: c.created_at,
        parent_id: c.parent_id,
        author: {
          id: req.user.id,
          name: req.user.username,
          nickname: req.user.nickname,
          avatar: req.user.avatar,
        },
      },
    })
  }),
)

// 删除评论（作者或管理员）
router.delete('/comments/:id', requireAuth, ah(async (req, res) => {
  const c = await db.get('SELECT * FROM comments WHERE id = ?', [req.params.id])
  if (!c) return res.status(404).json({ message: '评论不存在' })
  if (c.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ message: '没有权限' })
  }
  await db.run('DELETE FROM comments WHERE id = ? OR parent_id = ?', [c.id, c.id])
  res.json({ message: '已删除' })
}))

export default router
