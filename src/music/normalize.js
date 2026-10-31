/**
 * 酷狗响应归一化层。
 *
 * 移植自 E:\mic\src\api\normalize.js（那边是对着真实 KuGouMusicApi 逐接口实测出来的）。
 * 唯一改动：把 Vite 专用的 `import.meta.env.DEV` 换成 `process.env.NODE_ENV`。
 *
 * 实测结论：**同一个"歌曲"概念在不同接口下字段名完全不同**，至少四套并存：
 *
 *   /rank/audio          → data.songlist[]   歌名 songname    hash 在 audio_info.hash_128
 *   /artist/audios       → data[]            歌名 audio_name  hash 平铺在顶层
 *   /playlist/track/all  → data.songs[]      歌名 name        时长字段叫 timelen
 *   /everyday/recommend  → data.song_list[]  歌名 songname
 *
 * 所以所有取值都走「候选列表」逐字段兜底，且**永不抛错**——字段缺失时返回带默认值的
 * 对象，只在非生产环境下 warn，便于快速定位真实字段。
 */

const DEV = process.env.NODE_ENV !== 'production';

const HASH_RE = /^[0-9a-f]{32}$/i;

/** 非生产环境下提示缺失字段，避免静默出错 */
function warnMissing(context, field, raw) {
  if (DEV) {
    console.warn(`[music/normalize] ${context} 缺少字段「${field}」，原始键:`, Object.keys(raw || {}).join(', '));
  }
}

