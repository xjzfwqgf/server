import crypto from 'crypto'
import { config } from './config.js'

// 视频公共查询列与联表（video.js / interaction.js / collection.js 共用）。
// 附带合集归属：collection_id / episode / collection_title。
export const VIDEO_COLUMNS = `
  v.id, v.title, v.description, v.category, v.filename, v.source_url, v.cover_url,
  v.duration, v.uploader_id, v.views, v.likes, v.favorites, v.status, v.created_at,
  v.collection_id, v.episode,
  u.username AS author_name, u.nickname AS author_nick, u.avatar AS author_avatar,
  c.title AS collection_title
`

export const BASE_JOIN = `
  FROM videos v
  JOIN users u ON u.id = v.uploader_id
  LEFT JOIN collections c ON c.id = v.collection_id
`

// 播放地址签名（防盗版）：HMAC(id:exp)，有效期 2 小时。
const STREAM_TTL = 2 * 3600 * 1000
export function signStreamUrl(id) {
  const exp = Date.now() + STREAM_TTL
  const sig = crypto
    .createHmac('sha256', config.jwtSecret)
    .update(`${id}:${exp}`)
    .digest('hex')
  return `/api/video/${id}/stream?exp=${exp}&sig=${sig}`
}

// 播放地址：本地上传文件 -> 签名短时流接口；外部样例 -> 直接外链
export function videoUrl(v) {
  if (v.filename) return signStreamUrl(v.id)
  return v.source_url
}

export function publicVideo(v, extra = {}) {
  return {
    id: v.id,
    title: v.title,
    description: v.description,
    category: v.category,
    cover_url: v.cover_url,
    duration: v.duration,
    views: v.views,
    likes: v.likes,
    favorites: v.favorites,
    created_at: v.created_at,
    url: videoUrl(v),
    collection_id: v.collection_id ?? null,
    episode: v.episode ?? 0,
    collection_title: v.collection_title || null,
    author: {
      id: v.uploader_id,
      name: v.author_name,
      nickname: v.author_nick,
      avatar: v.author_avatar,
    },
    ...extra,
  }
}
