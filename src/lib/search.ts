
import { fetchUpstream } from '@/lib/fetch-utils';
import type {
  SearchResultItem,
  SourceConfig,
  SourceSearchOutcome,
} from '@/lib/types';

const MAX_KEYWORD_LENGTH = 50;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_RESULTS_PER_SOURCE = 30;
const MAX_SOURCES = 30;
const SEARCH_TIMEOUT_MS = 8000;
const SEARCH_TOTAL_TIMEOUT_MS = 16000;
const MAX_CONCURRENT_SOURCES = 6;

function safeString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return '';
  }

  return String(value).trim().slice(0, maxLength);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.slice(0, 200);
  }

  return '未知搜索错误';
}

function normalizePoster(
  raw: unknown,
  baseUrl: string,
): string | undefined {
  if (typeof raw !== 'string') return undefined;

  let url = raw.trim();
  if (!url) return undefined;

  if (url.startsWith('//')) {
    url = `https:${url}`;
  } else if (url.startsWith('/')) {
    try {
      url = `${new URL(baseUrl).origin}${url}`;
    } catch {
      return undefined;
    }
  }

  try {
    const parsed = new URL(url);

    if (
      parsed.protocol !== 'http:' &&
      parsed.protocol !== 'https:'
    ) {
      return undefined;
    }

    return `/api/img?url=${encodeURIComponent(parsed.toString())}`;
  } catch {
    return undefined;
  }
}

function extractMovieArray(data: unknown): unknown[] {
  if (!data || typeof data !== 'object') return [];

  const record = data as Record<string, unknown>;

  if (Array.isArray(record.list)) {
    return record.list;
  }

  if (Array.isArray(record.items)) {
    return record.items;
  }

  if (Array.isArray(record.data)) {
    return record.data;
  }

  if (
    record.data &&
    typeof record.data === 'object'
  ) {
    const nested = record.data as Record<string, unknown>;

    if (Array.isArray(nested.list)) {
      return nested.list;
    }
    if (Array.isArray(nested.items)) {
      return nested.items;
    }
  }

  return [];
}

async function readLimitedResponse(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  if (!response.body) {
    throw new Error('资源接口没有返回内容');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let received = 0;
  let result = '';

  try {
    while (true) {
      if (signal.aborted) {
        throw new DOMException(
          '请求已取消',
          'AbortError',
        );
      }

      const { done, value } = await reader.read();

      if (done) break;

      received += value.byteLength;

      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);

        throw new Error(
          '资源接口响应超过 5MB 限制',
        );
      }

      result += decoder.decode(value, {
        stream: true,
      });
    }

    result += decoder.decode();

    return result;
  } finally {
    reader.releaseLock();
  }
}

function buildSearchUrl(
  sourceUrl: string,
  keyword: string,
  sourceKey: string,
): URL {
  if (
    typeof sourceUrl !== 'string' ||
    sourceUrl.length > 2048
  ) {
    throw new Error('资源接口地址无效');
  }

  const url = new URL(sourceUrl);

  if (
    url.protocol !== 'http:' &&
    url.protocol !== 'https:'
  ) {
    throw new Error('只允许 HTTP 或 HTTPS 地址');
  }

  if (url.username || url.password) {
    throw new Error('接口地址不能包含登录凭据');
  }

  // KKPhim 是独立 REST API，不是 Apple CMS；只允许其固定 HTTPS 主机。
  if (sourceKey === 'kkphim' || url.hostname.toLowerCase() === 'phimapi.com') {
    if (url.hostname.toLowerCase() !== 'phimapi.com' || url.origin !== 'https://phimapi.com' || url.pathname !== '/') {
      throw new Error('KKPhim 仅允许 https://phimapi.com 根地址');
    }
    const target = new URL('/v1/api/tim-kiem', url.origin);
    target.searchParams.set('keyword', keyword);
    target.searchParams.set('limit', String(MAX_RESULTS_PER_SOURCE));
    return target;
  }

  // 已经包含 PHP 接口路径时，不重复拼接。
  if (!/\.php(?:\/|$)/i.test(url.pathname)) {
    const basePath = url.pathname.replace(/\/+$/, '');

    url.pathname = `${basePath}/api.php/provide/vod`;
  }

  url.searchParams.set('ac', 'videolist');
  url.searchParams.set('wd', keyword);

  return url;
}

