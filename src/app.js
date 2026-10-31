import express from 'express'
import cors from 'cors'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { config } from './config.js'
import { initDb } from './db.js'
import { isCos } from './storage.js'
import authRoutes from './routes/auth.js'
import videoRoutes from './routes/video.js'
import interactionRoutes from './routes/interaction.js'
import commentRoutes from './routes/comment.js'
import danmakuRoutes from './routes/danmaku.js'
import collectionRoutes from './routes/collection.js'
import adminRoutes from './routes/admin.js'
import yggdrasilRouter from './yggdrasil.js'
import musicApiRoutes from './music/routes.js'

/**
 * 组装 Express 应用（不监听端口）。
 * - 本地：src/index.js 调用后 listen
 * - Vercel：api/index.js 导出同一个 app 作为 Node Function
 */
export async function createApp() {
  await initDb()

  const app = express()
  // Vercel / Nginx 反代后要拿到真实客户端 IP（限流、播放去重都依赖它）
  app.set('trust proxy', 1)
  app.disable('x-powered-by')

  // CORS：仅放行白名单内的 Origin。前端与后端在 Vercel 上是两个域名，
  // 生产环境务必把前端域名配进 CORS_ORIGINS / FRONTEND_URL。
  app.use(
    cors({
      origin(origin, cb) {
        if (!origin || config.corsOrigins.includes(origin)) return cb(null, true)
        return cb(null, false)
      },
    }),
  )

  app.use(express.json({ limit: '2mb' }))

  if (!process.env.VERCEL) {
    app.use((req, res, next) => {
      console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.originalUrl}`)
      next()
    })
  }

  // 本机磁盘模式才托管 /uploads（Vercel 上没有持久磁盘，资源都在 COS）
  if (!isCos()) {
    app.use(
      '/uploads',
      express.static(config.uploadDir, {
        setHeaders(res) {
          res.set('X-Content-Type-Options', 'nosniff')
          res.set('Content-Security-Policy', 'sandbox')
        },
      }),
    )
  }

  app.use('/api/auth', authRoutes)
  app.use('/api/video', videoRoutes)
  app.use('/api/interaction', interactionRoutes)
  app.use('/api/comment', commentRoutes)
  app.use('/api/danmaku', danmakuRoutes)
  app.use('/api/collection', collectionRoutes)
  app.use('/api/admin', adminRoutes)

  // 音乐模块：线上为「只读曲库 + 在线播放」（音频在 COS，或回源酷狗）
  app.use('/api/music', musicApiRoutes)

  app.get('/api/health', (req, res) =>
    res.json({
      ok: true,
      time: new Date().toISOString(),
      storage: isCos() ? 'cos' : 'local',
      db: process.env.TURSO_DATABASE_URL ? 'turso' : 'sqlite',
    }),
  )

  // 本地开发时可选挂载仓库内 musicplayer（线上不挂；前端用自己的播放器垫片）
  if (config.music.playerDir) {
    const playerIndex = path.join(config.music.playerDir, 'index.js')
    if (fs.existsSync(playerIndex)) {
      try {
        const musicDir = config.music.musicDir || path.join(config.music.playerDir, 'jays')
        if (musicDir) process.env.MUSIC_DIR = musicDir
        process.env.MUSIC_JWT_SECRET = config.jwtSecret
        process.env.MUSIC_CORS_ALLOWED = config.corsOrigins.join(',')
        const require = createRequire(import.meta.url)
        const musicApp = require(playerIndex)
        app.use(config.music.mountPath, musicApp)
        console.log(`[music] 音乐模块已挂载: ${config.music.mountPath}`)
      } catch (e) {
        console.warn(`[music] 音乐模块挂载失败，已跳过: ${e.message}`)
      }
    }
  }

  // MC 认证服（authlib-injector 兼容 Yggdrasil）
  if (config.mcAuth.mountPath) {
    app.use(config.mcAuth.mountPath, yggdrasilRouter)
  }

  // 本地生产模式单源：web/dist 存在时由后端一并托管。
  // Vercel 上前端是独立项目，不走这里。
  const webDist = path.resolve(config.root, '..', 'web', 'dist')
  if (!process.env.VERCEL && fs.existsSync(webDist)) {
    app.use(express.static(webDist, { index: false }))
    app.get(/^\/(?!api\/|uploads\/|mc\/).*/, (req, res) => {
      res.sendFile(path.join(webDist, 'index.html'))
    })
  }

  app.use((req, res) => res.status(404).json({ message: '接口不存在' }))

  // 全局错误处理：async 路由里的 reject 也走这里（各路由用 ah() 包装）
  app.use((err, req, res, next) => {
    console.error('[error]', err)
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ message: '文件超过大小限制' })
    }
    res.status(err.status || 500).json({ message: err.message || '服务器内部错误' })
  })

  return app
}
