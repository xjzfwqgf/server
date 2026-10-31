import { Router } from 'express'
import { db } from '../db.js'
import { ah } from '../middleware/async.js'
import { requireAdmin } from '../middleware/auth.js'
import { categories } from '../config.js'
import { isCos, deleteObject, buildKey, resolveStoredKey } from '../storage.js'

const router = Router()
router.use(requireAdmin)

/**
 * 删除视频时顺带清理对象存储（视频本体 + 首帧封面）。
 * 故意做成 best-effort：对象删不掉只记日志，不能因为存储侧抖动就让数据库删除失败——
 * 留下孤儿对象只是浪费空间，留下删不掉的记录才是真的麻烦。
 */
async function purgeVideoObjects(rows) {
  if (!isCos()) return 0
  let n = 0
  for (const v of rows) {
    if (v.filename && !/^https?:\/\//i.test(v.filename)) {
      const key = v.filename.includes('/') ? v.filename : buildKey('video', v.filename)
      try {
        await deleteObject(key)
        n++
      } catch (e) {
        console.warn('[admin] 删除 COS 视频对象失败:', key, e.message)
      }
    }
    if (v.cover_url && /^https?:\/\//i.test(v.cover_url)) {
      const key = resolveStoredKey(v.cover_url, 'cover')
      if (key) {
        try {
          await deleteObject(key)
          n++
        } catch (e) {
          console.warn('[admin] 删除 COS 封面失败:', key, e.message)
        }
      }
    }
  }
  return n
}

// ---------- 数据统计 ----------
router.get('/stats', ah(async (req, res) => {
  const one = (sql, args = []) => db.get(sql, args)
  const stats = {
    userCount: (await one('SELECT COUNT(*) AS c FROM users')).c,
    videoCount: (await one('SELECT COUNT(*) AS c FROM videos')).c,
    commentCount: (await one('SELECT COUNT(*) AS c FROM comments')).c,
    danmakuCount: (await one('SELECT COUNT(*) AS c FROM danmaku')).c,
    totalViews: (await one('SELECT COALESCE(SUM(views), 0) AS c FROM videos')).c,
    todayRegisters: (await one("SELECT COUNT(*) AS c FROM users WHERE date(created_at) = date('now')")).c,
  }
  const byCategory = await db.all(
    'SELECT category, COUNT(*) AS count FROM videos GROUP BY category ORDER BY count DESC',
    [],
  )
  const topVideos = await db.all(
    `SELECT v.id, v.title, v.views, v.likes, v.favorites, v.created_at,
            u.nickname AS author
     FROM videos v JOIN users u ON u.id = v.uploader_id
     ORDER BY v.views DESC LIMIT 5`,
    [],
  )
  const recentUsers = await db.all(
    'SELECT id, username, nickname, role, status, created_at FROM users ORDER BY created_at DESC LIMIT 5',
    [],
  )
  res.json({ stats, byCategory, topVideos, recentUsers })
}))

