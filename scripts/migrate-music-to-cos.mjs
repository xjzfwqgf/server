#!/usr/bin/env node
/**
 * 把本地音乐缓存（server/data/kg）迁移到腾讯云 COS。
 *
 * 用法（在 server/ 目录）：
 *   STORAGE_DRIVER=cos COS_BUCKET=... COS_REGION=... COS_SECRET_ID=... COS_SECRET_KEY=... \
 *   COS_CDN_BASE=https://cdn.example.com \
 *   node scripts/migrate-music-to-cos.mjs
 *
 * 可选：
 *   --force              已迁移过的曲目也重新上传
 *   MIGRATE_CONCURRENCY  并发数（默认 4）
 *   TURSO_DATABASE_URL   设置后同时回写线上 Turso 库的 kg_tracks.cos_url
 *
 * 产物布局（与音乐模块读取约定一致）：
 *   music/<filename>            音频
 *   music/covers/<hash>.<ext>   封面
 *   music/<hash>.lrc            歌词
 */
import path from 'node:path'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { config } from '../src/config.js'
import { isCos, putFile, putObject, publicUrl } from '../src/storage.js'

const FORCE = process.argv.includes('--force')
const CONCURRENCY = Math.max(1, Number(process.env.MIGRATE_CONCURRENCY) || 4)

function mimeOf(ext) {
  switch (String(ext).toLowerCase()) {
    case '.mp3':
      return 'audio/mpeg'
    case '.flac':
      return 'audio/flac'
    case '.m4a':
      return 'audio/mp4'
    case '.ogg':
      return 'audio/ogg'
    case '.wav':
      return 'audio/wav'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.png':
      return 'image/png'
    case '.webp':
      return 'image/webp'
    case '.lrc':
    case '.txt':
      return 'text/plain; charset=utf-8'
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

/**
 * 跨国链路（国内 → 东京）偶发 TCP 超时：Turso 的每次请求都是独立的 HTTPS，
 * 一次偶发失败不该让整批迁移挂掉，所以对连接与写库做有限重试。
 */
async function retry(fn, { attempts = 3, delayMs = 1200, label = '操作' } = {}) {
  let lastErr
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      if (i < attempts) {
        const wait = delayMs * i
        process.stderr.write(`\n[retry] ${label} 第 ${i} 次失败（${e.code || e.message}），${wait}ms 后重试\n`)
        await new Promise((r) => setTimeout(r, wait))
      }
    }
  }
  throw lastErr
}

