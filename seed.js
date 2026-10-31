import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { db, initDb } from './src/db.js'

// 本地示例视频：由 ffmpeg 生成在 uploads/ 下（完全自包含，无需外网）
const SEED_VIDEOS = [
  { title: '彩色信号流 · 01｜本地测试片', desc: 'ffmpeg 生成的本地测试视频，无需外网即可播放。包含丰富的色彩与蜂鸣音效。', category: '动画', sample: 1 },
  { title: '彩条时间 · 02', desc: '标准 SMPTE 彩条测试画面，经典电视信号风格。', category: '影视', sample: 2 },
  { title: '细胞演化 · 03', desc: '康威生命游戏规则的生成艺术，从混沌中演化出秩序。', category: '科技', sample: 3 },
  { title: '暮色渐变 · 04', desc: '深蓝到琥珀金的渐变流动，非常「夜场」。', category: '生活', sample: 4 },
  { title: '翡翠信号流 · 05', desc: '绿色调测试画面，灵动又治愈。', category: '搞笑', sample: 5 },
  { title: 'RGB 原色 · 06', desc: '纯色测试信号，简单而纯粹。', category: '游戏', sample: 6 },
  { title: '高清彩条缩放 · 07', desc: 'SMPTE HD 彩条 + 缓慢推近镜头，张力十足。', category: '影视', sample: 7 },
  { title: '钴蓝信号流 · 08', desc: '冷色调测试画面，深夜观感极佳。', category: '音乐', sample: 8 },
  { title: '生命演算 · 09', desc: '另一种规则的细胞自动机，看看能走出什么图形。', category: '科技', sample: 3 },
  { title: '余晖渐变 · 10', desc: '橙色系渐变流动，像是放映机的暖光。', category: '学习', sample: 4 },
  { title: '晶格跃动 · 11', desc: '高频彩条快节奏闪烁，小心别眨眼。', category: '运动', sample: 2 },
  { title: '午夜蓝调 · 12', desc: '深蓝测试画面，配上一段舒缓蜂鸣。', category: '音乐', sample: 8 },
]

const SEED_DANMAKU = [
  '前方高能预警！',
  '来了来了',
  '爷青回',
  '画质好评',
  '这个转场绝了',
  'UP主好厉害',
  '已三连',
  '弹幕护体',
  '哈哈哈哈哈',
  '学到了学到了',
]

// 解析账号密码：优先环境变量（ADMIN_PASSWORD / DEMO_PASSWORD），否则生成强随机密码并返回打印。
// 不再把弱口令（如 123456）写死在代码里，避免任何环境被默认弱凭据锁死。
function resolvePassword(envKey, label) {
  const fromEnv = envKey ? process.env[envKey] : ''
  if (fromEnv && fromEnv.trim()) {
    return { password: fromEnv.trim(), source: `环境变量 ${envKey}` }
  }
  return { password: crypto.randomBytes(18).toString('base64url'), source: `${label}随机生成` }
}

let seedValue = 42
const rand = (max) => {
  seedValue = (seedValue * 9301 + 49297) % 233280
  return Math.floor((seedValue / 233280) * max)
}

