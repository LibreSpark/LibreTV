import { fetchUpstream } from '@/lib/fetch-utils';
import type { SearchResultItem } from '@/lib/types';

const MAX_KEYWORD_LENGTH = 50;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const SEARCH_TIMEOUT_MS = 8000;

const FRIDAY_SOURCE_KEY = 'friday-cms';

function safeString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return '';
  }

  return String(value).trim().slice(0, maxLength);
}

function normalizePoster(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;

  let url = raw.trim();

  if (!url) return undefined;

  if (url.startsWith('//')) {
    url = `https:${url}`;
  }

  try {
    const parsed = new URL(url);

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return undefined;
    }

    return `/api/img?url=${encodeURIComponent(parsed.toString())}`;
  } catch {
    return undefined;
  }
}

function extractMovieArray(data: unknown, depth = 0): unknown[] {
  if (!data || typeof data !== 'object' || depth > 5) {
    return [];
  }

  if (Array.isArray(data)) {
    return data;
  }

  const obj = data as Record<string, unknown>;

  if (Array.isArray(obj.list)) return obj.list;
  if (Array.isArray(obj.data)) return obj.data;

  if (
    obj.data &&
    typeof obj.data === 'object' &&
    Array.isArray((obj.data as Record<string, unknown>).list)
  ) {
    return (obj.data as Record<string, unknown>).list as unknown[];
  }

  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) {
      if (
        value.length > 0 &&
        value[0] !== null &&
        typeof value[0] === 'object'
      ) {
        return value;
      }
    }

    if (value && typeof value === 'object') {
      const result = extractMovieArray(value, depth + 1);

      if (result.length > 0) {
        return result;
      }
    }
  }

  return [];
}

function normalizeMovie(
  raw: unknown,
  sourceUrl: string,
  sourceName: string
): SearchResultItem | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const item = raw as Record<string, unknown>;

  const rawId =
    item.vod_id ??
    item.id ??
    item.vodId ??
    item.vid;

  const vodIdCandidate = safeString(rawId, 30);

  const vodId = /^[a-zA-Z0-9_-]{1,30}$/.test(vodIdCandidate)
    ? vodIdCandidate
    : '';

  if (!vodId) {
    return null;
  }

  const name = safeString(
    item.vod_name ??
      item.name ??
      item.title ??
      '未知影片',
    50
  );

  if (!name) {
    return null;
  }

  const pic = normalizePoster(
    item.vod_pic ??
      item.pic ??
      item.poster ??
      item.img ??
      ''
  );

  const typeName = safeString(
    item.type_name ??
      item.typeName ??
      item.vod_class,
    50
  );

  const year = safeString(
    item.vod_year ?? item.year,
    12
  );

  const area = safeString(
    item.vod_area ?? item.area,
    30
  );

  const remarks = safeString(
    item.vod_remarks ??
      item.remarks ??
      item.vod_note,
    100
  );

  return {
    sourceKey: FRIDAY_SOURCE_KEY,
    sourceName,
    sourceUrl,
    vodId,
    name,
    ...(pic ? { pic } : {}),
    ...(typeName ? { typeName } : {}),
    ...(year ? { year } : {}),
    ...(area ? { area } : {}),
    ...(remarks ? { remarks } : {}),
  };
}

async function readLimitedResponse(
  response: Response,
  controller: AbortController
): Promise<string> {
  if (!response.body) {
    throw new Error('搜索接口没有返回响应内容');
  }

  const contentLength = Number(
    response.headers.get('content-length') || 0
  );

  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_RESPONSE_BYTES
  ) {
    controller.abort();
    throw new Error('搜索响应超过大小限制');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let received = 0;
  let result = '';

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      received += value.byteLength;

      if (received > MAX_RESPONSE_BYTES) {
        controller.abort();

        try {
          await reader.cancel();
        } catch {}

        throw new Error('搜索响应超过大小限制');
      }

      result += decoder.decode(value, {
        stream: true,
      });
    }

    result += decoder.decode();

    return result;
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
}

export async function searchMovies(
  keyword: string
): Promise<SearchResultItem[]> {
  if (
    typeof keyword !== 'string' ||
    !keyword.trim() ||
    keyword.trim().length > MAX_KEYWORD_LENGTH
  ) {
    throw new Error('搜索关键词无效');
  }

  const cmsBase = process.env.CMS_SEARCH_API;

  if (!cmsBase) {
    throw new Error('未配置 CMS_SEARCH_API');
  }

  let targetUrl: URL;

  try {
    targetUrl = new URL(cmsBase);
  } catch {
    throw new Error('CMS_SEARCH_API 配置错误');
  }

  if (
    targetUrl.protocol !== 'https:' &&
    targetUrl.protocol !== 'http:'
  ) {
    throw new Error('搜索接口协议不合法');
  }

  // 详情接口需要的是 CMS API 根地址，不能携带搜索关键词 wd。
  const sourceUrlObject = new URL(targetUrl.toString());
  sourceUrlObject.searchParams.delete('wd');
  sourceUrlObject.hash = '';

  const sourceUrl = sourceUrlObject.toString();
  const sourceName =
    safeString(process.env.CMS_SOURCE_NAME, 50) || 'Friday CMS';

  targetUrl.searchParams.set('wd', keyword.trim());

  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, SEARCH_TIMEOUT_MS);

  try {
    // 通过项目统一上游请求工具，沿用现有公网地址及重定向检查。
    const response = await fetchUpstream(targetUrl.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'LibreTV/2.1',
      },
      signal: controller.signal,
      cache: 'no-store',
    });

    if (!response.ok) {
      throw new Error(
        `搜索上游返回 HTTP ${response.status}`
      );
    }

    const contentType =
      response.headers.get('content-type') || '';

    if (
      !contentType.includes('json') &&
      !contentType.includes('text')
    ) {
      throw new Error('搜索接口返回了不支持的数据格式');
    }

    const responseText = await readLimitedResponse(
      response,
      controller
    );

    let data: unknown;

    try {
      data = JSON.parse(responseText);
    } catch {
      throw new Error('搜索接口返回的 JSON 无效');
    }

    const rawList = extractMovieArray(data);

    const result = rawList
      .slice(0, 30)
      .map((item) =>
        normalizeMovie(item, sourceUrl, sourceName)
      )
      .filter(
        (item): item is SearchResultItem => item !== null
      );

    return result;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('搜索请求超时或响应过大');
    }

    throw error instanceof Error
      ? error
      : new Error('搜索接口请求失败');
  } finally {
    clearTimeout(timer);
  }
}
