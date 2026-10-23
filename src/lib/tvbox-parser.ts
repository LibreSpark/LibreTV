import type { SourceListPayload, SubscriptionParseStats, SubscriptionSkipReason } from './types';
import {
  MAX_LIVE_SOURCES,
  MAX_VOD_SOURCES,
  hostnameOf,
  normalizeUrl,
  optionalString,
  parseSourceListPayload,
} from './source-list';

/**
 * TVBOX 配置 JSON 的解析层：把 `sites` / `lives` 归一化为本站的 SourceListPayload，
 * 使同一份订阅入口同时兼容 LibreTV-SourceList 与 TVBOX 两种格式。
 *
 * 仅导入「直连类」条目（与本站现有能力对齐）：
 * - 点播：type=1 的 JSON 接口（即 Apple CMS 采集站）；部分共享配置省略 type 或写成 0，
 *   但地址命中 Apple CMS 特征时一并宽容导入；
 * - 直播：type=0（或省略）的 M3U 播放列表，可带 EPG 节目单地址。
 *
 * Spider 类（csp_xxx / jar / js / py）需要 TVBOX 引擎才能在 Node 侧运行，XML 接口、
 * 单仓 JSON 与 txt 频道列表本站同样不支持：一律跳过并计入统计，不阻断其余条目导入。
 *
 * 本模块只做字段裁剪、去重与上限控制，不涉及网络与 SSRF（由调用方负责校验）。
 */

/** TVBOX 站点类型：0=XML 接口，1=JSON 接口，3=Spider，4=JSON 外链 */
const SITE_TYPE_XML = 0;
const SITE_TYPE_JSON = 1;
const SITE_TYPE_SPIDER = 3;
const SITE_TYPE_API = 4;

/** TVBOX 直播源类型：0=普通播放列表（m3u/txt），1=单仓 JSON */
const LIVE_TYPE_PLAYLIST = 0;

