import { makeAbsolute, stripAdGroups, documentBaseURI } from './m3u8';

/**
 * m3u8 播放列表解析（预取器与离线下载共用）。
 *
 * 与 hls.js loader 侧的一致性是本地缓存命中的前提：
 * 两侧都通过 `new URL()` 绝对化地址（见 video-cache.buildSegmentCacheKey），
 * 因此这里对分片地址也必须用同一构造器抹平默认端口 / 百分号编码差异。
 * 但仅有同一构造器不够——基址本身可能就是根相对的代理形式，
 * `new URL(相对分片, 相对基址)` 会抛错并原样返回，所以入参要先锚到文档基址。
 */

export interface ParsedSegment {
  /** 绝对地址 */
  url: string;
  /** EXTINF 时长（秒）；缺失时为 0 */
  duration: number;
}

export interface ParsedVariant {
  url: string;
  /** RESOLUTION 的高度；缺失时按码率推断 */
  height: number;
  bandwidth: number;
}

export interface AesConf {
  method: string;
  uri: string;
  iv?: string;
}

export interface ParsedPlaylist {
  /** master 播放列表时非空（已按 preferredHeight 选档） */
  variants?: ParsedVariant[];
  segments: ParsedSegment[];
  /** fMP4 EXT-X-MAP 初始化分段的绝对 URL；存在时媒体分片按 fMP4 直接拼接 */
  initSegment?: string;
  /** AES-128 解密参数；method=NONE 时为 undefined */
  aesConf?: AesConf;
  /** 出现 EXT-X-BYTERANGE：分片为原文件切片，无法独立缓存，该集禁用缓存 */
  byterange: boolean;
  totalDuration: number;
  /** EXT-X-MEDIA-SEQUENCE（缺省 0）：KEY 无 IV 属性时，分片 IV = 该值 + 分片序号 */
  mediaSequence: number;
}

/** 解析深度上限（master → variant → media，正常不超过 2 层，防御异常源） */
const MAX_DEPTH = 5;

/**
 * 码率 → 推断高度：很多源站的 master playlist 只给 BANDWIDTH 不给 RESOLUTION，
 * hls.js 的 level.height 会是 undefined，任何「按分辨率命名」的实现都会退化。
 * 分层取自常见转码参数（1080p≈5Mbps、720p≈3Mbps…），仅供档位标识使用。
 */
export function inferHeightFromBitrate(bandwidth: number): number {
  const tiers: Array<[number, number]> = [
    [20_000_000, 4320],
    [10_000_000, 2160],
    [5_000_000, 1080],
    [3_000_000, 720],
    [1_500_000, 540],
    [800_000, 480],
    [400_000, 360],
  ];
  for (const [bps, height] of tiers) {
    if (bandwidth >= bps) return height;
  }
  return 240;
}

/**
 * 档位选择：传 preferredHeight 时「同高度优先 → 更高档中最低 → 更低档中最高」；
 * 未传时取最高带宽。与 hls-quality 的匹配思路一致，保证预取/下载选中的
 * 档位就是用户正在观看的那一档。
 */
export function pickVariant(variants: ParsedVariant[], preferredHeight?: number): ParsedVariant {
  if (!preferredHeight) {
    return variants.reduce((best, v) => (v.bandwidth > best.bandwidth ? v : best), variants[0]);
  }
  const same = variants.filter((v) => v.height === preferredHeight);
  if (same.length) return same.reduce((best, v) => (v.bandwidth < best.bandwidth ? v : best), same[0]);
  const higher = variants.filter((v) => v.height > preferredHeight);
  if (higher.length) return higher.reduce((best, v) => (v.height < best.height ? v : best), higher[0]);
  return variants.reduce((best, v) => (v.height > best.height ? v : best), variants[0]);
}

function parseExtInf(line: string): number {
  const m = line.match(/^#EXTINF:([\d.]+)/);
  return m ? parseFloat(m[1]) || 0 : 0;
}

function parseAesConf(line: string): AesConf | undefined {
  const method = line.match(/METHOD=([^,]+)/)?.[1];
  if (!method) throw new Error('HLS EXT-X-KEY 缺少 METHOD');
  if (method === 'NONE') return undefined;
  // Only identity AES-128-CBC is implemented; fail closed for DRM/SAMPLE-AES.
  if (method !== 'AES-128') throw new Error(`暂不支持 HLS 加密方式：${method}`);
  const keyFormat = line.match(/KEYFORMAT="([^"]+)"/)?.[1];
  if (keyFormat && keyFormat !== 'identity') throw new Error(`暂不支持 HLS KEYFORMAT：${keyFormat}`);
  const uri = line.match(/URI="([^"]+)"/)?.[1];
  if (!uri) throw new Error('HLS AES-128 密钥缺少 URI');
  const iv = line.match(/IV=0[xX]([0-9a-fA-F]+)/)?.[1];
  return { method, uri, iv };
}

