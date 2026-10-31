import path from 'node:path'
import fs from 'node:fs'
import { config } from './config.js'

/**
 * 数据库访问层。
 *
 * 线上（Vercel）用 Turso / libSQL（HTTPS 协议，无本地磁盘依赖）；
 * 本地开发默认用 Node 内置 node:sqlite 打开 file: 数据库，零外部依赖。
 * 两种后端暴露完全相同的异步 API，业务代码不需要区分：
 *
 *   await db.get('SELECT ... WHERE id = ?', [id])
 *   await db.all('SELECT ...', [])
 *   const { lastInsertRowid } = await db.run('INSERT ...', [a, b])
 *   await db.exec('PRAGMA ...')            // 单条或多条（executeMultiple / exec）
 *   await db.tx(async (t) => { ... })      // 交互事务，回调里用 t.get / t.run
 */

const DB_URL = config.db.url
export const dbKind = /^(libsql|https?):/i.test(DB_URL) ? 'turso' : 'sqlite'

function toNum(v) {
  if (typeof v === 'bigint') return Number(v)
  return v == null ? 0 : v
}

function normalizeArgs(args) {
  return (args || []).map((v) => {
    if (v === undefined) return null
    if (typeof v === 'boolean') return v ? 1 : 0
    return v
  })
}

// ---------- 本地 SQLite 后端 ----------
async function createLocal() {
  const { DatabaseSync } = await import('node:sqlite')
  const file = DB_URL.replace(/^file:/, '')
  const abs = path.resolve(file)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  const raw = new DatabaseSync(abs)
  raw.exec('PRAGMA journal_mode = WAL')
  raw.exec('PRAGMA foreign_keys = ON')

  const api = {
    kind: 'sqlite',
    async all(sql, args = []) {
      return raw.prepare(sql).all(...normalizeArgs(args))
    },
    async get(sql, args = []) {
      return raw.prepare(sql).get(...normalizeArgs(args))
    },
    async run(sql, args = []) {
      const r = raw.prepare(sql).run(...normalizeArgs(args))
      return { changes: toNum(r.changes), lastInsertRowid: toNum(r.lastInsertRowid) }
    },
    async exec(sql) {
      raw.exec(sql)
    },
    async tx(fn) {
      raw.exec('BEGIN')
      try {
        const out = await fn(api)
        raw.exec('COMMIT')
        return out
      } catch (e) {
        try {
          raw.exec('ROLLBACK')
        } catch {
          /* 回滚失败时保留原始异常 */
        }
        throw e
      }
    },
    raw,
  }
  return api
}

// ---------- Turso / libSQL 后端 ----------
async function createTurso() {
  const { createClient } = await import('@libsql/client')
  const client = createClient({
    url: DB_URL,
    authToken: config.db.authToken || undefined,
  })

  const api = {
    kind: 'turso',
    async all(sql, args = []) {
      const r = await client.execute({ sql, args: normalizeArgs(args) })
      return r.rows
    },
    async get(sql, args = []) {
      const r = await client.execute({ sql, args: normalizeArgs(args) })
      return r.rows[0]
    },
    async run(sql, args = []) {
      const r = await client.execute({ sql, args: normalizeArgs(args) })
      return { changes: toNum(r.rowsAffected), lastInsertRowid: toNum(r.lastInsertRowid) }
    },
    async exec(sql) {
      await client.executeMultiple(sql)
    },
    async tx(fn) {
      const tx = await client.transaction('write')
      const txApi = {
        async all(sql, args = []) {
          const r = await tx.execute({ sql, args: normalizeArgs(args) })
          return r.rows
        },
        async get(sql, args = []) {
          const r = await tx.execute({ sql, args: normalizeArgs(args) })
          return r.rows[0]
        },
        async run(sql, args = []) {
          const r = await tx.execute({ sql, args: normalizeArgs(args) })
          return { changes: toNum(r.rowsAffected), lastInsertRowid: toNum(r.lastInsertRowid) }
        },
        async exec(sql) {
          await tx.executeMultiple(sql)
        },
        tx: null,
      }
      txApi.tx = api.tx
      try {
        const out = await fn(txApi)
        await tx.commit()
        return out
      } catch (e) {
        try {
          await tx.rollback()
        } catch {
          /* 回滚失败时保留原始异常 */
        }
        throw e
      }
    },
    client,
  }
  return api
}