/** Spider 特征：csp_ 前缀，或 jar / js / py 资源（含查询串） */
const SPIDER_PATTERN = /^csp_|\.(?:jar|js|py)(?:[?#].*)?$/i;
/** 非 http(s) 的相对/本地资源（如 ./json/xxx.json）同样需要 TVBOX 引擎 */
const LOCAL_ASSET_PATTERN = /^\.{0,2}\//;
/**
 * Apple CMS 直连接口特征（type 缺失或写成 XML / 外链时用于宽容识别）：
 * 需为 api.php/provide/vod 接口，且排除 XML 通道（/at/xml）——后者本站解析不了。
 */
const CMS_API_PATTERN = /\/api\.php\/provide\/vod(?![^?#]*\/at\/xml)(?:[/?#]|$)/i;
/** M3U 播放列表特征 */
const M3U_PATTERN = /\.m3u8?(?:[?#].*)?$/i;
/** 纯文本频道列表特征（TVBOX 的 txt 直播源，本站无法解析） */
const TXT_PATTERN = /\.txt(?:[?#].*)?$/i;

/** 跳过原因示例名最多保留条数（提示文案不宜过长） */
const SKIPPED_SAMPLE_LIMIT = 3;

const SKIP_REASON_LABELS: Record<SubscriptionSkipReason, string> = {
  spider: 'Spider 引擎',
  xml: 'XML 接口',
  unsearchable: '不支持搜索',
  nonM3uLive: '非 M3U 直播',
  invalidUrl: '地址不可用',
};

/** 固定展示顺序，避免同类统计在不同配置下提示文案抖动 */
const SKIP_REASON_ORDER: SubscriptionSkipReason[] = ['spider', 'xml', 'unsearchable', 'nonM3uLive', 'invalidUrl'];

interface SkipCounter {
  count: number;
  byReason: Partial<Record<SubscriptionSkipReason, number>>;
  samples: string[];
}

/** 空统计（LibreTV-SourceList 格式的默认值） */
function emptyStats(format: SubscriptionParseStats['format']): SubscriptionParseStats {
  return { format, skipped: 0, skippedByReason: {}, truncated: 0 };
}

/**
 * 宽容 JSON 解析：部分共享配置带行注释、块注释或尾随逗号
 * （TVBOX 客户端用的 fastjson 默认容忍，标准 JSON.parse 会直接失败）。
 * 这里在字符串外部剥离这些痕迹后再解析，字符串内的 `//`（如 https://）不受影响。
 */
export function parseSubscriptionJson(text: string): unknown {
  try {
    return JSON.parse(stripJsonArtifacts(text.replace(/^\uFEFF/, '')));
  } catch {
    throw new Error('订阅内容不是合法的 JSON');
  }
}

/**
 * 剥离 JSON 中的注释与尾随逗号（仅作用于字符串外部）。
 * 必须先剥注释再剥尾随逗号：`[1, // 注释\n]` 里的逗号隔着注释，
 * 只有先删掉注释才能正确识别为尾随逗号。
 */
function stripJsonArtifacts(text: string): string {
  return stripTrailingCommas(stripComments(text));
}

/** 把字符串内的裸控制字符转成合法转义序列 */
function escapeControlChar(code: number): string {
  if (code === 0x0a) return '\\n';
  if (code === 0x0d) return '\\r';
  if (code === 0x09) return '\\t';
  return `\\u${code.toString(16).padStart(4, '0')}`;
}

/** 剥离字符串外部的行注释与块注释 */
function stripComments(text: string): string {
  let out = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (ch === '\n' || ch === '\r') {
        inLineComment = false;
        out += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      // 部分配置在字符串里留了裸换行等控制字符（fastjson 容忍，标准 JSON 不允许）
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        out += escapeControlChar(code);
        continue;
      }
      out += ch;
      // 转义字符连同其后一位原样保留，避免 \" 被误判为字符串结束
      if (ch === '\\') {
        out += next ?? '';
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    out += ch;
  }

  return out;
}

/** 剥离尾随逗号（`{"a":1,}` / `[1,2,]`），此时文本已不含注释 */
function stripTrailingCommas(text: string): string {
  let out = '';
  let inString = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += text[i + 1] ?? '';
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += ch;
  }

  return out;
}

/** TVBOX 配置判别：顶层出现 sites / lives 数组即视为 TVBOX 配置 */
export function isTvboxPayload(json: unknown): boolean {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return false;
  const record = json as Record<string, unknown>;
  return Array.isArray(record.sites) || Array.isArray(record.lives);
}

/**
 * 解析订阅 JSON：自动识别格式（先判 TVBOX，后判 LibreTV-SourceList）。
 * 两者均不匹配时由 parseSourceListPayload 抛出格式错误。
 */
export function parseSubscriptionPayload(json: unknown): SourceListPayload {
  if (isTvboxPayload(json)) return parseTvboxPayload(json);
  if (isSourceCatalogPayload(json)) return parseSourceCatalogPayload(json);
  return { ...parseSourceListPayload(json), stats: emptyStats('libretv') };
}

/** Source catalog JSON: a bare array of { name, baseUrl, enabled } entries. */
function isSourceCatalogPayload(json: unknown): json is Record<string, unknown>[] {
  return Array.isArray(json) && json.some((entry) => entry && typeof entry === 'object' && 'baseUrl' in entry);
}

function parseSourceCatalogPayload(entries: Record<string, unknown>[]): SourceListPayload {
  const seen = new Set<string>();
  const sources: SourceListPayload['sources'] = [];
  let truncated = 0;

  for (const entry of entries) {
    if (entry.enabled === false) continue;
    const url = normalizeUrl(entry.baseUrl, true);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    if (sources.length >= MAX_VOD_SOURCES) {
      truncated += 1;
      continue;
    }
    sources.push({
      name: optionalString(entry.name) || hostnameOf(url),
      url,
    });
  }

  if (sources.length === 0) {
    throw new Error('配置中没有可用的接口源');
  }

  return {
    name: '影视接口源列表',
    sources,
    liveSources: [],
    stats: {
      format: 'source-catalog',
      skipped: 0,
      skippedByReason: {},
      truncated,
    },
  };
}

/** 解析 TVBOX 配置：sites / lives → 本站点播源与直播源，附带跳过与截断统计 */
export function parseTvboxPayload(json: unknown): SourceListPayload {
  const record = (json ?? {}) as Record<string, unknown>;
  const rawSites = Array.isArray(record.sites) ? record.sites : [];
  const rawLives = Array.isArray(record.lives) ? record.lives : [];
  const skipped: SkipCounter = { count: 0, byReason: {}, samples: [] };

  const vod = collectVodSources(rawSites, skipped);
  const live = collectLiveSources(rawLives, skipped);

  if (vod.sources.length === 0 && live.liveSources.length === 0) {
    throw new Error(
      skipped.count > 0
        ? `配置中没有可直接导入的源：已跳过 ${skipped.count} 个条目（${describeReasons(skipped.byReason)}）`
        : '配置中没有可用的站点（sites / lives 均为空）'
    );
  }

  return {
    name: optionalString(record.name),
    sources: vod.sources,
    liveSources: live.liveSources,
    stats: {
      format: 'tvbox',
      skipped: skipped.count,
      skippedByReason: skipped.byReason,
      skippedSamples: skipped.samples.length > 0 ? skipped.samples : undefined,
      truncated: vod.truncated + live.truncated,
    },
  };
}

/** 追加一处跳过计数（服务端在 SSRF 过滤后再丢弃条目时调用），返回新对象 */
export function withSkipped(
  stats: SubscriptionParseStats | undefined,
  reason: SubscriptionSkipReason,
  count: number
): SubscriptionParseStats {
  const base = stats ?? emptyStats('libretv');
  if (count <= 0) return base;
  return {
    ...base,
    skipped: base.skipped + count,
    skippedByReason: { ...base.skippedByReason, [reason]: (base.skippedByReason[reason] ?? 0) + count },
  };
}

/**
 * 生成导入结果的补充说明（跳过与截断情况），无异常时返回空串。
 * 服务端错误消息与前端提示共用，保证两处文案一致；
 * `includeSamples` 为 false 时省略示例站点名（toast 展示时长有限，文案需精简）。
 */
export function describeParseStats(
  stats: SubscriptionParseStats | undefined,
  options?: { includeSamples?: boolean }
): string {
  if (!stats) return '';
  const parts: string[] = [];
  if (stats.skipped > 0) {
    parts.push(`跳过 ${stats.skipped} 个不可用条目（${describeReasons(stats.skippedByReason)}）`);
  }
  if (options?.includeSamples !== false && stats.skippedSamples && stats.skippedSamples.length > 0) {
    parts.push(`如「${stats.skippedSamples.join('」「')}」`);
  }
  if (stats.truncated > 0) {
    parts.push(`超出上限截断 ${stats.truncated} 条`);
  }
  return parts.join('，');
}

/** 收集点播源：只接受 Apple CMS 直连接口 */
function collectVodSources(rawSites: unknown[], skipped: SkipCounter) {
  const seen = new Set<string>();
  const sources: SourceListPayload['sources'] = [];
  let truncated = 0;

  for (const raw of rawSites) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const site = raw as Record<string, unknown>;
    const name = optionalString(site.name);
    const api = optionalString(site.api);
    const type = toNumber(site.type);

    if (!api) {
      markSkipped(skipped, 'invalidUrl', name);
      continue;
    }
    // Spider 类与本地资源需要 TVBOX 引擎，Node 侧无法运行
    if (type === SITE_TYPE_SPIDER || SPIDER_PATTERN.test(api)) {
      markSkipped(skipped, 'spider', name);
      continue;
    }
    if (!/^https?:\/\//i.test(api)) {
      markSkipped(skipped, LOCAL_ASSET_PATTERN.test(api) ? 'spider' : 'invalidUrl', name);
      continue;
    }
    // 站点自身声明不可搜索：本站只有搜索入口，导入后无从使用
    if (site.searchable === 0 || site.searchable === '0') {
      markSkipped(skipped, 'unsearchable', name);
      continue;
    }

    // 可导入判定：显式 JSON 接口，或类型缺失/写成 XML、外链但地址命中 Apple CMS 特征
    const importable =
      type === SITE_TYPE_JSON ||
      ((type === undefined || type === SITE_TYPE_XML || type === SITE_TYPE_API) && CMS_API_PATTERN.test(api));
    if (!importable) {
      markSkipped(skipped, type === SITE_TYPE_API ? 'spider' : 'xml', name);
      continue;
    }

    const url = normalizeUrl(api, true);
    if (!url) {
      markSkipped(skipped, 'invalidUrl', name);
      continue;
    }
    if (seen.has(url)) continue; // 重复条目静默跳过，与 LibreTV 订阅语义一致
    if (sources.length >= MAX_VOD_SOURCES) {
      truncated += 1;
      continue;
    }
    seen.add(url);
    sources.push({ name: name || hostnameOf(url), url });
  }

  return { sources, truncated };
}

/** 收集直播源：只接受 M3U 播放列表 */
function collectLiveSources(rawLives: unknown[], skipped: SkipCounter) {
  const seen = new Set<string>();
  const liveSources: SourceListPayload['liveSources'] = [];
  let truncated = 0;

  for (const raw of rawLives) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const live = raw as Record<string, unknown>;
    const name = optionalString(live.name);
    const url = normalizeUrl(live.url, false);
    if (!url) {
      markSkipped(skipped, 'invalidUrl', name);
      continue;
    }
    const type = toNumber(live.type);
    // 单仓 JSON 直播订阅本站不支持；txt 频道列表无法被 M3U 解析器识别
    if ((type !== undefined && type !== LIVE_TYPE_PLAYLIST) || (!M3U_PATTERN.test(url) && TXT_PATTERN.test(url))) {
      markSkipped(skipped, 'nonM3uLive', name);
      continue;
    }
    if (seen.has(url)) continue;
    if (liveSources.length >= MAX_LIVE_SOURCES) {
      truncated += 1;
      continue;
    }
    seen.add(url);
    liveSources.push({ name: name || hostnameOf(url), url, epg: normalizeUrl(live.epg, false) });
  }

  return { liveSources, truncated };
}

function toNumber(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) return Number(raw);
  return undefined;
}

function markSkipped(counter: SkipCounter, reason: SubscriptionSkipReason, name?: string): void {
  counter.count += 1;
  counter.byReason[reason] = (counter.byReason[reason] ?? 0) + 1;
  if (name && counter.samples.length < SKIPPED_SAMPLE_LIMIT && !counter.samples.includes(name)) {
    counter.samples.push(name);
  }
}

/** 按固定顺序拼装原因明细，如「Spider 引擎 20、XML 接口 5」 */
function describeReasons(byReason: Partial<Record<SubscriptionSkipReason, number>>): string {
  return SKIP_REASON_ORDER.filter((reason) => (byReason[reason] ?? 0) > 0)
    .map((reason) => `${SKIP_REASON_LABELS[reason]} ${byReason[reason]}`)
    .join('、');
}