async function main() {
  if (!isCos()) {
    console.error(
      '当前不是 COS 模式。请设置 STORAGE_DRIVER=cos 以及 COS_BUCKET / COS_REGION / COS_SECRET_ID / COS_SECRET_KEY。',
    )
    process.exit(1)
  }

  const kgDir = config.music.kgDir
  if (!fs.existsSync(kgDir)) {
    console.error(`音乐缓存目录不存在：${kgDir}`)
    process.exit(1)
  }

  // 预检：先传一个 30 字节的小对象验证密钥/桶/权限。
  // 否则密钥错了要等 1400 多首挨个失败、每条还各重试一次，白烧半小时。
  try {
    await retry(
      () => putObject('music/.preflight', Buffer.from('ok', 'utf8'), 'text/plain; charset=utf-8'),
      { attempts: 2, delayMs: 800, label: 'COS 预检' },
    )
    console.log('COS 预检通过（密钥 / 桶 / 写权限都正常）\n')
  } catch (e) {
    console.error(`\nCOS 预检失败：${e.message}`)
    if (/Access Key Id/i.test(e.message)) {
      console.error(
        '→ SecretId 不存在。逐项排查：\n' +
          '   1) COS_SECRET_ID 里是不是把 SecretKey 填进去了（SecretId 以 AKID 开头、36 位）\n' +
          '   2) 是不是还留着 "AKID..." 这种占位符没换\n' +
          '   3) 子账号密钥是否已被删除/禁用（控制台 → 访问管理 → API 密钥管理）\n' +
          '   4) 复制时有没有带前后空格/换行',
      )
    } else if (/SignatureDoesNotMatch/i.test(e.message)) {
      console.error('→ 签名不匹配：SecretKey 不对（少字符、多空格，或和 SecretId 不是同一对密钥）。')
    } else if (/AccessDenied/i.test(e.message)) {
      console.error('→ 权限不足：该密钥没有这个桶的 PutObject 权限，给子账号授 cos:PutObject。')
    } else if (/NoSuchBucket/i.test(e.message)) {
      console.error('→ 桶不存在：COS_BUCKET 要带 APPID，如 dfg-1318639785。')
    }
    process.exit(1)
  }

  const src = new DatabaseSync(config.dbFile)
  const tracks = src
    .prepare('SELECT hash, filename, ext, cos_url FROM kg_tracks')
    .all()
    .map((r) => ({ ...r }))

  if (!tracks.length) {
    console.error('kg_tracks 里没有曲目记录，先运行同步再迁移。')
    process.exit(1)
  }

  // 可选：同步回写线上 Turso
  let turso = null
  if (process.env.TURSO_DATABASE_URL) {
    const mod = await import('../src/db.js')
    await retry(() => mod.initDb(), { label: '连接 Turso 并建表' })
    turso = mod.db
    console.log('已连接 Turso，将同步回写 kg_tracks.cos_url')
  } else {
    console.log('未设置 TURSO_DATABASE_URL：只回写本地库（线上库需要另外迁移一次）')
  }

  /** 把本地已迁移的 cos_url 回写线上库（重试用短退避，单条失败不拖垮整批） */
  const syncTurso = async (hash, url) => {
    if (!turso) return
    await retry(() => turso.run('UPDATE kg_tracks SET cos_url = ? WHERE hash = ?', [url, hash]), {
      attempts: 3,
      delayMs: 800,
      label: `回写 ${hash.slice(0, 8)}`,
    })
  }

  const stats = { uploaded: 0, skipped: 0, missing: 0, covers: 0, lyrics: 0, failed: 0 }
  let done = 0

  await pool(tracks, CONCURRENCY, async (t) => {
    done++
    try {
      if (t.cos_url && !FORCE) {
        stats.skipped++
        // 本地已迁过、但线上库可能还没回填（例如上一轮没连 Turso）——补一次
        await syncTurso(t.hash, t.cos_url)
      } else {
        const audioPath = path.join(kgDir, t.filename)
        if (!fs.existsSync(audioPath)) {
          stats.missing++
        } else {
          const key = `music/${t.filename}`
          // kg_tracks.ext 存的是不带点的扩展名（mp3），mimeOf 认的是带点的，这里统一
          const extDot = t.ext
            ? `.${String(t.ext).replace(/^\./, '')}`
            : path.extname(t.filename)
          const url = await retry(() => putFile(key, audioPath, mimeOf(extDot)), {
            attempts: 2,
            delayMs: 1000,
            label: `上传 ${t.filename}`,
          })
          await src.prepare('UPDATE kg_tracks SET cos_url = ? WHERE hash = ?').run(url, t.hash)
          await syncTurso(t.hash, url)
          stats.uploaded++
        }
      }

      // 封面：music/covers/<hash>.<ext>
      for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) {
        const coverPath = path.join(kgDir, 'covers', `${t.hash}${ext}`)
        if (fs.existsSync(coverPath)) {
          await putFile(`music/covers/${t.hash}${ext}`, coverPath, mimeOf(ext))
          stats.covers++
          break
        }
      }

      // 歌词：music/<hash>.lrc
      const lrcPath = path.join(kgDir, `${t.hash}.lrc`)
      if (fs.existsSync(lrcPath)) {
        await putFile(`music/${t.hash}.lrc`, lrcPath, 'text/plain; charset=utf-8')
        stats.lyrics++
      }
    } catch (e) {
      stats.failed++
      console.error(`\n✗ ${t.hash} 迁移失败：${e.message}`)
    }
    if (done % 25 === 0 || done === tracks.length) {
      process.stdout.write(
        `\r进度 ${done}/${tracks.length}  音频 ${stats.uploaded}  跳过 ${stats.skipped}  缺失 ${stats.missing}  封面 ${stats.covers}  歌词 ${stats.lyrics}  失败 ${stats.failed}`,
      )
    }
  })

  console.log('\n')
  console.log('音乐迁移完成：')
  console.log(`  音频上传 ${stats.uploaded}，已存在跳过 ${stats.skipped}，本地缺文件 ${stats.missing}`)
  console.log(`  封面上传 ${stats.covers}，歌词上传 ${stats.lyrics}，失败 ${stats.failed}`)
  if (stats.uploaded > 0) {
    const sample = tracks.find((t) => t.cos_url)
    if (sample) console.log(`  示例地址：${publicUrl(`music/${sample.filename}`)}`)
  }
  process.exit(stats.failed ? 1 : 0)
}

main().catch((e) => {
  console.error('\n迁移失败：', e)
  process.exit(1)
})
