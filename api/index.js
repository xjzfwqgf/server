import { createApp } from '../src/app.js'

/**
 * Vercel Node Function 入口。
 * vercel.json 把所有路径 rewrite 到这里，由 Express 内部路由分发。
 * 应用初始化（建表/迁移）延迟到首次请求并复用，冷启动只跑一次。
 */
let appPromise = null

function getApp() {
  if (!appPromise) appPromise = createApp()
  return appPromise
}

export default async function handler(req, res) {
  try {
    const app = await getApp()
    return app(req, res)
  } catch (err) {
    console.error('[vercel] 初始化失败', err)
    if (!res.headersSent) {
      res.statusCode = 500
      res.setHeader('content-type', 'application/json; charset=utf-8')
    }
    res.end(JSON.stringify({ message: `服务初始化失败：${err?.message || err}` }))
  }
}
