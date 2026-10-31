import { Router } from 'express'
import multer from 'multer'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { db } from '../db.js'
import { config, categories } from '../config.js'
import { ah } from '../middleware/async.js'
import { requireAuth, requireAdmin, optionalAuth } from '../middleware/auth.js'
import {
  isCos,
  presignPut,
  publicUrl,
  buildKey,
  isAllowedKey,
  deleteObject,
  resolveStoredKey,
} from '../storage.js'
import { VIDEO_COLUMNS, BASE_JOIN, publicVideo } from '../video-util.js'

const router = Router()

// 允许上传的视频扩展名（白名单）
const ALLOWED_VIDEO_EXTS = new Set(['.mp4', '.webm', '.mkv', '.mov', '.ogg', '.avi', '.ts', '.flv'])
const ALLOWED_COVER_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp'])

// 读取文件头部若干字节（避免把 2GB 视频整个读进内存）
function readHead(filePath, len = 65536) {
  const fd = fs.openSync(filePath, 'r')
  try {
    const buf = Buffer.alloc(len)
    const n = fs.readSync(fd, buf, 0, len, 0)
    return buf.subarray(0, n)
  } finally {
    fs.closeSync(fd)
  }
}

// 校验文件头 magic bytes：扩展名是白名单还不够，
// 伪造扩展名的 .html/.svg/.php 改名为 .mp4 也会被拦下
function checkVideoMagic(filePath, ext) {
  const b = readHead(filePath)
  if (ext === '.mp4' || ext === '.mov') {
    return b.length > 8 && b.toString('latin1', 4, 8) === 'ftyp'
  }
  if (ext === '.webm' || ext === '.mkv') {
    return b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3
  }
  if (ext === '.ogg') return b.toString('latin1', 0, 4) === 'OggS'
  if (ext === '.avi') {
    return b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'AVI '
  }
  if (ext === '.ts') {
    for (let i = 0; i < Math.min(b.length, 940); i += 188) if (b[i] === 0x47) return true
    return false
  }
  if (ext === '.flv') return b.toString('latin1', 0, 3) === 'FLV'
  return false
}

// 随机文件名：时间戳-12位hex+扩展名
function newUploadName(ext) {
  return `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`
}

function localVideoDir() {
  const dir = path.join(config.uploadDir, 'videos')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// 「本机路径导入」用的路径校验（仅本地磁盘模式可用）
function resolveImportPath(input) {
  if (!config.import.allowedDirs.length) return { ok: false, code: 'NOT_CONFIGURED' }
  if (typeof input !== 'string') return { ok: false, code: 'BAD_PATH' }
  const raw = input.trim().replace(/^"(.*)"$/, '$1').trim()
  if (!raw || raw.includes('\0')) return { ok: false, code: 'BAD_PATH' }

  let real
  try {
    real = fs.realpathSync(path.resolve(raw))
  } catch {
    return { ok: false, code: 'BAD_PATH' }
  }
  let st
  try {
    st = fs.statSync(real)
  } catch {
    return { ok: false, code: 'BAD_PATH' }
  }
  if (!st.isFile()) return { ok: false, code: 'BAD_PATH' }

  const allowed = config.import.allowedDirs.some((root) => {
    let r
    try {
      r = fs.realpathSync(root)
    } catch {
      return false
    }
    return real === r || real.startsWith(r + path.sep)
  })
  if (!allowed) return { ok: false, code: 'OUTSIDE' }
  return { ok: true, real, size: st.size }
}

// ---------- 本地磁盘上传（仅 STORAGE_DRIVER=local 时可用） ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      cb(null, localVideoDir())
    } catch (e) {
      cb(e)
    }
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.mp4'
    cb(null, newUploadName(ext))
  },
})
const upload = multer({
  storage,
  limits: { fileSize: config.maxVideoSize },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    if (!ALLOWED_VIDEO_EXTS.has(ext)) {
      const err = new Error('仅支持上传视频文件（mp4/webm/mkv/mov/ogg/avi/ts/flv）')
      err.status = 400
      return cb(err)
    }
    cb(null, true)
  },
})

async function getVideo(id, includeStatus = true) {
  const where = includeStatus ? 'v.status = 1 AND v.id = ?' : 'v.id = ?'
  return db.get(`SELECT ${VIDEO_COLUMNS} ${BASE_JOIN} WHERE ${where}`, [id])
}

