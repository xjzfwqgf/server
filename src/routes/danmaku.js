import { Router } from 'express'
import { db } from '../db.js'
import { ah } from '../middleware/async.js'
import { requireAuth } from '../middleware/auth.js'
import { rateLimit } from '../middleware/ratelimit.js'

const router = Router()

// 获取某视频的全部弹幕
router.get('/video/:id/danmaku', ah(async (req, res) => {
  const v = await db.get('SELECT id FROM videos WHERE id = ? AND status = 1', [req.params.id])
  if (!v) return res.status(404).json({ message: '视频不存在' })
  const list = await db.all(
    'SELECT id, time, text, color, position FROM danmaku WHERE video_id = ? ORDER BY time ASC',
    [v.id],
  )
  res.json({ list })
}))

// 发送弹幕（限流防刷屏）
router.post(
  '/video/:id/danmaku',
  requireAuth,
  rateLimit({ windowMs: 60 * 1000, max: 60, message: '弹幕发得太快了，缓一缓' }),
  ah(async (req, res) => {
    const v = await db.get('SELECT id FROM videos WHERE id = ? AND status = 1', [req.params.id])
    if (!v) return res.status(404).json({ message: '视频不存在' })
    const text = String(req.body.text || '').trim()
    if (!text) return res.status(400).json({ message: '弹幕内容不能为空' })
    if (text.length > 100) return res.status(400).json({ message: '弹幕最多 100 字' })
    const time = Math.max(0, parseFloat(req.body.time) || 0)
    const color = /^#[0-9a-fA-F]{3,6}$/.test(String(req.body.color || '')) ? req.body.color : '#ffffff'
    const position = [0, 1, 2].includes(parseInt(req.body.position)) ? parseInt(req.body.position) : 0

    const info = await db.run(
      'INSERT INTO danmaku (video_id, user_id, time, text, color, position) VALUES (?, ?, ?, ?, ?, ?)',
      [v.id, req.user.id, time, text.slice(0, 100), color, position],
    )
    res.json({ danmaku: { id: info.lastInsertRowid, time, text, color, position } })
  }),
)

export default router
