import { db, initDb } from './src/db.js'

// 一次性幂等脚本：把标题匹配「爱情公寓第N集」的视频归入一个「爱情公寓」合集。
// 可重复运行：已匹配的集数保持不变，只补缺失/修正错配，不会重复创建合集。

const COLLECTION_TITLE = '爱情公寓'
const EP_RE = /爱情公寓第(\d+)集/

async function run() {
  await initDb()

  // 找管理员（合集创建人）；没有管理员就用第一个用户兜底
  let creator = await db.get('SELECT id FROM users WHERE role = ? ORDER BY id LIMIT 1', ['admin'])
  if (!creator) creator = await db.get('SELECT id FROM users ORDER BY id LIMIT 1')
  if (!creator) {
    console.log('数据库里还没有用户，请先启动后端跑一次种子数据（npm run seed）再运行本脚本。')
    process.exit(1)
  }

  // 幂等：按标题复用已有合集
  let collection = await db.get('SELECT id, title FROM collections WHERE title = ? LIMIT 1', [
    COLLECTION_TITLE,
  ])
  if (!collection) {
    const info = await db.run(
      'INSERT INTO collections (title, description, created_by) VALUES (?, ?, ?)',
      [COLLECTION_TITLE, `${COLLECTION_TITLE}全剧合集，按集数排列。`, creator.id],
    )
    collection = { id: Number(info.lastInsertRowid) }
    console.log(`已创建合集「${COLLECTION_TITLE}」(id=${collection.id})`)
  } else {
    console.log(`复用已有合集「${COLLECTION_TITLE}」(id=${collection.id})`)
  }

  // 匹配所有含「爱情公寓第N集」的视频
  const videos = await db.all("SELECT id, title FROM videos WHERE title LIKE '%爱情公寓第%集%' ORDER BY id")

  let assigned = 0
  let changed = 0
  const episodes = new Set()
  for (const v of videos) {
    const m = EP_RE.exec(v.title)
    if (!m) continue
    const ep = parseInt(m[1], 10)
    if (!Number.isInteger(ep) || ep < 1) continue
    const cur = await db.get('SELECT collection_id, episode FROM videos WHERE id = ?', [v.id])
    if (cur.collection_id === collection.id && cur.episode === ep) {
      assigned++ // 已就位，不动
    } else {
      await db.run('UPDATE videos SET collection_id = ?, episode = ? WHERE id = ?', [
        collection.id,
        ep,
        v.id,
      ])
      assigned++
      changed++
    }
    episodes.add(ep)
  }

  console.log(
    `匹配到 ${videos.length} 个视频，已归入合集 ${assigned} 个（本次改动 ${changed} 个），覆盖第 ${
      episodes.size ? Math.min(...episodes) : 0
    }~${episodes.size ? Math.max(...episodes) : 0} 集`,
  )
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
