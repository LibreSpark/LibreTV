import { NextResponse } from 'next/server';
import {
  searchSources,
  mergeSearchResults,
} from '@/lib/search';
import type { RegistrySearchResource, SearchResponse, SearchStreamEvent, SourceConfig, SourceSearchOutcome } from '@/lib/types';
import { guardPrivateFeatureRequest, guardRequest } from '@/lib/api-guard';
import { collectorRequest } from '@/lib/resource-collector-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_KEYWORD_LENGTH = 50;
const MAX_SOURCES = 30;
const MAX_URL_LENGTH = 2048;
const MAX_NAME_LENGTH = 100;

interface SearchRequestBody {
  wd?: unknown;
  keyword?: unknown;
  sources?: unknown;
  filterAdult?: unknown;
}

function jsonError(
  message: string,
  status: number,
) {
  return NextResponse.json(
    {
      error: message,
      items: [],
    },
    { status },
  );
}

/**
 * 流式读取请求体，避免先调用 req.json()
 * 导致超大请求体被完整载入内存。
 */
async function readLimitedBody(
  req: Request,
): Promise<string> {
  const contentLength = req.headers.get('content-length');

  if (contentLength !== null) {
    const length = Number(contentLength);

    if (
      !Number.isSafeInteger(length) ||
      length < 0
    ) {
      throw new Error('INVALID_CONTENT_LENGTH');
    }

    if (length > MAX_BODY_BYTES) {
      throw new Error('BODY_TOO_LARGE');
    }
  }

  if (!req.body) {
    throw new Error('EMPTY_BODY');
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      if (req.signal.aborted) {
        throw new Error('REQUEST_ABORTED');
      }

      const { done, value } = await reader.read();

      if (done) break;

      totalBytes += value.byteLength;

      if (totalBytes > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error('BODY_TOO_LARGE');
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const buffer = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return new TextDecoder('utf-8', {
      fatal: true,
    }).decode(buffer);
  } catch {
    throw new Error('INVALID_UTF8');
  }
}

/**
 * 只负责验证来源配置的数据结构和 URL 格式。
 *
 * 真正的 SSRF、DNS 和重定向安全检查，
 * 由 searchSources -> fetchUpstream -> ssrf 安全层负责。
 */
function validateSources(
  rawSources: unknown,
): SourceConfig[] {
  if (rawSources === undefined) {
    return [];
  }

  if (!Array.isArray(rawSources)) {
    throw new Error('INVALID_SOURCES');
  }

  if (rawSources.length > MAX_SOURCES) {
    throw new Error('TOO_MANY_SOURCES');
  }

  const sources: SourceConfig[] = [];
  const seenKeys = new Set<string>();

  for (const raw of rawSources) {
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw)
    ) {
      throw new Error('INVALID_SOURCE');
    }

    const item = raw as Record<string, unknown>;

    if (
      typeof item.key !== 'string' ||
      typeof item.name !== 'string' ||
      typeof item.url !== 'string'
    ) {
      throw new Error('INVALID_SOURCE_FIELDS');
    }

    const key = item.key.trim();
    const name = item.name.trim();
    const url = item.url.trim();

    if (
      !key ||
      key.length > MAX_NAME_LENGTH ||
      !name ||
      name.length > MAX_NAME_LENGTH ||
      !url ||
      url.length > MAX_URL_LENGTH
    ) {
      throw new Error('INVALID_SOURCE_FIELDS');
    }

    let parsed: URL;

    try {
      parsed = new URL(url);
    } catch {
      throw new Error('INVALID_SOURCE_URL');
    }

    if (
      parsed.protocol !== 'http:' &&
      parsed.protocol !== 'https:'
    ) {
      throw new Error('INVALID_SOURCE_PROTOCOL');
    }

    if (
      parsed.username ||
      parsed.password ||
      !parsed.hostname
    ) {
      throw new Error('INVALID_SOURCE_URL');
    }

    if (seenKeys.has(key)) {
      continue;
    }

    seenKeys.add(key);

    const source: SourceConfig = {
      key,
      name,
      url: parsed.toString(),
      isAdult: item.isAdult === true,
    };

    if (typeof item.detail === 'string') {
      source.detail = item.detail.slice(0, 2048);
    }

    sources.push(source);
  }

  return sources;
}

