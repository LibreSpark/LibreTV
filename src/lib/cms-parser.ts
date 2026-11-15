import type { SearchResultItem, VideoDetail } from './types';

/**
 * Apple CMS（苹果CMS）资源站响应解析
 * 与旧版 js/api.js 逻辑对齐，迁移为纯函数以便单元测试。
 */

const M3U8_PATTERN = /\$https?:\/\/[^"'\s]+?\.m3u8/g;

const UA_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept: 'application/json',
};

export function cmsRequestHeaders(): Record<string, string> {
  return { ...UA_HEADERS };
}

/** 搜索响应 → 统一结果列表 */
export function parseSearchList(
  data: unknown,
  source: { key: string; name: string; url: string; isAdult?: boolean }
): SearchResultItem[] {
  if (!data || typeof data !== 'object') throw new Error('API返回的数据格式无效');
  const list = (data as { list?: unknown }).list;
  // 部分源站无结果时返回 list: null（而非 []），视为空结果而非格式错误
  if (list !== null && list !== undefined && !Array.isArray(list)) {
    throw new Error('API返回的数据格式无效');
  }
  return (Array.isArray(list) ? list : []).map((item) => {
    const vod = item as Record<string, unknown>;
    return {
      sourceKey: source.key,
      sourceName: source.name,
      vodId: String(vod.vod_id ?? ''),
      name: String(vod.vod_name ?? ''),
      pic: typeof vod.vod_pic === 'string' ? vod.vod_pic : undefined,
      typeName: typeof vod.type_name === 'string' ? vod.type_name : undefined,
      year: typeof vod.vod_year === 'string' ? vod.vod_year : undefined,
      area: typeof vod.vod_area === 'string' ? vod.vod_area : undefined,
      remarks: typeof vod.vod_remarks === 'string' ? vod.vod_remarks : undefined,
      sourceUrl: source.url,
      isAdult: source.isAdult,
    };
  });
}

/**
 * 从 vod_play_url 中提取分集地址：格式 源1$$$源2，集1$URL1#集2$URL2。
 * 部分源（如量子 lziapi、非凡 ffzy）第一条线路是网页中转页（…/share/xxx，不可播），
 * 真实 m3u8 在后面的线路里，因此优先取包含 m3u8 直链的线路；均无 m3u8 时回退第一条。
 */
export function extractEpisodeItemsFromPlayUrl(playUrl: string): { title: string; url: string }[] {
  if (!playUrl) return [];
  const separatorChar = String.fromCharCode(36);
  const groups = playUrl
    .split(separatorChar.repeat(3))
    .map((group) =>
      group
        .split('#')
        .map((episode) => {
          const separator = episode.indexOf(separatorChar);
          if (separator < 0) return null;
          const title = episode.slice(0, separator).trim();
          const url = episode.slice(separator + 1).trim();
          return url.startsWith('http://') || url.startsWith('https://')
            ? { title, url }
            : null;
        })
        .filter((episode): episode is { title: string; url: string } => episode !== null)
    )
    .filter((episodes) => episodes.length > 0);
  if (groups.length === 0) return [];
  return groups.find((episodes) => episodes.some((episode) => episode.url.includes('.m3u8'))) ?? groups[0];
}

/** 兼容旧播放器的 URL 列表接口；分集名称通过 VideoDetail.episodeItems 作为可选字段提供。 */
export function extractEpisodesFromPlayUrl(playUrl: string): string[] {
  return extractEpisodeItemsFromPlayUrl(playUrl).map((episode) => episode.url);
}

/** 从简介文本中兜底提取 m3u8 链接 */
export function extractM3u8FromText(text: string): string[] {
  if (!text) return [];
  const matches = text.match(M3U8_PATTERN) || [];
  return matches.map((link) => link.replace(/^\$/, ''));
}