function normalizeMovie(
  raw: unknown,
  source: SourceConfig,
): SearchResultItem | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const item = raw as Record<string, unknown>;

  const isKkPhim = (() => {
    try { return new URL(source.url).hostname.toLowerCase() === 'phimapi.com'; }
    catch { return false; }
  })();

  const vodId = safeString(
    (isKkPhim ? item.slug : undefined) ??
      item.vod_id ??
      item.id ??
      item.vodId ??
      item.vid,
    100,
  );

  const name = safeString(
    item.vod_name ??
      item.name ??
      item.title,
    100,
  );

  if (!vodId || !name) {
    return null;
  }

  const score = safeString(item.vod_score, 12);

  const kkRemarks = isKkPhim
    ? [item.quality, item.lang, item.episode_current]
        .map((value) => safeString(value, 24))
        .filter(Boolean)
        .join(' · ')
    : '';

  const remarks = kkRemarks || (score
    ? `⭐ ${score}`
    : safeString(
        item.vod_remarks ?? item.remarks,
        50,
      ));

  return {
    sourceKey: source.key,
    sourceName: source.name,
    sourceUrl: source.url,
    vodId,
    name,
    pic: normalizePoster(
      (isKkPhim ? item.poster_url ?? item.thumb_url : undefined) ??
        item.vod_pic ??
        item.pic ??
        item.poster ??
        item.img,
      source.url,
    ),
    typeName: safeString(
      (isKkPhim
        ? (item.type === 'single' ? '电影' : item.type === 'series' ? '电视剧' : item.type)
        : undefined) ?? item.type_name ?? item.typeName,
      40,
    ),
    year: safeString(
      item.vod_year ?? item.year,
      12,
    ),
    area: safeString(
      (isKkPhim && Array.isArray(item.country)
        ? item.country.map((entry) => entry && typeof entry === 'object' ? safeString((entry as Record<string, unknown>).name, 30) : '').filter(Boolean).join(' / ')
        : undefined) ?? item.vod_area ?? item.area,
      30,
    ),
    remarks,
    isAdult: source.isAdult === true,
  };
}

async function fetchFromSource(
  keyword: string,
  source: SourceConfig,
  externalSignal?: AbortSignal,
): Promise<SourceSearchOutcome> {
  const startedAt = Date.now();

  if (externalSignal?.aborted) {
    return {
      sourceKey: source.key,
      ok: false,
      list: [],
      error: '请求已取消',
      ms: 0,
    };
  }

  const controller = new AbortController();

  let timedOut = false;

  const abortFromExternal = () => {
    controller.abort();
  };

  externalSignal?.addEventListener(
    'abort',
    abortFromExternal,
    { once: true },
  );

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, SEARCH_TIMEOUT_MS);

  try {
    const targetUrl = buildSearchUrl(
      source.url,
      keyword,
      source.key,
    );

    // 所有用户配置的上游请求必须经过项目安全请求层。
    // 不允许关闭安全重定向检查，也不允许放行内网地址。
    const response = await fetchUpstream(
      targetUrl.toString(),
      {
        method: 'GET',
        headers: {
          Accept: 'application/json,text/plain,*/*',
          'User-Agent': 'Mozilla/5.0',
        },
        signal: controller.signal,
        cache: 'no-store',
        timeoutMs: SEARCH_TIMEOUT_MS,
        retries: 0,
      },
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const text = await readLimitedResponse(
      response,
      controller.signal,
    );

    let data: unknown;

    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('资源接口返回的不是有效 JSON');
    }

    const rawList = extractMovieArray(data);

    const list = rawList
      .slice(0, MAX_RESULTS_PER_SOURCE)
      .map(item => normalizeMovie(item, source))
      .filter(
        (item): item is SearchResultItem =>
          item !== null,
      );

    return {
      sourceKey: source.key,
      ok: true,
      list,
      ms: Date.now() - startedAt,
    };
  } catch (error) {
    const totalTimedOut = externalSignal?.reason instanceof Error && externalSignal.reason.name === 'TimeoutError';
    const externallyCancelled = externalSignal?.aborted === true && !totalTimedOut;

    return {
      sourceKey: source.key,
      ok: false,
      list: [],
      error: timedOut || totalTimedOut
        ? '搜索总时间超时'
        : externallyCancelled
          ? '请求已取消'
          : getErrorMessage(error),
      timedOut: timedOut || totalTimedOut,
      ms: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);

    externalSignal?.removeEventListener(
      'abort',
      abortFromExternal,
    );
  }
}