const SEARCH_CACHE_TTL_MS = 30_000;
const SEARCH_CACHE_MAX_ENTRIES = 100;
const searchCache = new Map<string, { expiresAt: number; outcomes: SourceSearchOutcome[] }>();

function makeCacheKey(keyword: string, sources: SourceConfig[], filterAdult: boolean): string {
  return JSON.stringify([keyword, filterAdult, sources]);
}

function getCachedOutcomes(key: string): SourceSearchOutcome[] | undefined {
  const entry = searchCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    searchCache.delete(key);
    return undefined;
  }
  return entry.outcomes;
}

function setCachedOutcomes(key: string, outcomes: SourceSearchOutcome[]): void {
  if (searchCache.size >= SEARCH_CACHE_MAX_ENTRIES) {
    const oldestKey = searchCache.keys().next().value;
    if (oldestKey) searchCache.delete(oldestKey);
  }
  searchCache.set(key, {
    expiresAt: Date.now() + SEARCH_CACHE_TTL_MS,
    outcomes,
  });
}

async function searchVerifiedRegistry(keyword: string, request?: Request): Promise<RegistrySearchResource[]> {
  try {
    const response = await collectorRequest(
      `/v1/registry/search?q=${encodeURIComponent(keyword)}`,
      {},
      1_500,
      request,
    );
    if (!response.ok) return [];
    const payload = await response.json() as { resources?: unknown };
    return Array.isArray(payload.resources) ? payload.resources as RegistrySearchResource[] : [];
  } catch {
    // Registry is supplemental: a collector outage must never fail normal CMS search.
    return [];
  }
}

async function searchSeedHubCatalog(keyword: string, request?: Request): Promise<import('@/lib/types').SeedHubSearchItem[]> {
  try {
    const response = await collectorRequest(
      `/v1/seedhub/search?q=${encodeURIComponent(keyword)}&limit=20`,
      {},
      1_500,
      request,
    );
    if (!response.ok) return [];
    const payload = await response.json() as { items?: unknown };
    if (!Array.isArray(payload.items)) return [];
    return payload.items.filter((raw): raw is import('@/lib/types').SeedHubSearchItem => {
      if (!raw || typeof raw !== 'object') return false;
      const item = raw as Record<string, unknown>;
      if (typeof item.source_url !== 'string' || typeof item.title !== 'string' ||
          !['movies', 'series', 'anime'].includes(String(item.category))) return false;
      try {
        const source = new URL(item.source_url);
        const sourcePath = source.pathname.split('/').filter(Boolean);
        if (source.protocol !== 'https:' || source.hostname !== 'www.seedhub.cc' ||
            sourcePath.length !== 2 || !['movies', 'series', 'anime'].includes(sourcePath[0]) ||
            !/^\d+$/.test(sourcePath[1])) return false;
        if (item.poster_url == null) return true;
        if (typeof item.poster_url !== 'string') return false;
        const poster = new URL(item.poster_url);
        return poster.protocol === 'https:' &&
          ['www.seedhub.cc', 'img.seedhub.cc', 'sh1.pcie.pppoe.top'].includes(poster.hostname);
      } catch {
        return false;
      }
    }) as import('@/lib/types').SeedHubSearchItem[];
  } catch {
    // SeedHub catalogue is supplemental and never blocks the regular CMS search.
    return [];
  }
}

function toSearchResponse(outcomes: SourceSearchOutcome[]): SearchResponse {
  return {
    list: mergeSearchResults(outcomes),
    failures: outcomes
      .filter((outcome) => !outcome.ok)
      .map((outcome) => ({
        sourceKey: outcome.sourceKey,
        error: outcome.error || '请求失败',
        timedOut: outcome.timedOut,
      })),
  };
}

