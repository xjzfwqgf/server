// 极简内存限流（无第三方依赖）。进程重启后计数清零——对个人站足够。
const buckets = new Map()

/** 桶太多时顺手清掉过期的（惰性 GC，避免动态路径把 Map 撑爆） */
const MAX_BUCKETS = 5000
function sweep(now) {
  for (const [k, b] of buckets) if (now >= b.resetAt) buckets.delete(k)
}

/**
 * @param {object} opts
 * @param {number}  opts.windowMs     窗口（毫秒）
 * @param {number}  opts.max          窗口内最大请求次数
 * @param {string}  [opts.message]    超限提示
 * @param {Function} [opts.key]       取限流 key，默认按 IP
 * @param {string}  [opts.scope]      分组名，替代 `req.path` 参与计 key
 */
export function rateLimit({
  windowMs,
  max,
  message = '请求过于频繁，请稍后再试',
  key = (req) => req.ip,
  scope = '',
}) {
  return (req, res, next) => {
    // ⚠️ 动态路径必须传 scope。媒体路由是 /stream/<hash>.mp3，若按 req.path 计 key，
    // 每个文件名各自一个桶 —— 换一首歌就重置计数，限流等于不存在。
    // 传 scope:'stream' 后同一 IP 的整条流媒体通道共用一个桶。
    const k = `${key(req)}:${scope || req.path}`
    const now = Date.now()
    let b = buckets.get(k)
    if (!b || now >= b.resetAt) {
      if (buckets.size > MAX_BUCKETS) sweep(now)
      buckets.set(k, { count: 1, resetAt: now + windowMs })
      return next()
    }
    b.count += 1
    if (b.count > max) {
      return res.status(429).json({ message })
    }
    next()
  }
}
