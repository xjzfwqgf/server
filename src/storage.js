import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'

/**
 * 对象存储抽象。
 *
 * - driver=cos：腾讯云 COS 公有读桶 + CDN 自定义域名。浏览器用后端签发的预签名 PUT
 *   直传（绕开 Vercel 4.5MB 请求体上限与函数超时），读走 CDN 公网地址。
 * - driver=local：退回本机磁盘（server/uploads），仅本地开发使用；直传不可用，
 *   前端会走 multipart 上传接口。
 *
 * 所有 key 都是桶内相对路径（如 videos/1712345-ab12cd.mp4），数据库里存 key 或完整 URL。
 */

const s = config.storage

export function isCos() {
  return s.driver === 'cos'
}

export function assertCosConfigured() {
  if (!isCos()) return
  const missing = []
  if (!s.bucket) missing.push('COS_BUCKET')
  if (!s.region) missing.push('COS_REGION')
  if (!s.secretId) missing.push('COS_SECRET_ID')
  if (!s.secretKey) missing.push('COS_SECRET_KEY')
  if (missing.length) {
    throw new Error(`COS 配置缺失：${missing.join(', ')}`)
  }
}

function baseUrl() {
  if (s.cdnBase) return s.cdnBase
  if (s.bucket && s.region) return `https://${s.bucket}.cos.${s.region}.myqcloud.com`
  return ''
}

/** key → 可直接访问的公开 URL（cos 模式走 CDN；local 模式走 /uploads 静态路由） */
export function publicUrl(key) {
  if (!key) return ''
  const str = String(key)
  if (/^(https?:)?\/\//i.test(str) || str.startsWith('/')) return str
  const clean = str.replace(/^\/+/, '')
  if (!isCos()) return `/uploads/${clean.split('/').map(encodeURIComponent).join('/')}`
  const base = baseUrl()
  if (!base) return `/uploads/${clean.split('/').map(encodeURIComponent).join('/')}`
  return `${base}/${clean.split('/').map(encodeURIComponent).join('/')}`
}

let cosClientPromise = null
async function getCos() {
  if (!cosClientPromise) {
    cosClientPromise = import('cos-nodejs-sdk-v5').then((mod) => {
      const COS = mod.default || mod
      return new COS({ SecretId: s.secretId, SecretKey: s.secretKey })
    })
  }
  return cosClientPromise
}

/**
 * 签发一个限制时长的预签名 PUT 地址，浏览器可直接把文件 PUT 到 COS。
 * 不把 Content-Type 签进签名：前端（axios/XHR）可能自动补 charset，签死反而容易 403。
 */
export async function presignPut(key, { expires = 900 } = {}) {
  if (!isCos()) throw new Error('本地存储模式不支持预签名直传')
  assertCosConfigured()
  const cos = await getCos()
  return new Promise((resolve, reject) => {
    cos.getObjectUrl(
      {
        Bucket: s.bucket,
        Region: s.region,
        Key: key,
        Method: 'PUT',
        Sign: true,
        Expires: Math.max(1, Math.floor(expires)),
      },
      (err, data) => (err ? reject(err) : resolve(data.Url)),
    )
  })
}

/** 服务端写入对象（迁移脚本、种子数据用；不经过浏览器） */
export async function putObject(key, body, contentType = 'application/octet-stream') {
  if (!isCos()) {
    const abs = path.join(config.uploadDir, key)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, body)
    return publicUrl(key)
  }
  assertCosConfigured()
  const cos = await getCos()
  await new Promise((resolve, reject) => {
    cos.putObject(
      {
        Bucket: s.bucket,
        Region: s.region,
        Key: key,
        Body: body,
        ContentType: contentType,
      },
      (err) => (err ? reject(err) : resolve()),
    )
  })
  return publicUrl(key)
}

/** 以流的方式上传本地大文件（迁移脚本用；避免把 GB 级视频整个读进内存） */
export async function putFile(key, filePath, contentType = 'application/octet-stream') {
  if (!isCos()) {
    const abs = path.join(config.uploadDir, key)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    await fs.promises.copyFile(filePath, abs)
    return publicUrl(key)
  }
  assertCosConfigured()
  const cos = await getCos()
  const stat = await fs.promises.stat(filePath)
  await new Promise((resolve, reject) => {
    cos.putObject(
      {
        Bucket: s.bucket,
        Region: s.region,
        Key: key,
        Body: fs.createReadStream(filePath),
        ContentLength: stat.size,
        ContentType: contentType,
      },
      (err) => (err ? reject(err) : resolve()),
    )
  })
  return publicUrl(key)
}

/** 删除对象；对象不存在也视为成功（幂等清理） */
export async function deleteObject(key) {
  if (!key) return
  if (!isCos()) {
    const abs = path.join(config.uploadDir, String(key))
    fs.promises.unlink(abs).catch(() => {})
    return
  }
  assertCosConfigured()
  const cos = await getCos()
  await new Promise((resolve) => {
    cos.deleteObject({ Bucket: s.bucket, Region: s.region, Key: String(key) }, () => resolve())
  })
}

/** 校验客户端回传的 key 是否落在我们允许的前缀下，防越权写入任意路径 */
export function isAllowedKey(key, kinds = ['video', 'cover', 'avatar', 'music']) {
  if (typeof key !== 'string' || !key || key.includes('\0') || key.startsWith('/')) return false
  if (key.includes('..')) return false
  return kinds.some((k) => key.startsWith(`${s.prefix[k]}/`))
}

/** 生成桶内 key：<prefix>/<文件名> */
export function buildKey(kind, filename) {
  const prefix = s.prefix[kind]
  if (!prefix) throw new Error(`未知的资源类型：${kind}`)
  return `${prefix}/${filename}`
}

/**
 * 把数据库里的历史值解析成「桶内 key」。
 * - 新数据：filename 直接就是 key（videos/xxx.mp4）或 URL（https://cdn/...）
 * - 老数据：只有裸文件名（xxx.mp4），落在 uploads/ 根目录下
 */
export function resolveStoredKey(value, kind = 'video') {
  if (!value) return ''
  const str = String(value)
  if (/^https?:\/\//i.test(str)) {
    const base = baseUrl()
    if (base && str.startsWith(base + '/')) return decodeURIComponent(str.slice(base.length + 1))
    return ''
  }
  if (str.startsWith('/uploads/')) {
    const rest = decodeURIComponent(str.slice('/uploads/'.length))
    return rest.includes('/') ? rest : buildKey(kind, rest)
  }
  return str.includes('/') ? str : buildKey(kind, str)
}