// ---------- 用户管理 ----------
router.get('/users', ah(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1)
  const size = Math.min(50, Math.max(1, parseInt(req.query.size) || 10))
  const keyword = String(req.query.keyword || '').trim()
  const conds = []
  const params = []
  if (keyword) {
    conds.push('(username LIKE ? OR nickname LIKE ?)')
    params.push(`%${keyword}%`, `%${keyword}%`)
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const total = (await db.get(`SELECT COUNT(*) AS c FROM users ${where}`, params)).c
  const list = await db.all(
    `SELECT id, username, nickname, avatar, bio, role, status, created_at,
            (SELECT COUNT(*) FROM videos WHERE uploader_id = users.id) AS video_count
     FROM users ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, size, (page - 1) * size],
  )
  res.json({ list, total, hasMore: page * size < total })
}))

router.post('/users/:id/ban', ah(async (req, res) => {
  const u = await db.get('SELECT * FROM users WHERE id = ?', [req.params.id])
  if (!u) return res.status(404).json({ message: '用户不存在' })
  if (u.role === 'admin') return res.status(400).json({ message: '不能封禁管理员' })
  await db.run('UPDATE users SET status = 0 WHERE id = ?', [u.id])
  res.json({ message: '已封禁' })
}))

router.post('/users/:id/unban', ah(async (req, res) => {
  const u = await db.get('SELECT * FROM users WHERE id = ?', [req.params.id])
  if (!u) return res.status(404).json({ message: '用户不存在' })
  await db.run('UPDATE users SET status = 1 WHERE id = ?', [u.id])
  res.json({ message: '已解封' })
}))

router.put('/users/:id/role', ah(async (req, res) => {
  const u = await db.get('SELECT * FROM users WHERE id = ?', [req.params.id])
  if (!u) return res.status(404).json({ message: '用户不存在' })
  const role = req.body.role === 'admin' ? 'admin' : 'user'
  await db.run('UPDATE users SET role = ? WHERE id = ?', [role, u.id])
  res.json({ message: '已更新' })
}))

// ---------- 视频管理 ----------
router.get('/videos', ah(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1)
  const size = Math.min(50, Math.max(1, parseInt(req.query.size) || 10))
  const keyword = String(req.query.keyword || '').trim()
  const status = req.query.status === undefined ? null : parseInt(req.query.status)
  const collectionId = req.query.collectionId ? parseInt(req.query.collectionId) : null
  const conds = []
  const params = []
  if (keyword) {
    conds.push('(v.title LIKE ? OR v.description LIKE ?)')
    params.push(`%${keyword}%`, `%${keyword}%`)
  }
  if (status === 0 || status === 1) {
    conds.push('v.status = ?')
    params.push(status)
  }
  if (req.query.unassigned === '1') {
    conds.push('v.collection_id IS NULL')
  } else if (collectionId) {
    conds.push('v.collection_id = ?')
    params.push(collectionId)
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const total = (await db.get(`SELECT COUNT(*) AS c FROM videos v ${where}`, params)).c
  const list = await db.all(
    `SELECT v.id, v.title, v.category, v.views, v.likes, v.favorites, v.status, v.created_at,
            v.filename, v.source_url, v.cover_url, v.collection_id, v.episode,
            c.title AS collection_title,
            u.nickname AS author, u.id AS author_id
     FROM videos v
     JOIN users u ON u.id = v.uploader_id
     LEFT JOIN collections c ON c.id = v.collection_id
     ${where} ORDER BY v.created_at DESC LIMIT ? OFFSET ?`,
    [...params, size, (page - 1) * size],
  )
  res.json({ list, total, hasMore: page * size < total })
}))

// ---------- 编辑视频（标题/分类/所属合集/集数） ----------
router.put('/videos/:id', ah(async (req, res) => {
  const v = await db.get('SELECT * FROM videos WHERE id = ?', [req.params.id])
  if (!v) return res.status(404).json({ message: '视频不存在' })

  let collection_id = v.collection_id
  let episode = v.episode
  if (req.body.collection_id === '' || req.body.collection_id === null) {
    // 明确置空：移出合集，集数归零，避免残留「第0集」
    collection_id = null
    episode = 0
  } else if (req.body.collection_id !== undefined) {
    const cid = parseInt(req.body.collection_id, 10)
    if (!Number.isInteger(cid) || !(await db.get('SELECT id FROM collections WHERE id = ?', [cid]))) {
      return res.status(400).json({ message: '合集不存在' })
    }
    collection_id = cid
    const e = parseInt(req.body.episode, 10)
    episode = Number.isInteger(e) && e >= 1 ? e : 1
  } else if (req.body.episode !== undefined) {
    const e = parseInt(req.body.episode, 10)
    episode = Number.isInteger(e) && e >= 1 ? e : 1
  }

  const title =
    req.body.title !== undefined ? String(req.body.title).slice(0, 80) : v.title
  const category =
    req.body.category !== undefined && categories.includes(req.body.category)
      ? req.body.category
      : v.category

  await db.run(
    'UPDATE videos SET title = ?, category = ?, collection_id = ?, episode = ? WHERE id = ?',
    [title, category, collection_id, episode, v.id],
  )
  res.json({ message: '已更新' })
}))

// ---------- 批量分配到合集 ----------
router.post('/videos/assign-collection', ah(async (req, res) => {
  const cid = parseInt(req.body.collection_id, 10)
  if (!Number.isInteger(cid) || !(await db.get('SELECT id FROM collections WHERE id = ?', [cid]))) {
    return res.status(400).json({ message: '合集不存在' })
  }
  const items = Array.isArray(req.body.items) ? req.body.items : []
  if (!items.length) return res.status(400).json({ message: '未选择视频' })
  // 交互事务：循环里的读写都在同一事务内，任一步抛错则整体回滚
  await db.tx(async (t) => {
    for (const it of items) {
      const vid = parseInt(it.video_id, 10)
      if (!Number.isInteger(vid) || !(await t.get('SELECT id FROM videos WHERE id = ?', [vid]))) continue
      const e = parseInt(it.episode, 10)
      await t.run('UPDATE videos SET collection_id = ?, episode = ? WHERE id = ?', [
        cid,
        Number.isInteger(e) && e >= 1 ? e : 1,
        vid,
      ])
    }
  })
  res.json({ message: '已批量设置' })
}))

router.post('/videos/:id/status', ah(async (req, res) => {
  const v = await db.get('SELECT id FROM videos WHERE id = ?', [req.params.id])
  if (!v) return res.status(404).json({ message: '视频不存在' })
  const status = req.body.status === 0 ? 0 : 1
  await db.run('UPDATE videos SET status = ? WHERE id = ?', [status, v.id])
  res.json({ message: status === 1 ? '已上架' : '已下架' })
}))

router.delete('/videos/:id', ah(async (req, res) => {
  const v = await db.get('SELECT * FROM videos WHERE id = ?', [req.params.id])
  if (!v) return res.status(404).json({ message: '视频不存在' })
  // 先删子表再删 videos 行，否则 foreign_keys=ON 时 FK 校验失败
  await db.run('DELETE FROM video_likes WHERE video_id = ?', [v.id])
  await db.run('DELETE FROM favorites WHERE video_id = ?', [v.id])
  await db.run('DELETE FROM history WHERE video_id = ?', [v.id])
  await db.run('DELETE FROM comments WHERE video_id = ?', [v.id])
  await db.run('DELETE FROM danmaku WHERE video_id = ?', [v.id])
  await db.run('DELETE FROM videos WHERE id = ?', [v.id])
  await purgeVideoObjects([v])
  res.json({ message: '已删除' })
}))

// ---------- 批量删除视频 ----------
// 前端勾选多行后一次提交；子表 + 主表放在同一个事务里，避免删到一半失败留下半截数据。
router.post('/videos/batch-delete', ah(async (req, res) => {
  const raw = Array.isArray(req.body?.ids) ? req.body.ids : []
  const ids = [
    ...new Set(raw.map((x) => parseInt(x, 10)).filter((n) => Number.isInteger(n) && n > 0)),
  ]
  if (!ids.length) return res.status(400).json({ message: '请先勾选要删除的视频' })
  if (ids.length > 200) {
    return res.status(400).json({ message: '单次最多删除 200 个视频，请分批操作' })
  }

  const ph = ids.map(() => '?').join(',')
  const rows = await db.all(`SELECT id, filename, cover_url FROM videos WHERE id IN (${ph})`, ids)
  if (!rows.length) return res.status(404).json({ message: '选中的视频都不存在' })

  const found = rows.map((r) => r.id)
  const ph2 = found.map(() => '?').join(',')
  await db.tx(async (t) => {
    await t.run(`DELETE FROM video_likes WHERE video_id IN (${ph2})`, found)
    await t.run(`DELETE FROM favorites WHERE video_id IN (${ph2})`, found)
    await t.run(`DELETE FROM history WHERE video_id IN (${ph2})`, found)
    await t.run(`DELETE FROM comments WHERE video_id IN (${ph2})`, found)
    await t.run(`DELETE FROM danmaku WHERE video_id IN (${ph2})`, found)
    await t.run(`DELETE FROM videos WHERE id IN (${ph2})`, found)
  })

  const objectsDeleted = await purgeVideoObjects(rows)
  const missing = ids.length - found.length

  res.json({
    message: `已删除 ${found.length} 个视频${missing ? `（${missing} 个不存在已跳过）` : ''}`,
    deleted: found.length,
    missing,
    objectsDeleted,
  })
}))

// ---------- 合集管理 ----------
router.get('/collections', ah(async (req, res) => {
  const rows = await db.all(
    `SELECT c.id, c.title, c.description, c.cover_url, c.created_at,
      (SELECT COUNT(*) FROM videos v WHERE v.collection_id = c.id) AS video_count,
      (SELECT COUNT(*) FROM videos v WHERE v.collection_id = c.id AND v.status = 1) AS episode_count,
      (SELECT v.cover_url FROM videos v WHERE v.collection_id = c.id
        ORDER BY v.episode ASC, v.id ASC LIMIT 1) AS first_cover
     FROM collections c ORDER BY c.created_at DESC, c.id DESC`,
    [],
  )
  res.json({ list: rows })
}))

router.post('/collections', ah(async (req, res) => {
  const title = String(req.body.title || '').trim()
  if (!title) return res.status(400).json({ message: '请填写合集标题' })
  const info = await db.run(
    'INSERT INTO collections (title, description, cover_url, created_by) VALUES (?, ?, ?, ?)',
    [
      title.slice(0, 80),
      String(req.body.description || '').slice(0, 500),
      String(req.body.cover_url || '').trim(),
      req.user.id,
    ],
  )
  res.json({ id: Number(info.lastInsertRowid) })
}))

router.put('/collections/:id', ah(async (req, res) => {
  const c = await db.get('SELECT id FROM collections WHERE id = ?', [req.params.id])
  if (!c) return res.status(404).json({ message: '合集不存在' })
  await db.run('UPDATE collections SET title = ?, description = ?, cover_url = ? WHERE id = ?', [
    String(req.body.title || '').slice(0, 80),
    String(req.body.description || '').slice(0, 500),
    String(req.body.cover_url || '').trim(),
    c.id,
  ])
  res.json({ message: '已更新' })
}))

router.delete('/collections/:id', ah(async (req, res) => {
  const c = await db.get('SELECT id FROM collections WHERE id = ?', [req.params.id])
  if (!c) return res.status(404).json({ message: '合集不存在' })
  // 先把旗下视频移出合集（同时清集数），再删合集
  await db.run('UPDATE videos SET collection_id = NULL, episode = 0 WHERE collection_id = ?', [c.id])
  await db.run('DELETE FROM collections WHERE id = ?', [c.id])
  res.json({ message: '已删除' })
}))

// ---------- 合集剧集成员管理 ----------
// 列出现有成员（任意状态，含下架）
router.get('/collections/:id/videos', ah(async (req, res) => {
  const c = await db.get('SELECT id FROM collections WHERE id = ?', [req.params.id])
  if (!c) return res.status(404).json({ message: '合集不存在' })
  const list = await db.all(
    `SELECT v.id, v.title, v.cover_url, v.episode, v.status, v.category, v.created_at,
            u.nickname AS author
     FROM videos v JOIN users u ON u.id = v.uploader_id
     WHERE v.collection_id = ? ORDER BY v.episode ASC, v.id ASC`,
    [c.id],
  )
  res.json({ list })
}))

// 加入一个视频并设置集数
router.post('/collections/:id/videos', ah(async (req, res) => {
  const c = await db.get('SELECT id FROM collections WHERE id = ?', [req.params.id])
  if (!c) return res.status(404).json({ message: '合集不存在' })
  const vid = parseInt(req.body.video_id, 10)
  if (!Number.isInteger(vid) || !(await db.get('SELECT id FROM videos WHERE id = ?', [vid]))) {
    return res.status(404).json({ message: '视频不存在' })
  }
  const e = parseInt(req.body.episode, 10)
  await db.run('UPDATE videos SET collection_id = ?, episode = ? WHERE id = ?', [
    c.id,
    Number.isInteger(e) && e >= 1 ? e : 1,
    vid,
  ])
  res.json({ message: '已加入' })
}))

// 移出合集（集数归零）
router.delete('/collections/:id/videos/:video_id', ah(async (req, res) => {
  const v = await db.get('SELECT id FROM videos WHERE id = ?', [req.params.video_id])
  if (!v) return res.status(404).json({ message: '视频不存在' })
  await db.run('UPDATE videos SET collection_id = NULL, episode = 0 WHERE id = ?', [v.id])
  res.json({ message: '已移除' })
}))

// ---------- 评论管理 ----------
router.get('/comments', ah(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1)
  const size = Math.min(50, Math.max(1, parseInt(req.query.size) || 10))
  const keyword = String(req.query.keyword || '').trim()
  const conds = []
  const params = []
  if (keyword) {
    conds.push('c.content LIKE ?')
    params.push(`%${keyword}%`)
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const total = (await db.get(`SELECT COUNT(*) AS c FROM comments c ${where}`, params)).c
  const list = await db.all(
    `SELECT c.id, c.content, c.created_at, c.video_id, c.parent_id,
            u.nickname AS author, v.title AS video_title
     FROM comments c
     JOIN users u ON u.id = c.user_id
     JOIN videos v ON v.id = c.video_id
     ${where} ORDER BY c.created_at DESC LIMIT ? OFFSET ?`,
    [...params, size, (page - 1) * size],
  )
  res.json({ list, total, hasMore: page * size < total })
}))

router.delete('/comments/:id', ah(async (req, res) => {
  const c = await db.get('SELECT id FROM comments WHERE id = ?', [req.params.id])
  if (!c) return res.status(404).json({ message: '评论不存在' })
  await db.run('DELETE FROM comments WHERE id = ? OR parent_id = ?', [c.id, c.id])
  res.json({ message: '已删除' })
}))

// ---------- 弹幕管理 ----------
router.get('/danmaku', ah(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1)
  const size = Math.min(50, Math.max(1, parseInt(req.query.size) || 10))
  const videoId = req.query.videoId ? parseInt(req.query.videoId) : null
  const conds = []
  const params = []
  if (videoId) {
    conds.push('d.video_id = ?')
    params.push(videoId)
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const total = (await db.get(`SELECT COUNT(*) AS c FROM danmaku d ${where}`, params)).c
  const list = await db.all(
    `SELECT d.id, d.time, d.text, d.color, d.position, d.created_at, d.video_id,
            v.title AS video_title
     FROM danmaku d JOIN videos v ON v.id = d.video_id
     ${where} ORDER BY d.created_at DESC LIMIT ? OFFSET ?`,
    [...params, size, (page - 1) * size],
  )
  res.json({ list, total, hasMore: page * size < total })
}))

router.delete('/danmaku/:id', ah(async (req, res) => {
  const d = await db.get('SELECT id FROM danmaku WHERE id = ?', [req.params.id])
  if (!d) return res.status(404).json({ message: '弹幕不存在' })
  await db.run('DELETE FROM danmaku WHERE id = ?', [d.id])
  res.json({ message: '已删除' })
}))

export default router
