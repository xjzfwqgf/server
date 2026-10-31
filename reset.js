// 清空所有内容数据（视频/评论/弹幕/点赞/收藏/历史），仅保留管理员账号。
// 用于上线前清理演示数据。运行：npm run reset
import { db, initDb } from './src/db.js'

await initDb()

await db.exec(`
  DELETE FROM danmaku;
  DELETE FROM comments;
  DELETE FROM history;
  DELETE FROM favorites;
  DELETE FROM video_likes;
  DELETE FROM videos;
  DELETE FROM collections;
  DELETE FROM users WHERE role != 'admin';
  DELETE FROM sqlite_sequence;
`)

const admins = await db.all("SELECT id, username, nickname FROM users WHERE role = 'admin'")
console.log('已清空全部内容数据')
if (admins.length) {
  console.log(`保留管理员: ${admins.map((a) => `${a.nickname}(${a.username})`).join(', ')}`)
} else {
  console.log('注意：当前没有任何管理员账号')
}
process.exit(0)