/** 根据 CMS 分类识别电影；不能只依赖「电影」二字，因为 Apple CMS 常用「动作片/科幻片」等类型名。 */
export function isMovieType(typeName: string | undefined, episodeCount = 0): boolean {
  const type = (typeName ?? '').trim().toLowerCase();
  if (/电视剧|连续剧|剧集|番剧|动漫|动画番剧|综艺|纪录剧|tv\s*series|series|anime|variety/.test(type)) return false;
  if (/电影|movie|film|动作片|喜剧片|爱情片|科幻片|恐怖片|剧情片|战争片|犯罪片|悬疑片|惊悚片|动画电影|短片|院线/.test(type)) return true;
  // 分类缺失或第三方自定义分类时，只有单条播放地址才按单片处理；
  // 多集资源默认展示分集，避免把未知类型的剧集隐藏掉。
  return episodeCount <= 1;
}

/** 将 CMS 简介中的 HTML 转为纯文本，不把不可信标记交给 React 渲染。 */
export function cmsDescriptionToText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value
    .replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/(?:p|div|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || undefined;
}

/** 详情 JSON 响应 → 统一详情 */
export function parseDetail(
  data: unknown,
  source: { key: string; name: string; url: string }
): VideoDetail {
  const d = data as { list?: Record<string, unknown>[] };
  if (!d || !Array.isArray(d.list) || d.list.length === 0) {
    throw new Error('获取到的详情内容无效');
  }
  const vod = d.list[0];
  const episodeItems = extractEpisodeItemsFromPlayUrl(String(vod.vod_play_url ?? ''));
  // Optional CMS extension: per-episode records can carry their own still and metadata.
  // Match by the exact episode URL; never infer artwork from the title-level vod_pic or array position.
  const rawEpisodeMetadata = Array.isArray(vod.vod_episode_list)
    ? vod.vod_episode_list.filter(
        (entry): entry is Record<string, unknown> =>
          Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry),
      )
    : [];
  const episodeItemsWithMetadata = episodeItems.map((episode) => {
    const metadata = rawEpisodeMetadata.find((entry) => {
      const entryUrl = str(entry.url) || str(entry.play_url) || str(entry.vod_play_url);
      return entryUrl === episode.url;
    });
    if (!metadata) return episode;
    const stillPath = str(metadata.still_path);
    const stillPathUrl = stillPath
      ? (/^https?:\/\//i.test(stillPath)
        ? stillPath
        : /^\/[^?#\s]+$/.test(stillPath)
          ? `https://image.tmdb.org/t/p/w500${stillPath}`
          : undefined)
      : undefined;
    const rawStill = stillPathUrl
      || str(metadata.screenshot_url)
      || str(metadata.screenshot)
      || str(metadata.image_url)
      || str(metadata.image);
    const image = rawStill && /^https?:\/\/[^\s]+$/i.test(rawStill) ? rawStill : undefined;
    const episodeName = str(metadata.episode_name) || str(metadata.name) || str(metadata.title);
    const description = cmsDescriptionToText(metadata.description ?? metadata.overview ?? metadata.vod_content);
    const duration = str(metadata.duration) || str(metadata.runtime);
    const capturedAt = str(metadata.image_captured_at) || str(metadata.captured_at) || str(metadata.extracted_at);
    return {
      ...episode,
      ...(image ? {
        image,
        imageSourceUrl: image,
        imageSourceEpisodeUrl: episode.url,
        ...(capturedAt ? { imageCapturedAt: capturedAt } : {}),
      } : {}),
      ...(episodeName ? { episodeName } : {}),
      ...(description ? { description } : {}),
      ...(duration ? { duration } : {}),
    };
  });
  let episodes = episodeItems.map((episode) => episode.url);
  if (episodes.length === 0) {
    episodes = extractM3u8FromText(String(vod.vod_content ?? ''));
  }
  return {
    episodes,
    ...(episodeItems.length > 0 ? { episodeItems: episodeItemsWithMetadata } : {}),
    videoInfo: {
      title: str(vod.vod_name),
      originalTitle: str(vod.vod_en),
      cover: str(vod.vod_pic),
      desc: cmsDescriptionToText(vod.vod_content),
      typeName: str(vod.type_name),
      year: str(vod.vod_year),
      area: str(vod.vod_area),
      director: str(vod.vod_director),
      actor: str(vod.vod_actor),
      remarks: str(vod.vod_remarks),
      sourceKey: source.key,
      sourceName: source.name,
      sourceUrl: source.url,
    },
  };
}