async function seed() {
  await initDb()

  // 清空现有数据（重跑种子会重建演示数据，ID 从 1 开始）
  await db.exec(`
    DELETE FROM danmaku; DELETE FROM comments; DELETE FROM history;
    DELETE FROM favorites; DELETE FROM video_likes; DELETE FROM videos; DELETE FROM collections;
    DELETE FROM users;
    DELETE FROM sqlite_sequence;
  `)

  // 账号密码：环境变量可覆写，否则随机生成（不用弱口令）
  const adminPw = resolvePassword('ADMIN_PASSWORD', '管理员')
  const demoPw = resolvePassword('DEMO_PASSWORD', '演示用户')
  const vloggerPw = resolvePassword('DEMO_PASSWORD', '演示用户')

  // 管理员
  const admin = await db.run(
    "INSERT INTO users (username, password_hash, nickname, role, avatar, bio) VALUES (?, ?, ?, 'admin', ?, ?)",
    ['admin', bcrypt.hashSync(adminPw.password, 10), '管理员', '', '视频网站官方账号'],
  )

  // 演示用户
  const u2 = await db.run(
    'INSERT INTO users (username, password_hash, nickname, avatar, bio) VALUES (?, ?, ?, ?, ?)',
    ['demo', bcrypt.hashSync(demoPw.password, 10), '演示用户', '', '欢迎来到视频站'],
  )
  const u3 = await db.run(
    'INSERT INTO users (username, password_hash, nickname, avatar, bio) VALUES (?, ?, ?, ?, ?)',
    ['vlogger', bcrypt.hashSync(vloggerPw.password, 10), 'Vlogger', '', '记录生活的美好'],
  )

  const userIds = [Number(admin.lastInsertRowid), Number(u2.lastInsertRowid), Number(u3.lastInsertRowid)]

  // 播放量从 100~9800 随机分布，制造“热门”排序
  const videoIds = []
  for (let i = 0; i < SEED_VIDEOS.length; i++) {
    const s = SEED_VIDEOS[i]
    const uploaderId = userIds[i % 3]
    const views = 100 + rand(9700)
    const info = await db.run(
      'INSERT INTO videos (title, description, category, filename, cover_url, duration, uploader_id, views, likes, favorites) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        s.title,
        s.desc,
        s.category,
        `videos/sample-${String(s.sample).padStart(2, '0')}.mp4`,
        `/uploads/cover-${String(s.sample).padStart(2, '0')}.png`,
        42,
        uploaderId,
        views,
        Math.floor(views / 20),
        Math.floor(views / 40),
      ],
    )
    const vid = Number(info.lastInsertRowid)
    videoIds.push(vid)

    // 每个视频配一些弹幕
    const dmCount = 3 + rand(6)
    for (let j = 0; j < dmCount; j++) {
      const uploader = userIds[rand(3)]
      await db.run(
        'INSERT INTO danmaku (video_id, user_id, time, text, color, position) VALUES (?, ?, ?, ?, ?, ?)',
        [
          vid,
          uploader,
          rand(50) + rand(10),
          SEED_DANMAKU[rand(SEED_DANMAKU.length)],
          ['#ffffff', '#ffe066', '#7ee7ff', '#ff7eb3', '#a5ff90'][rand(5)],
          0,
        ],
      )
    }

    // 部分视频加评论
    if (i % 3 === 0) {
      const commenter = [userIds[1], userIds[2]][i % 2]
      const root = await db.run(
        'INSERT INTO comments (video_id, user_id, parent_id, content) VALUES (?, ?, ?, ?)',
        [vid, commenter, null, `这个视频真不错，${s.category}分类的宝藏！`],
      )
      await db.run('INSERT INTO comments (video_id, user_id, parent_id, content) VALUES (?, ?, ?, ?)', [
        vid,
        userIds[0],
        Number(root.lastInsertRowid),
        '感谢支持，欢迎常来~',
      ])
    }

    // 演示用户收藏一些
    if (i % 4 === 0) {
      await db.run('INSERT OR IGNORE INTO favorites (user_id, video_id) VALUES (?, ?)', [userIds[1], vid])
    }
  }

  console.log(`种子数据完成：示例视频 ${videoIds.length} 条`)
  console.log('后端启动命令: npm start  →  http://localhost:3000')
  console.log('==================================================')
  console.log('账号密码（请妥善保管，建议登录后立即修改）：')
  console.log(`  管理员 admin  密码=${adminPw.password}   （${adminPw.source}）`)
  console.log(`  演示   demo   密码=${demoPw.password}   （${demoPw.source}）`)
  console.log(`  演示   vlogger 密码=${vloggerPw.password}   （${vloggerPw.source}）`)
  console.log('==================================================')
}

seed()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