export interface ParseOptions {
  /** 剔除广告段（URL 特征的中插段 + 片头无特征插入段）；缺省 true */
  stripLeadAd?: boolean;
}

/** 解析播放列表：master 递归选档，media 输出分片清单。fetch 失败 / 超限直接抛错由调用方降级 */
export async function parseM3u8Playlist(
  url: string,
  depth = 0,
  preferredHeight?: number,
  opts?: ParseOptions
): Promise<ParsedPlaylist> {
  if (depth > MAX_DEPTH) throw new Error(`m3u8 嵌套超过 ${MAX_DEPTH} 层`);
  // 入参本身可能是本站根相对地址（代理形态），先锚成绝对地址再作为解析基址：
  // 否则 new URL(相对分片, 相对基址) 抛错，segments[].url 就停留在相对形式，
  // 与 hls.js 按绝对清单地址解析出的同一个分片不再是同一个缓存 key
  const base = makeAbsolute(url, documentBaseURI());
  const res = await fetch(base, { headers: { Accept: '*/*' } });
  if (!res.ok) throw new Error(`m3u8 拉取失败：HTTP ${res.status}`);
  // 剔除片头广告段要在统计时长/分片之前做，下载产物才不会带上广告
  const text = opts?.stripLeadAd === false ? await res.text() : stripAdGroups(await res.text());

  // —— master：收集变体，选档后递归 ——
  if (text.includes('#EXT-X-STREAM-INF')) {
    const variants: ParsedVariant[] = [];
    let pending: { bandwidth: number; height?: number } | undefined;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (line.startsWith('#EXT-X-STREAM-INF')) {
        const bandwidth = parseInt(line.match(/BANDWIDTH=(\d+)/)?.[1] || '0', 10);
        const resolution = line.match(/RESOLUTION=(\d+)x(\d+)/);
        pending = {
          bandwidth,
          height: resolution ? parseInt(resolution[2], 10) : undefined,
        };
        continue;
      }
      if (!line || line.startsWith('#')) continue;
      if (pending) {
        const abs = makeAbsolute(line, base);
        variants.push({
          url: abs,
          bandwidth: pending.bandwidth,
          height: pending.height ?? inferHeightFromBitrate(pending.bandwidth),
        });
        pending = undefined;
      }
    }
    if (!variants.length) throw new Error('master m3u8 未解析到可用档位');
    const chosen = pickVariant(variants, preferredHeight);
    const inner = await parseM3u8Playlist(chosen.url, depth + 1, preferredHeight, opts);
    return { ...inner, variants };
  }

  // —— media：分片 / 时长 / AES / BYTERANGE ——
  const segments: ParsedSegment[] = [];
  let aesConf: AesConf | undefined;
  let encryptionIdentity: string | undefined;
  let initSegment: string | undefined;
  let byterange = false;
  let pendingDuration = 0;
  const mediaSequence = parseInt(text.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m)?.[1] || '0', 10) || 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-MAP')) {
      const uri = line.match(/URI="([^"]+)"/)?.[1];
      if (!uri) throw new Error('HLS EXT-X-MAP 缺少初始化分段 URI');
      if (/BYTERANGE=/i.test(line)) throw new Error('fMP4 初始化分段 BYTERANGE 暂不支持');
      const absoluteUri = makeAbsolute(uri, base);
      if (initSegment && initSegment !== absoluteUri) {
        throw new Error('HLS 在同一下载任务中切换了多个初始化分段，暂不支持');
      }
      initSegment = absoluteUri;
      continue;
    }
    if (line.startsWith('#EXT-X-KEY')) {
      const conf = parseAesConf(line);
      const nextConf = conf ? { ...conf, uri: makeAbsolute(conf.uri, base) } : undefined;
      const nextIdentity = nextConf ? nextConf.method + '|' + nextConf.uri + '|' + (nextConf.iv ?? '') : 'NONE';
      const previousIdentity = encryptionIdentity ?? 'NONE';
      // ParsedPlaylist carries one key for the whole media playlist. Fail closed
      // instead of applying the last key to segments that used a different key.
      if (segments.length > 0 && previousIdentity !== nextIdentity) {
        throw new Error('暂不支持 HLS 分片级密钥轮换或加密状态切换');
      }
      encryptionIdentity = nextIdentity;
      aesConf = nextConf;
      continue;
    }
    if (line.startsWith('#EXT-X-BYTERANGE')) {
      byterange = true;
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      pendingDuration = parseExtInf(line);
      continue;
    }
    if (!line || line.startsWith('#')) continue;
    segments.push({ url: makeAbsolute(line, base), duration: pendingDuration });
    pendingDuration = 0;
  }
  if (!segments.length) throw new Error('m3u8 未解析到分片');
  return {
    segments,
    initSegment,
    aesConf,
    byterange,
    totalDuration: segments.reduce((sum, s) => sum + s.duration, 0),
    mediaSequence,
  };
}