async function collectionEpisodes(collectionId) {
  const rows = await db.all(
    `SELECT ${VIDEO_COLUMNS} ${BASE_JOIN}
     WHERE v.collection_id = ? AND v.status = 1
     ORDER BY v.episode ASC, v.id ASC`,
    [collectionId],
  )
  return rows.map((r) => publicVideo(r))
}

// ---------- 存储模式（前端据此决定直传 COS 还是走 multipart） ----------
router.get('/upload-mode', (req, res) => {
  res.json({ mode: isCos() ? 'cos' : 'local', maxVideoSize: config.maxVideoSize })
})

// ---------- 视频列表：分类 / 关键词 / 排序 / 分页 ----------
router.get(
  '/list',
  ah(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1)
    const size = Math.min(50, Math.max(1, parseInt(req.query.size) || 12))
    const category = String(req.query.category || '').trim()
    const keyword = String(req.query.keyword || '').trim()
    const uid = parseInt(req.query.uid) || null
    const sort = String(req.query.sort || 'latest')

    const conds = ['v.status = 1']
    const params = []
    if (category && categories.includes(category)) {
      conds.push('v.category = ?')
      params.push(category)
    }
    if (keyword) {
      conds.push('(v.title LIKE ? OR v.description LIKE ?)')
      const like = `%${keyword}%`
      params.push(like, like)
    }
    if (uid) {
      conds.push('v.uploader_id = ?')
      params.push(uid)
    }
    const order = sort === 'hot' ? 'v.views DESC, v.id DESC' : 'v.created_at DESC, v.id DESC'

    const where = conds.join(' AND ')
    const total = (await db.get(`SELECT COUNT(*) AS c ${BASE_JOIN} WHERE ${where}`, params)).c
    const rows = await db.all(
      `SELECT ${VIDEO_COLUMNS} ${BASE_JOIN} WHERE ${where}
       ORDER BY ${order} LIMIT ? OFFSET ?`,
      [...params, size, (page - 1) * size],
    )

    res.json({
      list: rows.map((v) => publicVideo(v)),
      total,
      page,
      size,
      hasMore: page * size < total,
    })
  }),
)

// ---------- 分类列表 ----------
router.get(
  '/categories',
  ah(async (req, res) => {
    const counts = await db.all(
      'SELECT category, COUNT(*) AS count FROM videos WHERE status = 1 GROUP BY category',
    )
    const countMap = Object.fromEntries(counts.map((c) => [c.category, c.count]))
    res.json({ list: categories.map((c) => ({ name: c, count: countMap[c] || 0 })) })
  }),
)

// ---------- 允许导入的目录（仅管理员，供前端提示） ----------
router.get('/import-roots', requireAdmin, (req, res) => {
  res.json({ dirs: config.import.allowedDirs })
})

// ---------- 预签名直传：返回一个短时有效的 PUT 地址 ----------
router.post(
  '/presign',
  requireAdmin,
  ah(async (req, res) => {
    if (!isCos()) {
      return res.status(409).json({ message: '当前为本地存储模式，请使用 multipart 上传接口' })
    }
    const body = req.body || {}
    const filename = String(body.filename || '')
    const kind = body.kind === 'cover' ? 'cover' : 'video'
    const ext = path.extname(filename).toLowerCase()
    const allowed = kind === 'cover' ? ALLOWED_COVER_EXTS : ALLOWED_VIDEO_EXTS
    if (!allowed.has(ext)) {
      return res.status(400).json({
        message: kind === 'cover' ? '仅支持 jpg/png/webp 封面' : '仅支持视频文件扩展名',
      })
    }
    // 签名有效期按用途区分：封面很小，15 分钟够用；
    // 视频可能到 4GB，慢速网络要传十几到几十分钟，15 分钟会在传一半时过期。
    // 注意：签名 URL 只在上传开始时校验一次，过期时间是 COS 侧的策略，不是请求时限。
    const expires = kind === 'cover' ? 900 : 3600
    const key = buildKey(kind, newUploadName(ext))
    const url = await presignPut(key, { expires })
    res.json({ key, url, publicUrl: publicUrl(key), expiresIn: expires })
  }),
)

