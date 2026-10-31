import fs from 'node:fs'
import https from 'node:https'
import { config } from './config.js'
import { createApp } from './app.js'

/**
 * 本地 / 自建服务器入口：建表 + 监听端口。
 * Vercel 上由 api/index.js 导出同一个 app，不执行这里的 listen。
 */
const app = await createApp()

const httpsConf = config.https
const httpsReady =
  httpsConf.certPath &&
  httpsConf.keyPath &&
  fs.existsSync(httpsConf.certPath) &&
  fs.existsSync(httpsConf.keyPath)

if (httpsReady) {
  const tls = {
    cert: fs.readFileSync(httpsConf.certPath),
    key: fs.readFileSync(httpsConf.keyPath),
  }
  https.createServer(tls, app).listen(httpsConf.port, httpsConf.host, () => {
    const showHost = httpsConf.host === '::' ? '[::]' : httpsConf.host
    console.log(`视频网站后端已启动(HTTPS): https://${showHost}:${httpsConf.port}`)
  })
} else {
  app.listen(config.port, config.host, () => {
    console.log(`视频网站后端已启动: http://${config.host}:${config.port}`)
  })
}
