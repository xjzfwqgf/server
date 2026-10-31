#!/usr/bin/env node
/**
 * 一次性修复：把 COS 上 music/*.mp3 的 Content-Type 从 application/octet-stream
 * 改成 audio/mpeg（首次迁移脚本 ext 没带点导致）。
 *
 * 用 COS 服务端复制（x-cos-copy-source）改元数据，不重传音频本体。
 *
 * 用法（server 目录）：
 *   STORAGE_DRIVER=cos COS_BUCKET=... COS_REGION=... COS_SECRET_ID=... COS_SECRET_KEY=... \
 *   node scripts/fix-music-content-type.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import COS from 'cos-nodejs-sdk-v5'
import { config } from '../src/config.js'

const bucket = process.env.COS_BUCKET
const region = process.env.COS_REGION
const secretId = process.env.COS_SECRET_ID
const secretKey = process.env.COS_SECRET_KEY
const CONCURRENCY = Math.max(1, Number(process.env.MIGRATE_CONCURRENCY) || 6)

if (!bucket || !region || !secretId || !secretKey) {
  console.error('缺少 COS_BUCKET / COS_REGION / COS_SECRET_ID / COS_SECRET_KEY')
  process.exit(1)
}

function mimeOf(ext) {
  switch (String(ext).toLowerCase().replace(/^\./, '')) {
    case 'mp3':
      return 'audio/mpeg'
    case 'flac':
      return 'audio/flac'
    case 'm4a':
      return 'audio/mp4'
    case 'ogg':
      return 'audio/ogg'
    case 'wav':
      return 'audio/wav'
    default:
      return 'application/octet-stream'
  }
}

const cos = new COS({ SecretId: secretId, SecretKey: secretKey })
const db = new DatabaseSync(config.dbFile)
const rows = db
  .prepare("SELECT filename, ext FROM kg_tracks WHERE cos_url != ''")
  .all()
  .map((r) => ({ ...r }))

console.log(`待修元数据：${rows.length} 首`)

let done = 0
let ok = 0
let fail = 0

function copyOne(row) {
  const key = `music/${row.filename}`
  const copySource = `${bucket}.cos.${region}.myqcloud.com/music/${encodeURIComponent(row.filename)}`
  return new Promise((resolve) => {
    cos.putObjectCopy(
      {
        Bucket: bucket,
        Region: region,
        Key: key,
        CopySource: copySource,
        MetadataDirective: 'Replaced',
        ContentType: mimeOf(row.ext || row.filename),
      },
      (err) => {
        if (err) {
          fail++
          console.error(`\n✗ ${row.filename}: ${err.message}`)
        } else {
          ok++
        }
        resolve()
      },
    )
  })
}

let cursor = 0
async function worker() {
  while (true) {
    const idx = cursor++
    if (idx >= rows.length) return
    await copyOne(rows[idx])
    done++
    if (done % 50 === 0 || done === rows.length) {
      process.stdout.write(`\r进度 ${done}/${rows.length}  成功 ${ok}  失败 ${fail}`)
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker))
console.log(`\n完成：成功 ${ok}，失败 ${fail}`)
process.exit(fail ? 1 : 0)
