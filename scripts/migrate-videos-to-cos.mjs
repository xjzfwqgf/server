#!/usr/bin/env node
/**
 * 把 server/uploads 里的历史视频/封面迁移到腾讯云 COS，并回填数据库路径。
 *
 * 用法（在 server/ 目录）：
 *   STORAGE_DRIVER=cos COS_BUCKET=... COS_REGION=... COS_SECRET_ID=... COS_SECRET_KEY=... \
 *   COS_CDN_BASE=https://cdn.example.com \
 *   node scripts/migrate-videos-to-cos.mjs
 *
 * 可选：
 *   --dry-run            只列出将要上传的文件，不实际上传/改库
 *   --limit=100          只迁移前 N 条（分批搬迁用）
 *   MIGRATE_CONCURRENCY  并发数（默认 2，视频较大）
 *   TURSO_DATABASE_URL   设置后同时回写线上 Turso 库
 *
 * 产物布局：
 *   videos/<filename>   视频文件
 *   covers/<filename>   封面图
 */
import path from 'node:path'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { config } from '../src/config.js'
import { isCos, putFile, publicUrl } from '../src/storage.js'

const DRY_RUN = process.argv.includes('--dry-run')
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || 0
const CONCURRENCY = Math.max(1, Number(process.env.MIGRATE_CONCURRENCY) || 2)

function mimeOf(file) {
  const ext = path.extname(file).toLowerCase()
  switch (ext) {
    case '.mp4':
      return 'video/mp4'
    case '.webm':
      return 'video/webm'
    case '.mkv':
      return 'video/x-matroska'
    case '.mov':
      return 'video/quicktime'
    case '.ogg':
      return 'video/ogg'
    case '.avi':
      return 'video/x-msvideo'
    case '.ts':
      return 'video/mp2t'
    case '.flv':
      return 'video/x-flv'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.png':
      return 'image/png'
    case '.webp':
      return 'image/webp'
    default:
      return 'application/octet-stream'
  }
}

async function pool(items, limit, worker) {
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (true) {
      const idx = cursor++
      if (idx >= items.length) return
      await worker(items[idx], idx)
    }
  })
  await Promise.all(runners)
}

async function main() {
  if (!isCos() && !DRY_RUN) {
    console.error(
      '当前不是 COS 模式。请设置 STORAGE_DRIVER=cos 以及 COS_BUCKET / COS_REGION / COS_SECRET_ID / COS_SECRET_KEY。',
    )
    process.exit(1)
  }

  const uploadDir = config.uploadDir
  if (!fs.existsSync(uploadDir)) {
    console.error(`上传目录不存在：${uploadDir}`)
    process.exit(1)
  }

  const src = new DatabaseSync(config.dbFile)
  let rows = src
    .prepare(
      "SELECT id, title, filename, cover_url FROM videos WHERE filename IS NOT NULL AND filename != '' ORDER BY id",
    )
    .all()
    .map((r) => ({ ...r }))
    .filter((v) => !/^https?:\/\//.test(v.filename) && !v.filename.startsWith('videos/'))
  if (LIMIT > 0) rows = rows.slice(0, LIMIT)

  if (!rows.length) {
    console.log('没有需要迁移的视频（已是 COS key 或外链）。')
    process.exit(0)
  }

  let turso = null
  if (process.env.TURSO_DATABASE_URL && !DRY_RUN) {
    const mod = await import('../src/db.js')
    await mod.initDb()
    turso = mod.db
    console.log('已连接 Turso，将同步回写 videos.filename / cover_url')
  }

  console.log(`待迁移视频 ${rows.length} 条${DRY_RUN ? '（dry-run，不会写入）' : ''}`)

  const stats = { videos: 0, covers: 0, missing: 0, failed: 0, bytes: 0 }
  let done = 0

  await pool(rows, CONCURRENCY, async (v) => {
    done++
    try {
      const localPath = path.join(uploadDir, v.filename)
      if (!fs.existsSync(localPath)) {
        stats.missing++
        console.warn(`\n- #${v.id} 本地文件缺失，跳过：${v.filename}`)
        return
      }
      const key = `videos/${path.basename(v.filename)}`
      const size = fs.statSync(localPath).size
      stats.bytes += size

      if (DRY_RUN) {
        console.log(`[dry] #${v.id} ${v.filename} → ${key}（${(size / 1024 / 1024).toFixed(1)} MB）`)
        return
      }

      await putFile(key, localPath, mimeOf(localPath))
      await src.prepare('UPDATE videos SET filename = ? WHERE id = ?').run(key, v.id)
      if (turso) await turso.run('UPDATE videos SET filename = ? WHERE id = ?', [key, v.id])
      stats.videos++

      // 封面：/uploads/covers/x.jpg 或 /uploads/cover-01.png
      const cover = String(v.cover_url || '')
      if (cover.startsWith('/uploads/') && !cover.startsWith('/uploads/http')) {
        const rel = cover.slice('/uploads/'.length)
        const coverPath = path.join(uploadDir, rel)
        if (fs.existsSync(coverPath)) {
          const coverKey = `covers/${path.basename(rel)}`
          await putFile(coverKey, coverPath, mimeOf(coverPath))
          const url = publicUrl(coverKey)
          await src.prepare('UPDATE videos SET cover_url = ? WHERE id = ?').run(url, v.id)
          if (turso) await turso.run('UPDATE videos SET cover_url = ? WHERE id = ?', [url, v.id])
          stats.covers++
        }
      }
    } catch (e) {
      stats.failed++
      console.error(`\n✗ #${v.id} 迁移失败：${e.message}`)
    }
    if (done % 5 === 0 || done === rows.length) {
      process.stdout.write(
        `\r进度 ${done}/${rows.length}  视频 ${stats.videos}  封面 ${stats.covers}  缺失 ${stats.missing}  失败 ${stats.failed}  已传 ${(stats.bytes / 1024 / 1024 / 1024).toFixed(2)} GB`,
      )
    }
  })

  console.log('\n')
  console.log('视频迁移完成：')
  console.log(`  视频 ${stats.videos}，封面 ${stats.covers}，缺文件 ${stats.missing}，失败 ${stats.failed}`)
  console.log(`  累计大小 ${(stats.bytes / 1024 / 1024 / 1024).toFixed(2)} GB`)
  process.exit(stats.failed ? 1 : 0)
}

main().catch((e) => {
  console.error('\n迁移失败：', e)
  process.exit(1)
})