function ndjsonResponse(
  req: Request,
  keyword: string,
  sources: SourceConfig[],
  filterAdult: boolean,
  cacheKey: string,
  cached: SourceSearchOutcome[] | undefined,
): Response {
  const abortController = new AbortController();
  let cancelled = false;
  const abortFromRequest = () => abortController.abort(req.signal.reason);

  if (req.signal.aborted) abortFromRequest();
  else req.signal.addEventListener('abort', abortFromRequest, { once: true });

  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      const encoder = new TextEncoder();

      const send = (event: SearchStreamEvent) => {
        if (cancelled || abortController.signal.aborted) return;
        try {
          streamController.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          cancelled = true;
          abortController.abort();
        }
      };

      void (async () => {
        try {
          const registryPromise = searchVerifiedRegistry(keyword, req);
          const seedhubPromise = searchSeedHubCatalog(keyword, req);
          const outcomes = cached ?? await searchSources(keyword, sources, {
            filterAdult,
            signal: abortController.signal,
            onOutcome: (outcome) => send({ type: 'source', ...outcome }),
          });

          if (!cached && !abortController.signal.aborted) {
            setCachedOutcomes(cacheKey, outcomes);
          }

          if (!abortController.signal.aborted) {
            const [registryResources, seedhubItems] = await Promise.all([registryPromise, seedhubPromise]);
            const result = toSearchResponse(outcomes);
            send({ type: 'done', ...result, ...(registryResources.length ? { registryResources } : {}), ...(seedhubItems.length ? { seedhubItems } : {}) });
          }
        } catch {
          if (!abortController.signal.aborted) {
            send({
              type: 'done',
              list: [],
              failures: [{ sourceKey: '__search__', error: '搜索服务暂时不可用' }],
            });
          }
        } finally {
          req.signal.removeEventListener('abort', abortFromRequest);
          if (!cancelled) {
            try {
              streamController.close();
            } catch {
              // 客户端可能已关闭流。
            }
          }
        }
      })();
    },
    cancel(reason) {
      cancelled = true;
      abortController.abort(reason);
      req.signal.removeEventListener('abort', abortFromRequest);
    },
  });

  return new Response(body, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  });
}

export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  if (req.headers.has('x-scrapling-api-base') || req.headers.has('x-scrapling-api-token')) {
    const collectorGuard = guardPrivateFeatureRequest(req);
    if (collectorGuard) return collectorGuard;
  }

  try {
    if (req.signal.aborted) {
      return jsonError('请求已取消', 400);
    }

    let rawBody: string;
    try {
      rawBody = await readLimitedBody(req);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'BODY_TOO_LARGE') return jsonError('请求体不能超过 64 KB', 413);
      if (code === 'REQUEST_ABORTED') return jsonError('请求已取消', 400);
      if (code === 'EMPTY_BODY') return jsonError('请求内容为空', 400);
      return jsonError('请求内容格式无效', 400);
    }

    let body: SearchRequestBody;
    try {
      body = JSON.parse(rawBody) as SearchRequestBody;
    } catch {
      return jsonError('JSON 格式错误', 400);
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return jsonError('请求参数格式错误', 400);
    }

    const rawKeyword =
      typeof body.wd === 'string' && body.wd.trim()
        ? body.wd
        : body.keyword;

    if (typeof rawKeyword !== 'string') return jsonError('缺少搜索关键词', 400);

    const keyword = rawKeyword.trim();
    if (!keyword) return jsonError('缺少搜索关键词', 400);
    if (keyword.length > MAX_KEYWORD_LENGTH) {
      return jsonError('搜索关键词不能超过 50 个字符', 400);
    }

    let sources: SourceConfig[];
    try {
      sources = validateSources(body.sources);
    } catch {
      return jsonError('资源站配置无效', 400);
    }

    const filterAdult = body.filterAdult === true;
    const cacheKey = makeCacheKey(keyword, sources, filterAdult);
    const cached = getCachedOutcomes(cacheKey);
    const wantsStream = new URL(req.url).searchParams.get('stream') === '1';

    if (wantsStream) {
      return ndjsonResponse(req, keyword, sources, filterAdult, cacheKey, cached);
    }

    const registryPromise = searchVerifiedRegistry(keyword, req);
    const seedhubPromise = searchSeedHubCatalog(keyword, req);
    const outcomes = cached ?? await searchSources(keyword, sources, {
      filterAdult,
      signal: req.signal,
    });

    if (req.signal.aborted) return jsonError('请求已取消', 400);
    if (!cached) setCachedOutcomes(cacheKey, outcomes);
    const [registryResources, seedhubItems] = await Promise.all([registryPromise, seedhubPromise]);

    return NextResponse.json({ ...toSearchResponse(outcomes), ...(registryResources.length ? { registryResources } : {}), ...(seedhubItems.length ? { seedhubItems } : {}) }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return jsonError('搜索服务暂时不可用，请稍后重试', 500);
  }
}
