// 重置管理员(admin)密码，仅改动该账号的 password_hash，不碰任何其它数据。
// 用法：
//   PowerShell:  $env:ADMIN_PASSWORD='新密码'; node reset-admin-password.js
//   bash:        ADMIN_PASSWORD='新密码' node reset-admin-password.js
// 也支持直接传参：node reset-admin-password.js 新密码
// 运行：npm run reset-admin-pw
import bcrypt from 'bcryptjs'
import { db, initDb } from './src/db.js'

await initDb()

const pw = (process.env.ADMIN_PASSWORD || process.argv[2] || '').trim()

if (!pw) {
  console.error('未提供新密码。请用 ADMIN_PASSWORD 环境变量或命令行参数传入。')
  process.exit(1)
}
if (pw.length < 8) {
  console.error('密码太短（至少 8 位），已中止。')
  process.exit(1)
}

const res = await db.run('UPDATE users SET password_hash = ? WHERE username = ?', [
  bcrypt.hashSync(pw, 10),
  'admin',
])

if (res.changes) {
  console.log('管理员 admin 密码已重置。')
} else {
  console.error('未找到 username=admin 的账号，未做任何修改。')
  process.exit(1)
}
process.exit(0)
