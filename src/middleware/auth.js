import jwt from 'jsonwebtoken'
import { config } from '../config.js'
import { db } from '../db.js'

export function signToken(user) {
  return jwt.sign({ id: user.id, role: user.role }, config.jwtSecret, {
    expiresIn: config.jwtExpires,
  })
}

// 可选认证：有 token 就解析并注入 req.user，无 token 不报错。
// DB 访问是异步的（Turso / node:sqlite 统一走 async API），这里手工串起回调链。
export function optionalAuth(req, res, next) {
  const auth = req.headers.authorization
  if (!auth || !auth.startsWith('Bearer ')) return next()

  ;(async () => {
    try {
      const payload = jwt.verify(auth.slice(7), config.jwtSecret)
      const user = await db.get(
        'SELECT id, username, nickname, avatar, bio, role, status FROM users WHERE id = ?',
        [payload.id],
      )
      if (user && user.status === 1) req.user = user
    } catch {
      // token 无效则视为未登录
    }
    next()
  })().catch(next)
}

export function requireAuth(req, res, next) {
  optionalAuth(req, res, () => {
    if (!req.user) {
      return res.status(401).json({ message: '请先登录' })
    }
    next()
  })
}

export function requireAdmin(req, res, next) {
  optionalAuth(req, res, () => {
    if (!req.user) {
      return res.status(401).json({ message: '请先登录' })
    }
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: '需要管理员权限' })
    }
    next()
  })
}
