import path from 'path'
import crypto from 'crypto'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 可选加载 server/.env（仅本地配置，不入库）。已通过环境变量设置的键优先，不覆盖。
try {
  const envFile = path.join(__dirname, '..', '.env')
  if (fs.existsSync(envFile)) {
    for (const raw of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const key = line.slice(0, eq).trim()
      let val = line.slice(eq + 1).trim()
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      if (key && !(key in process.env)) process.env[key] = val
    }
  }
} catch {
  /* .env 读取失败不影响启动 */
}

// JWT 密钥：优先环境变量 JWT_SECRET；否则从 server/.jwt-secret 文件读取，
// 文件不存在则生成一个随机密钥并持久化。绝不使用代码/仓库里写死的明文密钥。
function loadJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET
  const secretFile = path.join(__dirname, '..', '.jwt-secret')
  try {
    if (fs.existsSync(secretFile)) {
      return fs.readFileSync(secretFile, 'utf8').trim()
    }
    const secret = crypto.randomBytes(48).toString('hex')
    fs.writeFileSync(secretFile, secret, { mode: 0o600 })
    console.warn('[config] 未设置 JWT_SECRET，已生成随机密钥保存到 server/.jwt-secret（生产环境请显式设置 JWT_SECRET）')
    return secret
  } catch (e) {
    // 读写失败时用仅内存的随机密钥兜底（重启后所有登录态失效）
    return crypto.randomBytes(48).toString('hex')
  }
}