// ---------- 直传完成后的入库确认 ----------
router.post(
  '/confirm',
  requireAdmin,
  ah(async (req, res) => {
    const body = req.body || {}
    const key = String(body.key || '')
    if (!isAllowedKey(key, ['video'])) {
      return res.status(400).json({ message: '非法的对象 key' })
    }
    const title = String(body.title || '').trim()
    if (!title) return res.status(400).json({ message: '请填写视频标题' })

    const dup = await db.get('SELECT id FROM videos WHERE filename = ?', [key])
    if (dup) return res.status(409).json({ message: '该视频已入库，请勿重复提交' })

    const cat = categories.includes(body.category) ? body.category : '其他'
    const coverKey = String(body.cover_key || '')
    const cover = isAllowedKey(coverKey, ['cover']) ? publicUrl(coverKey) : ''

    let cid = null
    let ep = 0
    if (body.collection_id) {
      const c = parseInt(body.collection_id, 10)
      if (Number.isInteger(c) && (await db.get('SELECT id FROM collections WHERE id = ?', [c]))) {
        cid = c
        const e = parseInt(body.episode, 10)
        ep = Number.isInteger(e) && e >= 1 ? e : 1
      }
    }

    const duration = Number.isFinite(parseFloat(body.duration))
      ? Math.max(0, parseFloat(body.duration))
      : 0

    const info = await db.run(
      `INSERT INTO videos (title, description, category, filename, cover_url, duration, uploader_id, collection_id, episode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        title.slice(0, 80),
        String(body.description || '').slice(0, 2000),
        cat,
        key,
        cover,
        duration,
        req.user.id,
        cid,
        ep,
      ],
    )
    const video = await getVideo(info.lastInsertRowid)
    res.json({ video: publicVideo(video) })
  }),
)

// ---------- 上传视频（仅管理员，本地磁盘模式） ----------
router.post(
  '/',
  requireAdmin,
  (req, res, next) => {
    if (isCos()) {
      return res.status(409).json({ message: '当前为 COS 模式，请使用 /api/video/presign 直传后 confirm' })
    }
    upload.single('video')(req, res, next)
  },
  ah(async (req, res) => {
    if (!req.file) return res.status(400).json({ message: '未选择视频文件' })
    const ext = path.extname(req.file.filename).toLowerCase()
    if (!checkVideoMagic(req.file.path, ext)) {
      fs.unlink(req.file.path, () => {})
      return res.status(400).json({ message: '文件内容不是有效的视频' })
    }
    const title = String(req.body.title || '').trim()
    if (!title) {
      fs.unlink(req.file.path, () => {})
      return res.status(400).json({ message: '请填写视频标题' })
    }

    const cat = categories.includes(req.body.category) ? req.body.category : '其他'
    const duration = Number.isFinite(parseFloat(req.body.duration))
      ? Math.max(0, parseFloat(req.body.duration))
      : 0
    const info = await db.run(
      `INSERT INTO videos (title, description, category, filename, cover_url, duration, uploader_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        title.slice(0, 80),
        String(req.body.description || '').slice(0, 2000),
        cat,
        `videos/${req.file.filename}`,
        String(req.body.cover_url || ''),
        duration,
        req.user.id,
      ],
    )
    const v = await getVideo(info.lastInsertRowid)
    res.json({ video: publicVideo(v) })
  }),
)

