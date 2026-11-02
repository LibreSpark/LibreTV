const MAX_KEYWORD_LENGTH = 50;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const SEARCH_TIMEOUT_MS = 8000;

export type MovieItem = {
  id: string;
  title: string;
  poster: string;
  link: string;
  year: string;
  rating: string;
  overview: string;
};

function safeString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return '';
  }

  return String(value).trim().slice(0, maxLength);
}

function normalizePoster(raw: unknown): string {
  if (typeof raw !== 'string') return '';

  let url = raw.trim();

  if (!url) return '';

  if (url.startsWith('//')) {
    url = `https:${url}`;
  }

  if (!/^https?:\/\//i.test(url)) {
    return '';
  }

  return `/api/img?url=${encodeURIComponent(url)}`;
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

function normalizeMovie(raw: unknown): MovieItem | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const item = raw as Record<string, unknown>;

  const rawId =
    item.vod_id ??
    item.id ??
    item.vodId ??
    item.vid;

  const idCandidate = safeString(rawId, 30);

  const id = /^[a-zA-Z0-9_-]{1,30}$/.test(idCandidate)
    ? idCandidate
    : '';

  const title = safeString(
    item.vod_name ??
      item.name ??
      item.title ??
      '未知影片',
    50
  );

  const year = safeString(
    item.vod_year ?? item.year,
    12
  );

  const rating = safeString(
    item.vod_score ?? item.rating,
    12
  );

  const overview = safeString(
    item.vod_remarks ??
      item.overview ??
      '暂无简介',
    100
  );

  const poster = normalizePoster(
    item.vod_pic ??
      item.pic ??
      item.poster ??
      item.img ??
      ''
  );

  return {
    id,
    title,
    poster,
    link: id
      ? `/detail/${encodeURIComponent(id)}`
      : '',
    year,
    rating,
    overview,
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
): Promise<MovieItem[]> {
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

  targetUrl.searchParams.set(
    'wd',
    keyword.trim()
  );

  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, SEARCH_TIMEOUT_MS);

  try {
    const response = await fetch(targetUrl.toString(), {
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

    return rawList
      .slice(0, 30)
      .map(normalizeMovie)
      .filter((item): item is MovieItem => item !== null);
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
