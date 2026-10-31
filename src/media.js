import { execFile } from 'child_process'
import path from 'path'
import fs from 'fs'
import { config } from './config.js'

// 首帧封面目录（uploads/covers，走 /uploads 静态路由）
export const coversDir = path.join(config.uploadDir, 'covers')

// ffprobe 探测视频时长（秒，浮点）。失败返回 null（调用方保持默认值）。
export function probeDuration(filePath, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(
      'ffprobe',
      [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        filePath,
      ],
      { timeout, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null)
        const s = parseFloat(String(stdout).trim())
        resolve(Number.isFinite(s) && s > 0 ? s : null)
      },
    )
  })
}

// 抽取视频首帧存为 JPG 封面，返回相对 URL（/uploads/covers/{id}.jpg）。
// 抽帧失败（编码不支持等）返回 null，调用方保留空封面走前端兜底。
export function generateCover(filePath, id, timeout = 30000) {
  fs.mkdirSync(coversDir, { recursive: true })
  const out = path.join(coversDir, `${id}.jpg`)
  return new Promise((resolve) => {
    execFile(
      'ffmpeg',
      [
        '-y',
        '-ss', '0.1', // 略过极少数文件的纯黑第一帧
        '-i', filePath,
        '-frames:v', '1',
        '-vf', 'scale=640:-2', // 控制体积（网格卡片宽度足够），保持原始宽高比
        '-q:v', '3',
        out,
      ],
      { timeout, windowsHide: true },
      (err) => {
        if (err) return resolve(null)
        resolve(`/uploads/covers/${id}.jpg`)
      },
    )
  })
}