export const config = {
  port: process.env.PORT || 3000,
  // 默认仅监听回环地址，避免后端 :3000 直接暴露到局域网/公网。
  // 需对外部署时用 HOST=0.0.0.0 覆盖（同时配合反向代理/防火墙）。
  host: process.env.HOST || '127.0.0.1',
  // CORS 允许的浏览器 Origin 白名单：默认只放行本机已知前端源。
  // 用 CORS_ORIGINS（逗号分隔）覆盖，如 CORS_ORIGINS=https://a.vercel.app,https://b.com
  // 前后端分域部署（Vercel 上两个独立项目）时，这里必须带上前端的生产域名。
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .concat(
      process.env.FRONTEND_URL ? [process.env.FRONTEND_URL.replace(/\/+$/, '')] : [],
    )
    .concat([
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:3000',
      'http://127.0.0.1:3000',
    ]),
  jwtSecret: loadJwtSecret(),
  jwtExpires: '7d',
  // server/ 根目录
  root: path.resolve(__dirname, '..'),
  uploadDir: path.resolve(__dirname, '..', 'uploads'),
  // SQLite 库文件。可用 DB_FILE 覆盖 —— 端到端测试要指向一个独立的空库，
  // 否则会往真实曲库里插测试曲目（kg_tracks 是用户「我喜欢」的唯一真相来源）。
  dbFile: process.env.DB_FILE || path.resolve(__dirname, '..', 'data.db'),
  // 数据库连接。线上（Vercel）没有可写磁盘，必须用 Turso（libSQL over HTTPS）；
  // 本地开发默认落到 file: 的 SQLite 文件，零外部依赖。
  //   TURSO_DATABASE_URL=libsql://xxx.turso.io
  //   TURSO_AUTH_TOKEN=xxx
  // 若显式给了 TURSO_DATABASE_URL，本地也会连远端（调试线上库时用）。
  db: {
    url: process.env.TURSO_DATABASE_URL || `file:${process.env.DB_FILE || path.resolve(__dirname, '..', 'data.db')}`,
    authToken: process.env.TURSO_AUTH_TOKEN || '',
  },
  // 对象存储（腾讯云 COS，公有读 + CDN 自定义域名）。
  // driver=cos 时视频/封面/音乐走 COS；driver=local 时退回本机磁盘（仅本地开发）。
  storage: {
    driver: (process.env.STORAGE_DRIVER || 'local').toLowerCase() === 'cos' ? 'cos' : 'local',
    bucket: process.env.COS_BUCKET || '',
    region: process.env.COS_REGION || '',
    secretId: process.env.COS_SECRET_ID || '',
    secretKey: process.env.COS_SECRET_KEY || '',
    // CDN 加速域名（公有读桶的访问域名），如 https://cdn.example.com
    cdnBase: (process.env.COS_CDN_BASE || '').replace(/\/+$/, ''),
    // 桶内路径前缀
    prefix: {
      video: process.env.COS_PREFIX_VIDEO || 'videos',
      cover: process.env.COS_PREFIX_COVER || 'covers',
      avatar: process.env.COS_PREFIX_AVATAR || 'avatars',
      music: process.env.COS_PREFIX_MUSIC || 'music',
    },
  },
  // 上传限制
  // 单文件上限，可用 MAX_VIDEO_SIZE_MB 覆盖（默认 2048，即 2GB）。
  // 注意这只是「允不允许收」，不是「有没有地方放」——磁盘空间不够时，
  // 会在拷贝/写入阶段直接报 ENOSPC，跟这个上限无关。
  maxVideoSize: (Number(process.env.MAX_VIDEO_SIZE_MB) || 2048) * 1024 * 1024,
  maxCoverSize: 10 * 1024 * 1024, // 10MB
  // 本机路径导入（仅管理员的 /api/video/import-local）：允许读取的根目录白名单。
  // 分隔符用系统路径分隔符（Windows 为 ;）——不能用 :，因为盘符里就带冒号。例如：
  //   IMPORT_ALLOWED_DIRS=E:\video-site\musicplayer;D:\movies
  // 留空 = 该功能关闭（接口返回 400 提示去配）；绝不默认放开任意目录，
  // 否则等于给公网开了一个「凭管理员身份读取本机任意视频文件」的口子。
  import: {
    allowedDirs: (process.env.IMPORT_ALLOWED_DIRS || '')
      .split(path.delimiter)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((d) => path.resolve(d)),
  },
  // GitHub 第三方登录（OAuth2 授权码模式）
  github: {
    clientId: process.env.GITHUB_CLIENT_ID || '',
    clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
    // 回调地址需与 GitHub OAuth App 里注册的完全一致
    redirectUri: process.env.GITHUB_REDIRECT_URI || 'http://localhost:3000/api/auth/github/callback',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: process.env.GITHUB_TOKEN_URL || 'https://github.com/login/oauth/access_token',
    userUrl: process.env.GITHUB_USER_URL || 'https://api.github.com/user',
    // 登录成功后回跳的前端地址；空则按 web/dist 是否存在自动推断
    frontendUrl: process.env.GITHUB_FRONTEND_URL || '',
  },
  // 音乐模块：挂载仓库内 musicplayer（yc-musicplayer）为子应用。
  // playerDir 缺失时模块自动跳过，不影响主站。
  music: {
    mountPath: process.env.MUSIC_MOUNT_PATH || '/m',
    // 音乐项目已复制进仓库根：E:\video-site\musicplayer；可用 MUSIC_PLAYER_DIR 覆盖
    playerDir:
      process.env.MUSIC_PLAYER_DIR ||
      path.resolve(__dirname, '..', '..', 'musicplayer'),
    // 音乐文件目录；留空则由 playerDir 推导为 <playerDir>/jays
    musicDir: process.env.MUSIC_DIR || '',
    // KuGouMusicApi 代理地址（酷狗歌单/播放地址的唯一来源）。
    // ⚠️ 它默认也监听 3000，与本后端默认端口相同，必须错开，例如：
    //     cd E:\KuGouMusicApi && PORT=3100 node app.js
    // 又因为 config.port 同样读 PORT —— 千万不要把 PORT 设成全局环境变量，
    // 否则视频站后端会跟着一起被挪走（两个进程抢同一个 PORT）。
    kugouApiBase: process.env.KUGOU_API_BASE || 'http://127.0.0.1:3100',
    // 酷狗音频本地缓存目录（「按需下载」落盘处）。
    // 刻意放在 server/data 下、而不是 musicplayer/ 里：后者是独立 git 仓库且会发布到 npm，
    // 把 GB 级音频写进去，一次 git add . 就可能把受版权内容提交上去。
    kgDir: process.env.MUSIC_KG_DIR || path.resolve(__dirname, '..', 'data', 'kg'),
    // 请求酷狗时的音质档位。实测匿名/普通账号只有 128 可用，320/无损一律 status 2，
    // 所以默认 128；有会员账号时可改高，失败会自动降级。
    kugouQuality: process.env.MUSIC_KUGOU_QUALITY || '128',
  },
  // HTTPS 直出(443)：设置 HTTPS_CERT / HTTPS_KEY 指向证书与私钥文件即可启用。
  // 启用后后端自带 TLS 直接监听 443，一个进程就托管 前端+API+音乐，无需再套 nginx 反代。
  // 也可用 HTTPS_PORT 改端口、HTTPS_HOST 改监听地址。
  // 默认 host '::'：IPv4+IPv6 通吃（Windows 下接受 IPv4 映射）。若外网域名走 AAAA(IPv6)，
  // 只有绑 '::' 才会拒绝而不是连接；绑 '0.0.0.0' 只收 IPv4。
  https: {
    host: process.env.HTTPS_HOST || '::',
    port: Number(process.env.HTTPS_PORT) || 443,
    certPath: process.env.HTTPS_CERT || '',
    keyPath: process.env.HTTPS_KEY || '',
  },
  // MC 认证服（authlib-injector 兼容 Yggdrasil）：把视频站账号体系当作 Minecraft 认证源，
  // 玩家在启动器里 authlib-injector 指向本段 mountPath，用网站用户名+密码登录进你们服务器。
  // 视频站实现了 Yggdrasil 协议端点（authserver/* + sessionserver/*），挂在 mountPath 前缀下。
  mcAuth: {
    // 玩家在 authlib-injector 里填的地址 = 本站域名 + mountPath，如 https://earth-cn.online/mc
    mountPath: process.env.YGGDRASIL_MOUNT_PATH || '/mc',
    // 可选的默认皮肤纹理 URL（玩家未上传皮肤时用）；留空则不返回 textures，玩家显示默认存档皮肤
    defaultSkinUrl: process.env.YGGDRASIL_DEFAULT_SKIN || '',
    // accessToken 有效期（秒），默认 7 天，与站点 JWT 一致
    tokenTtl: Number(process.env.YGGDRASIL_TOKEN_TTL) || 7 * 24 * 3600,
  },
  // 夜场自家 OAuth 授权服务器（oauth-server，本地 4000）第三方登录
  oauthProvider: {
    clientId: process.env.OAUTH_PROVIDER_CLIENT_ID || 'video-site-client',
    clientSecret: process.env.OAUTH_PROVIDER_CLIENT_SECRET || 'video-site-secret-for-local-testing',
    // Provider 基址；回调地址需与 oauth-server 里该应用登记的完全一致
    baseUrl: process.env.OAUTH_PROVIDER_BASE_URL || 'http://localhost:4000',
    redirectUri: process.env.OAUTH_PROVIDER_REDIRECT_URI || 'http://localhost:3000/api/auth/oauth/callback',
    authorizeUrl: process.env.OAUTH_PROVIDER_AUTHORIZE_URL || '', // 空则用 baseUrl 推导
    tokenUrl: process.env.OAUTH_PROVIDER_TOKEN_URL || '',
    userUrl: process.env.OAUTH_PROVIDER_USER_URL || '',
    // 登录成功后回跳的前端地址；空则按 web/dist 是否存在自动推断
    frontendUrl: process.env.OAUTH_PROVIDER_FRONTEND_URL || '',
  },
}

// 视频分类
export const categories = [
  '生活',
  '游戏',
  '科技',
  '音乐',
  '影视',
  '动画',
  '学习',
  '搞笑',
  '运动',
  '其他',
]
