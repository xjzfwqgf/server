#!/usr/bin/env node
/**
 * 本地 SQLite → Turso(libSQL) 数据搬迁脚本。
 *
 * 用法（在 server/ 目录）：
 *   TURSO_DATABASE_URL=libsql://xxx.turso.io TURSO_AUTH_TOKEN=xxx \
 *   node scripts/migrate-db-to-turso.mjs
 *
 * 说明：
 * - 源库默认是 server/data.db（可用 DB_FILE 覆盖）。
 * - 目标库连接串取 TURSO_DATABASE_URL（必须显式设置，避免误把线上库当本地库清空）。
 * - 会先在目标库建表/跑迁移，再按表整表 INSERT OR REPLACE（可重复执行，幂等）。
 * - 旧库里的时间戳是「本机本地时间」（UTC+8），目标库统一存 UTC；
 *   用 MIGRATE_TZ_OFFSET（默认 8）指定旧数据所在时区，脚本自动换算。
 * - 不动本地源库，只读。
 */
import { DatabaseSync } from 'node:sqlite'
import { config } from '../src/config.js'
import { db as target, initDb, dbKind } from '../src/db.js'

const OFFSET_HOURS = Number(process.env.MIGRATE_TZ_OFFSET ?? 8)
const BATCH = 100

if (!process.env.TURSO_DATABASE_URL) {
  console.error('缺少 TURSO_DATABASE_URL。用法：TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... node scripts/migrate-db-to-turso.mjs')
  process.exit(1)
}
if (dbKind !== 'turso') {
  console.error(`目标库不是 Turso（dbKind=${dbKind}），请检查 TURSO_DATABASE_URL。`)
  process.exit(1)
}

const SRC_FILE = config.dbFile
const src = new DatabaseSync(SRC_FILE)

// 需要做「本地时间 → UTC」换算的时间列
const TIME_COLUMNS = {
  users: ['created_at'],
  videos: ['created_at'],
  video_likes: ['created_at'],
  favorites: ['created_at'],
  history: ['watched_at'],
  comments: ['created_at'],
  danmaku: ['created_at'],
  collections: ['created_at'],
  mc_sessions: ['created_at', 'expires_at'],
  mc_profiles: ['updated_at'],
  kg_session: ['updated_at'],
  kg_tracks: ['synced_at'],
  kg_meta: [],
}

// 先子表后父表无所谓（目标连接未开启外键约束），但保持稳定顺序方便排查
const TABLES = [
  'users',
  'collections',
  'videos',
  'video_likes',
  'favorites',
  'history',
  'comments',
  'danmaku',
  'mc_sessions',
  'mc_profiles',
  'kg_session',
  'kg_tracks',
  'kg_meta',
]

function localToUtc(value) {
  if (!value) return value
  const s = String(value)
  // 已经是 ISO（带 T/Z）就原样保留
  if (/T\d{2}:\d{2}/.test(s)) return s
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(s)
  if (!m) return s
  const sign = OFFSET_HOURS >= 0 ? '+' : '-'
  const abs = Math.abs(OFFSET_HOURS).toString().padStart(2, '0')
  const d = new Date(`${m[1]}T${m[2]}${sign}${abs}:00`)
  if (Number.isNaN(d.getTime())) return s
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

function toValue(v) {
  return typeof v === 'bigint' ? Number(v) : v
}

async function main() {
  console.log(`源库: ${SRC_FILE}`)
  console.log(`目标: ${process.env.TURSO_DATABASE_URL}`)
  console.log(`时间换算偏移: +${OFFSET_HOURS}h（旧数据按 UTC+${OFFSET_HOURS} 解释）\n`)

  await initDb()
  console.log('目标库建表/迁移完成\n')

  for (const table of TABLES) {
    let srcCols
    try {
      srcCols = src.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
    } catch {
      console.log(`- ${table}: 源库没有这张表，跳过`)
      continue
    }
    if (!srcCols.length) {
      console.log(`- ${table}: 源库没有这张表，跳过`)
      continue
    }
    const targetCols = new Set((await target.all(`PRAGMA table_info(${table})`)).map((c) => c.name))
    const cols = srcCols.filter((c) => targetCols.has(c))
    const dropped = srcCols.filter((c) => !targetCols.has(c))
    if (dropped.length) console.log(`  （忽略目标库不存在的旧列：${dropped.join(', ')}）`)

    const rows = src.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM ${table}`).all()
    if (!rows.length) {
      console.log(`- ${table}: 0 行`)
      continue
    }

    const timeCols = new Set(TIME_COLUMNS[table] || [])
    const placeholders = `(${cols.map(() => '?').join(', ')})`
    const sql = `INSERT OR REPLACE INTO ${table} (${cols.map((c) => `"${c}"`).join(', ')}) VALUES ${placeholders}`

    let done = 0
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH)
      await target.tx(async (t) => {
        for (const row of chunk) {
          const values = cols.map((c) =>
            timeCols.has(c) ? localToUtc(toValue(row[c])) : toValue(row[c]),
          )
          await t.run(sql, values)
        }
      })
      done += chunk.length
      process.stdout.write(`\r- ${table}: ${done}/${rows.length}`)
    }
    process.stdout.write('\n')
  }

  // 校验行数
  console.log('\n校验行数：')
  let bad = 0
  for (const table of TABLES) {
    let srcCount = 0
    try {
      srcCount = src.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c
    } catch {
      continue
    }
    const dstCount = Number((await target.get(`SELECT COUNT(*) AS c FROM ${table}`)).c)
    const mark = srcCount === dstCount ? '✓' : '✗'
    if (srcCount !== dstCount) bad++
    console.log(`  ${mark} ${table.padEnd(14)} 源 ${srcCount}  →  目标 ${dstCount}`)
  }

  console.log(bad ? `\n有 ${bad} 张表行数不一致，请检查。` : '\n全部表行数一致，迁移完成。')
  process.exit(bad ? 1 : 0)
}

main().catch((e) => {
  console.error('\n迁移失败：', e)
  process.exit(1)
})