export async function searchSources(
  keyword: string,
  sources: SourceConfig[],
  options?: {
    filterAdult?: boolean;
    signal?: AbortSignal;
    onOutcome?: (outcome: SourceSearchOutcome) => void;
  },
): Promise<SourceSearchOutcome[]> {
  const safeKeyword = safeString(
    keyword,
    MAX_KEYWORD_LENGTH,
  );

  if (!safeKeyword) return [];

  if (!Array.isArray(sources) || sources.length === 0) {
    return [];
  }

  const uniqueSources = new Map<
    string,
    SourceConfig
  >();

  for (const source of sources) {
    if (!source || typeof source !== 'object') {
      continue;
    }

    if (
      typeof source.key !== 'string' ||
      typeof source.name !== 'string' ||
      typeof source.url !== 'string'
    ) {
      continue;
    }

    const key = source.key.trim();
    const name = source.name.trim();
    const url = source.url.trim();

    if (
      !key ||
      key.length > 100 ||
      !name ||
      name.length > 100 ||
      !url ||
      url.length > 2048
    ) {
      continue;
    }

    if (
      options?.filterAdult &&
      source.isAdult === true
    ) {
      continue;
    }

    if (!uniqueSources.has(key)) {
      uniqueSources.set(key, {
        ...source,
        key,
        name,
        url,
      });
    }

    // 防止大量配置拖垮搜索任务。
    if (uniqueSources.size >= MAX_SOURCES) {
      break;
    }
  }

  const sourceList = Array.from(
    uniqueSources.values(),
  );

  const outcomes: SourceSearchOutcome[] = [];
  const totalController = new AbortController();
  const abortFromCaller = () => totalController.abort(options?.signal?.reason);
  if (options?.signal?.aborted) abortFromCaller();
  else options?.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const totalTimer = setTimeout(() => {
    totalController.abort(new DOMException('搜索总时间超时', 'TimeoutError'));
  }, SEARCH_TOTAL_TIMEOUT_MS);
  const effectiveSignal = totalController.signal;

  try {
  for (
    let offset = 0;
    offset < sourceList.length;
    offset += MAX_CONCURRENT_SOURCES
  ) {
    if (effectiveSignal.aborted) {
      break;
    }

    const batch = sourceList.slice(
      offset,
      offset + MAX_CONCURRENT_SOURCES,
    );

    const batchResults = await Promise.all(
      batch.map(async (source) => {
        const outcome = await fetchFromSource(
          safeKeyword,
          source,
          effectiveSignal,
        );

        // 过滤掉明显非影视类别；成人内容只在用户开启过滤时移除。
        if (outcome.ok) {
          const seenVodIds = new Set<string>();
          outcome.list = outcome.list.filter((item) => {
            // 同一资源站内重复 vod_id 只保留首次出现的条目。
            if (seenVodIds.has(item.vodId)) return false;
            seenVodIds.add(item.vodId);

            const category = item.typeName || '';
            if (/足球|篮球|网球|排球|棒球|体育|赛事/.test(category)) {
              return false;
            }
            if (
              options?.filterAdult &&
              (item.isAdult === true ||
                /成人|色情|情色|福利视频|无码|三级|伦理|\bAV\b/i.test(
                  `${item.typeName || ''} ${item.name || ''}`,
                ))
            ) {
              return false;
            }
            return true;
          });
        }

        try {
          options?.onOutcome?.(outcome);
        } catch {
          // 单个流式消费者回调失败不能中断其余来源的搜索。
        }
        return outcome;
      }),
    );

    outcomes.push(...batchResults);
  }
  } finally {
    clearTimeout(totalTimer);
    options?.signal?.removeEventListener('abort', abortFromCaller);
  }

  return outcomes;
}

export function mergeSearchResults(
  outcomes: SourceSearchOutcome[],
): SearchResultItem[] {
  const resultMap = new Map<
    string,
    SearchResultItem
  >();

  for (const outcome of outcomes) {
    if (
      !outcome.ok ||
      !Array.isArray(outcome.list)
    ) {
      continue;
    }

    for (const item of outcome.list) {
      if (
        !item?.sourceKey ||
        !item?.vodId
      ) {
        continue;
      }

      // 不同资源站的相同影片 ID 不会被错误合并。
      const key =
        `${item.sourceKey}\u0000${item.vodId}`;

      if (!resultMap.has(key)) {
        resultMap.set(key, item);
      }
    }
  }

  return Array.from(resultMap.values());
}