/** 按候选路径取值。支持 'a.b' 形式，返回第一个非空值 */
export function pick(obj, keys) {
  for (const k of keys) {
    const v = k.split('.').reduce((o, part) => (o == null ? undefined : o[part]), obj);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function pickStr(obj, keys) {
  const v = pick(obj, keys);
  return v === undefined ? '' : String(v);
}

function pickNum(obj, keys, fallback = 0) {
  const v = pick(obj, keys);
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 时长统一转秒。
 *
 * ⚠️ 实测**各接口的单位并不一致**（这点与直觉相反，踩过坑）：
 *   /rank/audio          → audio_info.duration_128 = 197000  （毫秒）
 *   /artist/audios       → timelength = 329000               （毫秒）
 *   /everyday/recommend  → time_length = 147                 （秒！）
 *
 * 单看字段名无法可靠区分（`timelength_320` 在每日推荐里是秒，而 `timelength_128`
 * 在 audio_info 里是毫秒），所以默认走**量级判断**：歌曲毫秒值必定 ≥ 60000
 * （1 分钟），秒值必定 ≤ 3600（1 小时），二者在 10000 处有干净的分界，不会误判。
 * 已知单位的字段直接显式指定，避免依赖启发式。
 *
 * @param {number|string} v
 * @param {'ms'|'s'} [unit] 已知单位时传入，跳过启发式
 */
export function toSeconds(v, unit) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (unit === 'ms') return Math.round(n / 1000);
  if (unit === 's') return Math.round(n);
  return n >= 10000 ? Math.round(n / 1000) : Math.round(n);
}

export function formatDuration(sec) {
  if (!sec) return '--:--';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * 封面 URL 规整。
 * 实测封面形如 http://imge.kugou.com/stdmusic/{size}/xxx.jpg，**含 {size} 占位符**，必须替换。
 * 同时把 http 升到 https，避免混合内容告警。
 */
export function normalizeCover(url, size = 240) {
  if (!url) return '';
  let u = String(url).replace('{size}', String(size));
  if (u.startsWith('//')) u = 'https:' + u;
  else if (u.startsWith('http://')) u = 'https://' + u.slice(7);
  return u;
}

/** 从字符串里提取 32 位 hash */
function asHash(v) {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  return HASH_RE.test(t) ? t.toLowerCase() : '';
}

/** 歌手：可能是字符串、对象数组、或顿号分隔的字符串 */
function normalizeSingers(raw) {
  const list = pick(raw, ['singerinfo', 'authors', 'singers']);

  if (Array.isArray(list) && list.length) {
    const singers = list
      .map((s) => {
        if (typeof s === 'string') return { id: '', name: s };
        return {
          id: String(pick(s, ['id', 'author_id', 'singerid', 'singer_id']) ?? ''),
          name: String(pick(s, ['name', 'author_name', 'singername', 'singer_name']) ?? ''),
        };
      })
      .filter((s) => s.name);
    if (singers.length) return singers;
  }

  // 兜底：顶层歌手名字符串。实测 author_name 形如 "肖战"、"任嘉伦、欧豪、王栎鑫"
  const text = pickStr(raw, ['author_name', 'singername', 'singer_name', 'singer']);
  if (!text) return [];
  return text
    .split(/[、,，/&]/)
    .map((n) => n.trim())
    .filter(Boolean)
    .map((name) => ({ id: '', name }));
}

/**
 * 把任意一种歌曲结构归一成统一模型。
 *
 * @returns {{
 *   id, hash, hashes, name, singers, singerText, album, albumId,
 *   duration, cover, audioId, albumAudioId, privilege, filesize, extname, bitrate, raw
 * }}
 */
export function normalizeSong(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const name = pickStr(raw, [
    'songname',
    'audio_name',
    'name',
    'official_songname',
    'filename',
    'ori_audio_name',
    'fileName',
  ]);
  if (!name) {
    warnMissing('song', 'name', raw);
    return null;
  }

  // hash：实测有的平铺在顶层，有的嵌在 audio_info 里；高低音质各有独立 hash
  const hashes = {
    128: asHash(pick(raw, ['hash', 'audio_info.hash_128', 'hash_128'])),
    320: asHash(pick(raw, ['hash_320', 'audio_info.hash_320'])),
    flac: asHash(pick(raw, ['hash_flac', 'audio_info.hash_flac'])),
    high: asHash(pick(raw, ['hash_high', 'audio_info.hash_high'])),
  };
  const hash = hashes[128] || hashes[320] || hashes.flac || hashes.high || '';

  const singers = normalizeSingers(raw);

  // 时长：单位已知的字段显式标注，未知的交给 toSeconds 按量级判断
  const DURATION_FIELDS = [
    ['audio_info.duration_128', 'ms'],
    ['audio_info.duration_flac', 'ms'],
    ['duration_128', 'ms'],
    ['duration_320', 'ms'],
    ['timelength', 'ms'],
    ['timelength_128', 'ms'],
    ['time_length', 's'],
    ['timelen', null],
    ['duration', null],
  ];
  let duration = 0;
  for (const [field, unit] of DURATION_FIELDS) {
    const v = pick(raw, [field]);
    if (v !== undefined) {
      duration = toSeconds(v, unit);
      if (duration) break;
    }
  }
  if (!duration) warnMissing('song', 'duration', raw);

  const cover = normalizeCover(
    pick(raw, [
      'trans_param.union_cover',
      'cover',
      'album_info.sizable_cover',
      'albuminfo.sizable_cover',
      'imgurl',
      'sizable_cover',
    ])
  );

  const albumId = String(pick(raw, ['album_id', 'albuminfo.album_id', 'album_info.album_id']) ?? '');
  const albumAudioId = String(
    pick(raw, ['album_audio_id', 'mixsongid', 'mixSongId', 'MixSongID', 'audio_info.album_audio_id']) ?? ''
  );
  const audioId = String(pick(raw, ['audio_id', 'audioid', 'audio_info.audio_id']) ?? '');

  return {
    // 列表 key：尽量稳定且唯一
    id: hash || albumAudioId || audioId || `${name}-${singers[0]?.name ?? ''}`,
    hash,
    hashes,
    name,
    singers,
    singerText: singers.map((s) => s.name).join(' / ') || '未知歌手',
    album: pickStr(raw, ['album_name', 'album_info.album_name', 'albuminfo.album_name']),
    albumId,
    duration,
    cover,
    audioId,
    albumAudioId,
    privilege: pickNum(raw, ['privilege', 'privilege_download.privilege'], 0),
    filesize: pickNum(raw, ['filesize_128', 'audio_info.filesize_128', 'size'], 0),
    extname: pickStr(raw, ['extname', 'audio_info.extname']) || 'mp3',
    bitrate: pickNum(raw, ['bitrate', 'audio_info.bitrate'], 128),
    raw,
  };
}

/** 批量归一化并丢弃无效项 */
export function normalizeSongs(list) {
  if (!Array.isArray(list)) return [];
  return list.map(normalizeSong).filter(Boolean);
}

// ---------------------------------------------------------------- 歌单 / 榜单 / 专辑

/** /top/playlist 的 data.special_list[] */
export function normalizePlaylist(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = pickStr(raw, ['specialname', 'name', 'list_name', 'title']);
  if (!name) return null;
  return {
    id: String(pick(raw, ['global_collection_id', 'specialid', 'listid']) ?? ''),
    name,
    cover: normalizeCover(pick(raw, ['imgurl', 'flexible_cover', 'pic', 'cover']), 300),
    intro: pickStr(raw, ['intro', 'description']),
    creator: pickStr(raw, ['nickname', 'list_create_username', 'username']),
    creatorId: String(pick(raw, ['list_create_userid', 'suid', 'userid']) ?? ''),
    playCount: pickNum(raw, ['play_count', 'playcount', 'heat'], 0),
    songCount: pickNum(raw, ['song_count', 'count', 'songcount'], 0),
    // 实测 /user/playlist 里自建歌单的 type 为 0；仅作缩小范围用，不唯一
    type: pickNum(raw, ['type', 'list_type', 'specialtype'], -1),
    sort: pickNum(raw, ['sort'], 0),
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === 'string') : [],
    publishDate: pickStr(raw, ['publishtime', 'publish_date']),
    raw,
  };
}

export const normalizePlaylists = (list) =>
  Array.isArray(list) ? list.map(normalizePlaylist).filter(Boolean) : [];

// ---------------------------------------------------------------- 歌词

/**
 * 解析 LRC 文本为 [{ time: 秒, text }]
 * 实测 /lyric?fmt=lrc&decode=true 的 decodeContent 就是明文 LRC。
 *
 * 无时间标签的行（如编辑器写入的 `[ti:]` / `[ar:]` 头）会被自然跳过。
 */
export function parseLrc(text) {
  if (!text) return [];
  const lines = [];
  for (const line of String(text).split(/\r?\n/)) {
    const stamps = line.match(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g);
    if (!stamps) continue;
    const content = line.replace(/\[[^\]]*\]/g, '').trim();
    if (!content) continue;
    for (const stamp of stamps) {
      const m = stamp.match(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/);
      if (!m) continue;
      const min = Number(m[1]);
      const sec = Number(m[2]);
      const frac = m[3] ? Number(`0.${m[3]}`) : 0;
      lines.push({ time: min * 60 + sec + frac, text: content });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

/** 从 /lyric 响应里取可读歌词 */
export function extractLyricText(payload) {
  return pickStr(payload, ['decodeContent', 'lyric']);
}
