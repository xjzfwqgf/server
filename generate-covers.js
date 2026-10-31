// 一次性回填：为 cover_url 为空 / duration=0 的现有视频生成首帧封面并探测时长。
// 只新增封面文件 + 更新空字段，绝不删除任何数据。
// 用法：cd server && node generate-covers.js
// 说明：依赖本机 ffmpeg 与 uploads/ 里的本地文件，仅适用于「本地磁盘模式」。
import path from 'node:path'
import fs from 'node:fs'
import { db, initDb } from './src/db.js'
import { config } from './src/config.js'
import { isCos } from './src/storage.js'
import { generateCover, probeDuration } from './src/media.js'

await initDb()

if (isCos()) {
  console.error(
    '当前是 COS 存储模式：本地没有视频文件，无法用 ffmpeg 抽帧。\n' +
      '封面改为浏览器上传时自动生成；如需回填历史视频，请先把视频文件拉回本机并设置 STORAGE_DRIVER=local。',
  )
  process.exit(1)
}

const rows = await db.all(
  "SELECT id, title, filename, cover_url, duration FROM videos WHERE filename IS NOT NULL AND (cover_url = '' OR duration = 0)",
)

console.log(`待处理 ${rows.length} 条视频…`)
let ok = 0
let fail = 0

for (const v of rows) {
  const filePath = path.join(config.uploadDir, v.filename)
  if (!fs.existsSync(filePath)) {
    fail++
    console.log(`✗ #${v.id} ${v.title} 文件缺失，跳过`)
    continue
  }
  let cover = v.cover_url
  if (!cover) {
    cover = (await generateCover(filePath, v.id).catch(() => null)) || ''
  }
  const duration = (await probeDuration(filePath).catch(() => null)) ?? 0
  await db.run('UPDATE videos SET cover_url = ?, duration = ? WHERE id = ?', [cover, duration, v.id])
  ok++
  const dur = duration ? `${Math.round(duration)}s` : '0s'
  console.log(`✓ #${v.id} ${v.title} cover=${cover || '(失败，保留占位)'} duration=${dur}`)
}

console.log(`\n完成：成功 ${ok}，失败 ${fail}`)
process.exit(0)