function str(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || undefined;
}

/**
 * 部分源的列表接口不返回播放地址，需要爬详情页 HTML 提取 m3u8。
 * 与旧版 handleSpecialSourceDetail 对齐。
 */
export function parseDetailPageHtml(
  html: string,
  source: { key: string; name: string; url: string }
): VideoDetail {
  // 先尝试通用模式，再尝试非凡影视的日期哈希特征路径
  let matches = html.match(/\$(https?:\/\/[^"'\s]+?\.m3u8)/g) || [];
  if (matches.length === 0) {
    matches = html.match(/\$(https?:\/\/[^"'\s]+?\/\d{8}\/\d+_[a-f0-9]+\/index\.m3u8)/g) || [];
  }
  // 去重并清理尾缀
  const episodes = [...new Set(matches)].map((link) => {
    let u = link.substring(1);
    const parenIndex = u.indexOf('(');
    if (parenIndex > 0) u = u.substring(0, parenIndex);
    return u;
  });

  const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
  const descMatch = html.match(/<div[^>]*class=["']sketch["'][^>]*>([\s\S]*?)<\/div>/);

  return {
    episodes,
    videoInfo: {
      title: titleMatch ? titleMatch[1].trim() : undefined,
      desc: descMatch ? descMatch[1].replace(/<[^>]+>/g, ' ').trim() : undefined,
      sourceKey: source.key,
      sourceName: source.name,
      sourceUrl: source.url,
    },
  };
}

/** 敏感分类过滤（成人内容过滤，关键词与旧版保持一致） */
const ADULT_KEYWORDS = [
  '伦理片', '福利', '倫理片', '福利片', '日本伦理', '日本福利', '日本福利片', '日本伦理片', '擦边短剧', '擦边', '韩国伦理','里番动漫', '门事件', '萝莉少女', '制服诱惑', '国产传媒',
  'cosplay', '黑丝诱惑', '无码', '日本无码', '有码', '日本有码', 'SWAG',
  '网红主播', '色情片', '同性片', '福利视频', '无码高清', '有码高清', '91视频', '自拍偷拍', 'mini传媒', '福利片',
];

export function isAdultContent(typeName: string | undefined): boolean {
  if (!typeName) return false;
  return ADULT_KEYWORDS.some((k) => typeName.includes(k));
}

export function filterAdultResults<T extends { typeName?: string }>(items: T[], enabled: boolean): T[] {
  if (!enabled) return items;
  return items.filter((item) => !isAdultContent(item.typeName));
}

/**
 * 归一化标题/关键词：去空白、标点与符号，转小写。
 * 用于跨标点差异匹配（源站存「摔跤吧!爸爸」而用户搜「摔跤吧！爸爸」）。
 */
export function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/**
 * 仅将独立数字或明确的「第 N 季」后缀作为季数别名。
 *
 * `bareNeedsSpace` 区分两侧：
 * - 查询侧传 false：用户习惯直接输入「庆余年2」，数字前没有空格也得认成季数
 * - 标题侧保持 true：必须有空格，避免把片名自带的数字（「电影2」）误判成第二季
 */
function parseSeasonSuffix(
  title: string,
  allowAnnotations = false,
  bareNeedsSpace = true
): { base: string; season: number; explicit: boolean } | undefined {
  // 标题侧允许「第二季」后跟任意附注：粤语、预告片、【影视解说】、无分隔符的「第二季粤语」都算
  const explicitPattern = allowAnnotations
    ? /^(.*?)\s*第\s*([1-9]\d?|[一二两三四五六七八九十]{1,3})\s*季.*$/u
    : /^(.*?)\s*第\s*([1-9]\d?|[一二两三四五六七八九十]{1,3})\s*季$/u;
  const explicit = title.trim().match(explicitPattern);
  const bare = title.trim().match(bareNeedsSpace ? /^(.*?)\s+([1-9]\d?)$/u : /^(.*?)\s*([1-9]\d?)$/u);
  const match = explicit ?? bare;
  if (!match || !normalizeTitle(match[1])) return undefined;
  const value = match[2];
  const digits = '零一二三四五六七八九';
  let season = Number(value);
  if (!Number.isFinite(season)) {
    const chinese = value.replace('两', '二');
    if (/^[一二三四五六七八九]$/u.test(chinese)) {
      season = digits.indexOf(chinese);
    } else if (/^[一二三四五六七八九]?十[一二三四五六七八九]?$/u.test(chinese)) {
      const [tens, units] = chinese.split('十');
      season = (tens ? digits.indexOf(tens) : 1) * 10 + (units ? digits.indexOf(units) : 0);
    }
  }
  if (!Number.isFinite(season)) return undefined;
  return { base: match[1], season, explicit: Boolean(explicit) };
}

/** 数字必须完整命中，避免第 2 季误匹配 12 或 20。 */
function includesKeyword(title: string, keyword: string): boolean {
  if (!title || !keyword) return false;
  let index = title.indexOf(keyword);
  while (index >= 0) {
    const before = title[index - 1] ?? '';
    const after = title[index + keyword.length] ?? '';
    if ((!/^\d/u.test(keyword) || !/\d/u.test(before)) &&
        (!/\d$/u.test(keyword) || !/\d/u.test(after))) return true;
    index = title.indexOf(keyword, index + 1);
  }
  return false;
}

/**
 * 关键词只解析一次。
 * filterRelevantResults 会对同一个查询过滤几百上千条结果，
 * 关键词的归一化、季数解析、分词结果对每条都相同，没必要重复算。
 */
interface PreparedQuery {
  normalized: string;
  season?: { base: string; season: number; explicit: boolean };
  tokens: string[];
}

function prepareQuery(wd: string): PreparedQuery | undefined {
  const normalized = normalizeTitle(wd);
  if (!normalized) return undefined;
  return {
    normalized,
    // 查询侧允许「庆余年2」这种无空格写法
    season: parseSeasonSuffix(wd, false, false),
    tokens: wd.trim().split(/\s+/).map(normalizeTitle).filter(Boolean),
  };
}

function matchesPrepared(nName: string, query: PreparedQuery): boolean {
  if (includesKeyword(nName, query.normalized)) return true;
  return query.tokens.length > 1 && query.tokens.every((token) => includesKeyword(nName, token));
}

function isRelevantPrepared(name: string, query: PreparedQuery): boolean {
  const nName = normalizeTitle(name);
  if (!nName) return false;
  const titleSeason = parseSeasonSuffix(name, true);
  if (query.season && titleSeason) {
    if (query.season.season !== titleSeason.season) return false;
    if (query.season.explicit || titleSeason.explicit) {
      const baseQuery = prepareQuery(query.season.base);
      if (baseQuery) return matchesPrepared(normalizeTitle(titleSeason.base), baseQuery);
    }
  }
  return matchesPrepared(nName, query);
}

/**
 * 忽略标点和大小写，多词查询要求每个词都命中。
 * 独立的末尾数字也可匹配明确的中文季数后缀；
 * 标题内部的数字与四位年份不作为季数别名。
 */
export function isRelevant(name: string, wd: string): boolean {
  const query = prepareQuery(wd);
  if (!query) return true;
  return isRelevantPrepared(name, query);
}

/** 丢弃无关结果；即使全部不相关，也不能返回源站的原始目录。 */
export function filterRelevantResults<T extends { name?: string }>(items: T[], wd: string): T[] {
  const query = prepareQuery(wd);
  if (!query) return items;
  return items.filter((item) => isRelevantPrepared(item.name || '', query));
}