// ---------- 从服务器本机路径导入（仅管理员，仅本地磁盘模式） ----------
router.post(
  '/import-local',
  requireAdmin,
  ah(async (req, res) => {
    if (isCos()) {
      return res.status(501).json({ message: 'COS 部署下不支持从服务器本机路径导入，请直接上传' })
    }
    const body = req.body || {}
    const found = resolveImportPath(body.path)
    if (!found.ok) {
      if (found.code === 'NOT_CONFIGURED') {
        return res.status(400).json({
          message: '尚未配置允许导入的目录，请在 server/.env 设置 IMPORT_ALLOWED_DIRS',
        })
      }
      if (found.code === 'OUTSIDE') {
        return res.status(400).json({ message: '该路径不在允许导入的目录范围内' })
      }
      return res.status(400).json({ message: '路径不存在，或不是一个文件' })
    }

    const ext = path.extname(found.real).toLowerCase()
    if (!ALLOWED_VIDEO_EXTS.has(ext)) {
      return res.status(400).json({ message: '仅支持导入视频文件（mp4/webm/mkv/mov/ogg/avi/ts/flv）' })
    }
    if (found.size > config.maxVideoSize) {
      return res.status(413).json({ message: '文件超过大小限制' })
    }

    const dir = localVideoDir()
    const alreadyUploaded = path.dirname(found.real) === dir
    const filename = alreadyUploaded ? path.basename(found.real) : newUploadName(ext)
    const destPath = path.join(dir, filename)
    const isMove = body.move === true || body.move === 'true' || body.move === 1
    let sourceGone = false

    const rollback = async () => {
      if (alreadyUploaded) return
      if (sourceGone) await fs.promises.rename(destPath, found.real).catch(() => {})
      else await fs.promises.unlink(destPath).catch(() => {})
    }

    try {
      if (!alreadyUploaded) {
        if (isMove) {
          try {
            await fs.promises.rename(found.real, destPath)
            sourceGone = true
          } catch (err) {
            if (err.code !== 'EXDEV') throw err
            await fs.promises.copyFile(found.real, destPath, fs.constants.COPYFILE_EXCL)
          }
        } else {
          await fs.promises.copyFile(found.real, destPath, fs.constants.COPYFILE_EXCL)
        }
      }

      if (!checkVideoMagic(destPath, ext)) {
        await rollback()
        return res.status(400).json({ message: '文件内容不是有效的视频' })
      }

      const title = String(body.title || '').trim() || path.basename(found.real, ext)
      const cat = categories.includes(body.category) ? body.category : '其他'
      let cid = null
      let ep = 0
      if (body.collection_id) {
        const c = parseInt(body.collection_id, 10)
        if (Number.isInteger(c) && (await db.get('SELECT id FROM collections WHERE id = ?', [c]))) {
          cid = c
          const e = parseInt(body.episode, 10)
          ep = Number.isInteger(e) && e >= 1 ? e : 1
        }
      }
      const info = await db.run(
        `INSERT INTO videos (title, description, category, filename, cover_url, duration, uploader_id, collection_id, episode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          title.slice(0, 80),
          String(body.description || '').slice(0, 2000),
          cat,
          `videos/${filename}`,
          String(body.cover_url || ''),
          Number.isFinite(parseFloat(body.duration)) ? Math.max(0, parseFloat(body.duration)) : 0,
          req.user.id,
          cid,
          ep,
        ],
      )
      if (isMove && !sourceGone && !alreadyUploaded) {
        await fs.promises.unlink(found.real).catch(() => {})
      }
      const v = await getVideo(info.lastInsertRowid)
      res.json({ video: publicVideo(v) })
    } catch (err) {
      await rollback()
      res.status(500).json({ message: `导入失败：${err.message}` })
    }
  }),
)

// ---------- 视频详情 ----------
router.get(
  '/:id',
  optionalAuth,
  ah(async (req, res) => {
    const v = await getVideo(req.params.id)
    if (!v) return res.status(404).json({ message: '视频不存在' })

    let liked = false
    let favorited = false
    if (req.user) {
      liked = !!(await db.get('SELECT id FROM video_likes WHERE user_id = ? AND video_id = ?', [
        req.user.id,
        v.id,
      ]))
      favorited = !!(await db.get('SELECT id FROM favorites WHERE user_id = ? AND video_id = ?', [
        req.user.id,
        v.id,
      ]))
    }

    let collection = null
    if (v.collection_id) {
      const col = await db.get('SELECT * FROM collections WHERE id = ?', [v.collection_id])
      if (col) {
        const eps = await collectionEpisodes(col.id)
        collection = {
          id: col.id,
          title: col.title,
          description: col.description,
          cover_url: col.cover_url,
          episode_count: eps.length,
          episodes: eps,
        }
      }
    }

    const relatedRows = await db.all(
      `SELECT ${VIDEO_COLUMNS} ${BASE_JOIN}
       WHERE v.status = 1 AND v.category = ? AND v.id != ?
         AND (v.collection_id IS NULL OR v.collection_id != ?)
       ORDER BY v.views DESC LIMIT 8`,
      [v.category, v.id, v.collection_id || -1],
    )

    res.json({
      video: publicVideo(v, { liked, favorited }),
      related: relatedRows.map((r) => publicVideo(r)),
      collection,
    })
  }),
)

// ---------- 播放：签名校验后 302 到 COS/CDN；本地模式走文件流（Range） ----------
router.get(
  '/:id/stream',
  ah(async (req, res) => {
    const { exp, sig } = req.query
    const expN = parseInt(exp, 10)
    if (
      !/^\d+$/.test(String(exp)) ||
      !/^[0-9a-f]{64}$/i.test(String(sig)) ||
      !expN ||
      expN <= Date.now()
    ) {
      return res.status(403).json({ message: '播放链接无效或已过期' })
    }
    const expected = crypto
      .createHmac('sha256', config.jwtSecret)
      .update(`${req.params.id}:${expN}`)
      .digest('hex')
    const got = Buffer.from(String(sig), 'hex')
    const want = Buffer.from(expected, 'hex')
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
      return res.status(403).json({ message: '播放链接无效或已过期' })
    }

    const v = await db.get('SELECT * FROM videos WHERE id = ? AND status = 1', [req.params.id])
    if (!v) return res.status(404).json({ message: '视频文件不存在' })

    // 外部样例视频（种子数据）直接跳外链
    if (!v.filename) {
      if (v.source_url) return res.redirect(302, v.source_url)
      return res.status(404).json({ message: '视频文件不存在' })
    }
    // 已经是公网地址（历史数据 / 外链）
    if (/^https?:\/\//i.test(v.filename)) {
      return res.redirect(302, v.filename)
    }

    // COS 模式：交给 CDN，Range 由 COS 处理，函数不转发字节
    if (isCos()) {
      const key = v.filename.includes('/') ? v.filename : buildKey('video', v.filename)
      return res.redirect(302, publicUrl(key))
    }

    // 本地磁盘模式
    const filePath = path.join(config.uploadDir, v.filename)
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: '视频文件不存在' })
    }

    const stat = fs.statSync(filePath)
    const fileSize = stat.size
    const range = req.headers.range

    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range)
      let start = m && m[1] ? parseInt(m[1]) : 0
      let end = m && m[2] ? parseInt(m[2]) : fileSize - 1
      if (isNaN(start) || start < 0) start = 0
      if (isNaN(end) || end >= fileSize) end = fileSize - 1
      if (start > end) {
        return res.status(416).json({ message: 'Range 无效' })
      }
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': 'video/mp4',
      })
      fs.createReadStream(filePath, { start, end }).pipe(res)
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Accept-Ranges': 'bytes',
        'Content-Type': 'video/mp4',
      })
      fs.createReadStream(filePath).pipe(res)
    }
  }),
)

// ---------- 删除视频（作者或管理员） ----------
router.delete(
  '/:id',
  requireAuth,
  ah(async (req, res) => {
    const v = await db.get('SELECT * FROM videos WHERE id = ?', [req.params.id])
    if (!v) return res.status(404).json({ message: '视频不存在' })
    const isOwner = v.uploader_id === req.user.id
    const isAdmin = req.user.role === 'admin'
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ message: '没有权限' })
    }

    await db.tx(async (t) => {
      await t.run('DELETE FROM video_likes WHERE video_id = ?', [v.id])
      await t.run('DELETE FROM favorites WHERE video_id = ?', [v.id])
      await t.run('DELETE FROM history WHERE video_id = ?', [v.id])
      await t.run('DELETE FROM comments WHERE video_id = ?', [v.id])
      await t.run('DELETE FROM danmaku WHERE video_id = ?', [v.id])
      await t.run('DELETE FROM videos WHERE id = ?', [v.id])
    })

    // 清理对象存储（失败不影响删除结果）
    if (v.filename && !/^https?:\/\//i.test(v.filename)) {
      const key = v.filename.includes('/') ? v.filename : buildKey('video', v.filename)
      if (isCos()) await deleteObject(key).catch(() => {})
      else if (!v.filename.includes('/')) {
        fs.promises.unlink(path.join(config.uploadDir, v.filename)).catch(() => {})
      }
    }
    if (v.cover_url) {
      const coverKey = v.cover_url.startsWith('http') ? resolveStoredKey(v.cover_url, 'cover') : ''
      if (isCos() && coverKey) await deleteObject(coverKey).catch(() => {})
      if (!isCos() && v.cover_url.startsWith('/uploads/')) {
        fs.promises
          .unlink(path.join(config.uploadDir, v.cover_url.slice('/uploads/'.length)))
          .catch(() => {})
      }
    }
    res.json({ message: '已删除' })
  }),
)

// ---------- 播放量 +1（按 IP+视频 节流；单实例内存即可接受） ----------
const viewedSet = new Map()
router.post(
  '/:id/view',
  ah(async (req, res) => {
    const v = await db.get('SELECT id FROM videos WHERE id = ? AND status = 1', [req.params.id])
    if (!v) return res.status(404).json({ message: '视频不存在' })
    const key = `${req.ip}:${v.id}`
    const now = Date.now()
    const last = viewedSet.get(key) || 0
    if (now - last > 60000) {
      viewedSet.set(key, now)
      await db.run('UPDATE videos SET views = views + 1 WHERE id = ?', [v.id])
    }
    res.json({ ok: true })
  }),
)

export default router