let backendPromise = null
function backend() {
  if (!backendPromise) {
    backendPromise = dbKind === 'turso' ? createTurso() : createLocal()
  }
  return backendPromise
}

/** 统一入口：所有业务代码通过 db.xxx 访问，不直接碰底层驱动 */
export const db = {
  get: async (sql, args) => (await backend()).get(sql, args),
  all: async (sql, args) => (await backend()).all(sql, args),
  run: async (sql, args) => (await backend()).run(sql, args),
  exec: async (sql) => (await backend()).exec(sql),
  tx: async (fn) => (await backend()).tx(fn),
}

// ---------- 建表 ----------
// 时间统一用 UTC（datetime('now')）。Turso 的服务器时区是 UTC，'localtime' 在不同环境下
// 结果不一致；前端按 UTC 解析再转本地时间展示。
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    nickname      TEXT NOT NULL,
    avatar        TEXT DEFAULT '',
    bio           TEXT DEFAULT '',
    role          TEXT NOT NULL DEFAULT 'user',
    status        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS videos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    description TEXT DEFAULT '',
    category    TEXT NOT NULL DEFAULT '其他',
    filename    TEXT DEFAULT NULL,
    source_url  TEXT DEFAULT NULL,
    cover_url   TEXT DEFAULT '',
    duration    REAL DEFAULT 0,
    uploader_id INTEGER NOT NULL,
    views       INTEGER NOT NULL DEFAULT 0,
    likes       INTEGER NOT NULL DEFAULT 0,
    favorites   INTEGER NOT NULL DEFAULT 0,
    status      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (uploader_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS video_likes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    video_id   INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, video_id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (video_id) REFERENCES videos(id)
  );

  CREATE TABLE IF NOT EXISTS favorites (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    video_id   INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, video_id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (video_id) REFERENCES videos(id)
  );

  CREATE TABLE IF NOT EXISTS history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    video_id   INTEGER NOT NULL,
    progress   REAL DEFAULT 0,
    watched_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, video_id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (video_id) REFERENCES videos(id)
  );

  CREATE TABLE IF NOT EXISTS comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id   INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    parent_id  INTEGER DEFAULT NULL,
    content    TEXT NOT NULL,
    likes      INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (video_id) REFERENCES videos(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS danmaku (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id   INTEGER NOT NULL,
    user_id    INTEGER DEFAULT NULL,
    time       REAL NOT NULL,
    text       TEXT NOT NULL,
    color      TEXT NOT NULL DEFAULT '#ffffff',
    position   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (video_id) REFERENCES videos(id)
  );

  CREATE TABLE IF NOT EXISTS collections (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    description TEXT DEFAULT '',
    cover_url   TEXT DEFAULT '',
    created_by  INTEGER NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS mc_sessions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL,
    access_token TEXT NOT NULL UNIQUE,
    client_token TEXT DEFAULT NULL,
    profile_id   TEXT NOT NULL,
    profile_name TEXT NOT NULL,
    server_id    TEXT DEFAULT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at   TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS mc_profiles (
    user_id      INTEGER PRIMARY KEY,
    profile_id   TEXT NOT NULL UNIQUE,
    profile_name TEXT NOT NULL,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS kg_session (
    id                  INTEGER PRIMARY KEY CHECK (id = 1),
    token               TEXT NOT NULL,
    userid              TEXT NOT NULL DEFAULT '',
    nickname            TEXT NOT NULL DEFAULT '',
    liked_playlist_id   TEXT NOT NULL DEFAULT '',
    liked_playlist_name TEXT NOT NULL DEFAULT '',
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS kg_tracks (
    hash           TEXT PRIMARY KEY,
    name           TEXT NOT NULL DEFAULT '',
    artist         TEXT NOT NULL DEFAULT '',
    album          TEXT NOT NULL DEFAULT '',
    duration       INTEGER NOT NULL DEFAULT 0,
    album_id       TEXT NOT NULL DEFAULT '',
    album_audio_id TEXT NOT NULL DEFAULT '',
    cover_url      TEXT NOT NULL DEFAULT '',
    filename       TEXT NOT NULL UNIQUE,
    ext            TEXT NOT NULL DEFAULT 'mp3',
    hash_used      TEXT NOT NULL DEFAULT '',
    quality_used   TEXT NOT NULL DEFAULT '',
    size           INTEGER NOT NULL DEFAULT 0,
    playable       INTEGER NOT NULL DEFAULT 1,
    cover_cached   INTEGER NOT NULL DEFAULT 0,
    lyric_cached   INTEGER NOT NULL DEFAULT 0,
    in_liked       INTEGER NOT NULL DEFAULT 1,
    ord            INTEGER NOT NULL DEFAULT 0,
    cos_url        TEXT NOT NULL DEFAULT '',
    synced_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS kg_meta (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL DEFAULT ''
  );

  CREATE INDEX IF NOT EXISTS idx_videos_category ON videos(category);
  CREATE INDEX IF NOT EXISTS idx_videos_uploader ON videos(uploader_id);
  CREATE INDEX IF NOT EXISTS idx_comments_video ON comments(video_id);
  CREATE INDEX IF NOT EXISTS idx_danmaku_video ON danmaku(video_id, time);
  CREATE INDEX IF NOT EXISTS idx_history_user ON history(user_id);
  CREATE INDEX IF NOT EXISTS idx_mc_sessions_user ON mc_sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_mc_sessions_join ON mc_sessions(server_id, profile_name);
  CREATE INDEX IF NOT EXISTS idx_kg_tracks_liked ON kg_tracks(in_liked, ord);
`

async function addColumnIfMissing(table, column, ddl) {
  const cols = await db.all(`PRAGMA table_info(${table})`)
  if (!cols.some((c) => c.name === column)) {
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
  }
}

async function doInit() {
  await db.exec(SCHEMA)

  // 旧库迁移：第三方登录绑定列
  await addColumnIfMissing('users', 'github_id', 'github_id TEXT DEFAULT NULL')
  await addColumnIfMissing('users', 'oauth_provider_id', 'oauth_provider_id TEXT DEFAULT NULL')
  const userCols = await db.all('PRAGMA table_info(users)')
  if (userCols.some((c) => c.name === 'msl_uid')) {
    try {
      await db.exec('DROP INDEX IF EXISTS idx_users_msl_uid')
      await db.exec('ALTER TABLE users DROP COLUMN msl_uid')
    } catch (e) {
      console.warn('[db] 移除废弃的 msl_uid 列失败（可忽略）：', e.message)
    }
  }
  if (userCols.some((c) => c.name === 'yggdrasil_uuid')) {
    try {
      await db.exec('DROP INDEX IF EXISTS idx_users_yggdrasil_uuid')
      await db.exec('ALTER TABLE users DROP COLUMN yggdrasil_uuid')
    } catch (e) {
      console.warn('[db] 移除废弃的 yggdrasil_uuid 列失败（可忽略）：', e.message)
    }
  }
  await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_github_id ON users(github_id)')
  await db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_oauth_provider_id ON users(oauth_provider_id)',
  )

  // 旧库迁移：合集归属
  await addColumnIfMissing('videos', 'collection_id', 'collection_id INTEGER DEFAULT NULL')
  await addColumnIfMissing('videos', 'episode', 'episode INTEGER DEFAULT 0')
  await db.exec('CREATE INDEX IF NOT EXISTS idx_videos_collection ON videos(collection_id)')

  // 旧库迁移：音乐曲目在 COS 上的公开地址（公有读 + CDN）
  await addColumnIfMissing('kg_tracks', 'cos_url', "cos_url TEXT NOT NULL DEFAULT ''")
}

let initPromise = null
/** 幂等初始化：多个请求并发进来也只建一次表 */
export function initDb() {
  if (!initPromise) initPromise = doInit()
  return initPromise
}
