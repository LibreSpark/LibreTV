import type { SourceListPayload } from './types';

/**
 * 数据源订阅（LibreTV-SourceList JSON）的纯解析层：只做字段裁剪、去重与上限，
 * 不涉及网络与 SSRF 判定（点播/直播的地址放行策略不同，由调用方按类型分别校验）。
 *
 * 支持三种形态：
 * 1. 完整格式：{ name?, sources: [...点播源], liveSources: [...直播源] }
 * 2. 老格式：只有 sources（或裸数组），直播源为空 —— 保持向后兼容
 * 3. 纯直播订阅：只有 liveSources
 */

export const MAX_VOD_SOURCES = 100;
export const MAX_LIVE_SOURCES = 50;

/**
 * 订阅地址统一形态：trim 并去掉尾部斜杠。
 * 手动输入与预置订阅（DEFAULT_SUBSCRIPTIONS）都必须走这一步——
 * 否则同一地址带不带尾斜杠会被存成两条订阅（不同 key 前缀、重复同步、重复拉取）。
 */
export function normalizeSubscriptionUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

interface RawItem {
  name?: unknown;
  url?: unknown;
  detail?: unknown;
  isAdult?: unknown;
  epg?: unknown;
}

/**
 * 规范化为 http(s) 地址；trimTrailingSlash 控制是否去掉尾部斜杠（点播去、直播保留）。
 * 导出供 tvbox-parser 复用，保证两种订阅格式的归一化规则完全一致。
 */
export function normalizeUrl(raw: unknown, trimTrailingSlash: boolean): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (!/^https?:\/\//i.test(trimmed)) return undefined;
  try {
    new URL(trimmed);
  } catch {
    return undefined;
  }
  const withoutEmptyQueryOrHash = trimmed.replace(/[?#]+$/, '');
  return trimTrailingSlash ? withoutEmptyQueryOrHash.replace(/\/+$/, '') : withoutEmptyQueryOrHash;
}

export function optionalString(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * 解析订阅 JSON。
 * @throws 内容既无点播源也无直播源时抛错（提示格式问题）
 */
export function parseSourceListPayload(json: unknown): SourceListPayload {
  const asArray = Array.isArray(json) ? json : null;
  const asObject = asArray ? null : (json as { name?: unknown; sources?: unknown; liveSources?: unknown } | null);

  const rawVod: RawItem[] = asArray
    ? asArray
    : Array.isArray(asObject?.sources)
      ? (asObject?.sources as RawItem[])
      : [];
  const rawLive: RawItem[] = Array.isArray(asObject?.liveSources) ? (asObject?.liveSources as RawItem[]) : [];

  if (rawVod.length === 0 && rawLive.length === 0) {
    throw new Error('订阅内容格式不正确（缺少 sources / liveSources 数组）');
  }

  // 先去重再截断：上限按去重后的有效条目计，前段重复不挤占名额
  const seenVod = new Set<string>();
  const sources: SourceListPayload['sources'] = [];
  for (const s of rawVod) {
    if (sources.length >= MAX_VOD_SOURCES) break;
    const url = normalizeUrl(s?.url, true);
    if (!url || seenVod.has(url)) continue;
    seenVod.add(url);
    sources.push({
      name: optionalString(s?.name) || hostnameOf(url),
      url,
      detail: optionalString(s?.detail),
      isAdult: s?.isAdult === true,
    });
  }

  const seenLive = new Set<string>();
  const liveSources: SourceListPayload['liveSources'] = [];
  for (const s of rawLive) {
    if (liveSources.length >= MAX_LIVE_SOURCES) break;
    const url = normalizeUrl(s?.url, false);
    if (!url || seenLive.has(url)) continue;
    seenLive.add(url);
    const epg = normalizeUrl(s?.epg, false);
    liveSources.push({
      name: optionalString(s?.name) || hostnameOf(url),
      url,
      epg,
    });
  }

  const name = asObject ? optionalString(asObject.name) : undefined;

  return { name, sources, liveSources };
}
