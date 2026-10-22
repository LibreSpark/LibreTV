'use client';

import type { SearchResponse, SearchStreamEvent, SourceSearchOutcome, VideoDetail, DoubanResponse, BangumiCalendarResponse, AuthStatusResponse, SourceConfig, SearchResultItem, LivePlaylistResponse, LiveEpgResponse, SourceListPayload, QualityProbeItem, QualityProbeResult } from './types';
import { dedupeAndSortResults } from './cms-parser';

/**
 * 客户端 API 封装。401 时触发全局事件打开登录框，
 * 替代旧版在每个函数里手工检查 isPasswordVerified 的散弹式写法。
 */

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const UNAUTHORIZED_EVENT = 'libretv:unauthorized';

/** 单条测活结果（/api/live/probe，JSON 与 NDJSON 流共用同一结构） */
export interface LiveProbeResult {
  url: string;
  ok: boolean;
  status?: number;
  /** 分片级探测：仅统计分片往返耗时 */
  ms?: number;
  /** segment=分片级（最可信）/ manifest=仅列表可达 / head=直链单级 */
  level?: 'segment' | 'manifest' | 'head';
  error?: string;
  /** master playlist 的 CODECS，用于前端提示 H.265 等不可解码情况 */
  codec?: string;
  /** 因超时失败：源可能只是慢，前端以琥珀色区分于真正的不可达 */
  timedOut?: boolean;
  /** 分片吞吐估算（kbps）：低于阈值的源前端标记为「源限速」 */
  kbps?: number;
}

/** /api/status 的 React Query key：Providers 与 AuthProvider 共用，避免同一页面重复请求 */
export const STATUS_QUERY_KEY = ['app-status'] as const;

export function onUnauthorized(handler: (event: CustomEvent) => void): () => void {
  const wrapped = (e: Event) => handler(e as CustomEvent);
  window.addEventListener(UNAUTHORIZED_EVENT, wrapped);
  return () => window.removeEventListener(UNAUTHORIZED_EVENT, wrapped);
}

/** 401/503 统一处理：分发全局事件打开登录框并抛 ApiError（普通与流式请求共用） */
function throwForAuthStatus(res: Response): void {
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    throw new ApiError('需要登录', 401);
  }
  if (res.status === 503) {
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT, { detail: 'setup' }));
    throw new ApiError('服务器未配置密码', 503);
  }
}

/** NDJSON 流读取：按行解析 JSON 并回调，坏行跳过不影响其余结果 */
async function consumeNdjson<T>(res: Response, onEvent: (event: T) => void): Promise<void> {
  if (!res.body) throw new ApiError(`请求失败 (${res.status})`, res.status);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const consume = (line: string) => {
    const text = line.trim();
    if (!text) return;
    try {
      onEvent(JSON.parse(text) as T);
    } catch {
      // 坏行跳过，不影响其余结果
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      consume(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
    }
  }
  buffer += decoder.decode();
  consume(buffer);
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError('网络请求失败，请检查网络连接', 0);
  }
  throwForAuthStatus(res);
  if (!res.ok) {
    let msg = `请求失败 (${res.status})`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data?.error) msg = data.error;
    } catch { /* 忽略解析失败 */ }
    throw new ApiError(msg, res.status);
  }
  return (await res.json()) as T;
}

export const api = {
  status: () => request<AuthStatusResponse>('/api/status'),

  login: (password: string) =>
    request<{ success: boolean }>('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    }),

  logout: () => request<{ success: boolean }>('/api/auth', { method: 'DELETE' }),

  /**
   * 聚合搜索。传入 onSource 时走 /api/search?stream=1 的 NDJSON 流：
   * 每个源结算立即回调（健康源结果不再等坏源超时），最终以聚合结果 resolve。
   * 未传 onSource 或流不可用时回退为一次性 JSON 请求。
   */
  search: async (
    wd: string,
    sources: SourceConfig[],
    filterAdult: boolean,
    opts?: { signal?: AbortSignal; onSource?: (outcome: SourceSearchOutcome) => void }
  ): Promise<SearchResponse> => {
    const signal = opts?.signal;
    const onSource = opts?.onSource;
    if (!onSource) {
      return request<SearchResponse>('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wd, sources, filterAdult }),
        signal,
      });
    }
    return searchStream(wd, sources, filterAdult, onSource, signal);
  },

  detail: (id: string, source: SourceConfig, signal?: AbortSignal) => {
    const sp = new URLSearchParams({ id, source: JSON.stringify(source) });
    return request<VideoDetail>(`/api/detail?${sp.toString()}`, { signal });
  },

  /**
   * 批量画质探测（NDJSON 流式）：展开来源面板时逐条回调，先到的源先显示画质。
   * 结果里的 height 缺失代表「测不出」（单码率 m3u8 / 直链 / 防盗链），不是失败。
   *
   * 传输层失败（请求没发出去 / 流中途断开）不再原样冒泡：调用方原先只能静默成
   * 「未测到」，线上出问题时无法区分「网关拦了」「容器崩了」「探测本身失败」。
   * 服务端开流即写一行心跳，收到过首字节说明请求确实进了应用，据此给出不同文案。
   */
  qualityProbeStream: async (
    items: QualityProbeItem[],
    onResult: (result: QualityProbeResult) => void,
    signal?: AbortSignal
  ): Promise<void> => {
    let res: Response;
    try {
      res = await fetch('/api/quality?stream=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
        signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      throw new ApiError('探测请求没能送达服务器（网络或反向代理中断）', 0);
    }
    throwForAuthStatus(res);
    if (!res.ok || !res.body) throw new ApiError(`请求失败 (${res.status})`, res.status);

    let firstByte = false;
    try {
      await consumeNdjson<QualityProbeResult | { ping: true }>(res, (event) => {
        // 心跳行不是结果：收到它就证明请求确实进了 Next，后面的失败才归因于探测本身
        if ('ping' in event) {
          firstByte = true;
          return;
        }
        firstByte = true;
        onResult(event);
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      throw new ApiError(
        firstByte
          ? '探测连接中途被断开（已收到部分结果，多为网关超时）'
          : '探测请求被网关拦截（未收到任何响应）',
        0
      );
    }
  },

  douban: (type: 'movie' | 'tv', tag: string, pageStart: number, pageSize: number, signal?: AbortSignal) => {
    const sp = new URLSearchParams({ type, tag, pageStart: String(pageStart), pageSize: String(pageSize) });
    return request<DoubanResponse>(`/api/douban?${sp.toString()}`, { signal });
  },

  /** Bangumi 每日放送（免 key），首页推荐的另一数据源 */
  bangumiCalendar: (signal?: AbortSignal) => request<BangumiCalendarResponse>('/api/bangumi/calendar', { signal }),

  /** 影视热榜（60s API 免 key）：豆瓣周榜五个类目 + 百度热播剧 */
  hotList: (id: string, signal?: AbortSignal) => {
    const sp = new URLSearchParams({ id });
    return request<DoubanResponse>(`/api/hot-list?${sp.toString()}`, { signal });
  },

  /** 换源：按标题跨源搜索并取详情，附带接口耗时（测速）；支持 signal 以便关闭弹窗时中止在途请求 */
  detailSpeed: async (id: string, source: SourceConfig, signal?: AbortSignal) => {
    const start = performance.now();
    try {
      const detail = await api.detail(id, source, signal);
      return { ok: true, ms: Math.round(performance.now() - start), detail };
    } catch (err) {
      return { ok: false, ms: Math.round(performance.now() - start), detail: undefined as VideoDetail | undefined, error: err instanceof Error ? err.message : '失败' };
    }
  },

  /** 点播源探活：以搜索 "test" 的耗时与结果量衡量可用性 */
  testSource: (url: string) =>
    request<{ ok: boolean; ms: number; count?: number; error?: string }>('/api/source/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    }),

  /** 拉取远程数据源订阅（自动识别 LibreTV-SourceList JSON 与 TVBOX 配置 JSON） */
  fetchSourceList: (url: string) => {
    const sp = new URLSearchParams({ url });
    return request<SourceListPayload>(`/api/source-list?${sp.toString()}`);
  },

  /** 把源列表发布到公开粘贴板换回订阅链接（走服务端代理：绕开 CORS，且目标域名固定不可控） */
  publishSourceList: (payload: {
    name?: string;
    sources: { name: string; url: string }[];
    liveSources: { name: string; url: string; epg?: string }[];
  }) =>
    request<{ url: string; provider: string; sources: number; liveSources: number }>('/api/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),

  /** —— 直播 / IPTV —— */

  /** 拉取并解析 M3U 订阅；force=1 跳过服务端缓存 */
  livePlaylist: (url: string, force = false, signal?: AbortSignal) => {
    const sp = new URLSearchParams({ url });
    if (force) sp.set('force', '1');
    return request<LivePlaylistResponse>(`/api/live/playlist?${sp.toString()}`, { signal });
  },

  /** 查询某频道的节目单（服务端缓存 6h） */
  liveEpg: (epgUrl: string, tvgId: string, force = false, signal?: AbortSignal) => {
    const sp = new URLSearchParams({ url: epgUrl, channel: tvgId });
    if (force) sp.set('force', '1');
    return request<LiveEpgResponse>(`/api/live/epg?${sp.toString()}`, { signal });
  },

  /** 直播订阅探活：以拉取解析耗时与频道数衡量可用性 */
  liveTest: async (url: string) => {
    const start = performance.now();
    try {
      const playlist = await api.livePlaylist(url, true);
      return { ok: true, ms: Math.round(performance.now() - start), count: playlist.channels.length, error: undefined as string | undefined };
    } catch (err) {
      return { ok: false, ms: Math.round(performance.now() - start), count: 0, error: err instanceof Error ? err.message : '失败' };
    }
  },

  /** 订阅导出（.m3u）下载地址 */
  liveExportUrl: (url: string) => {
    const sp = new URLSearchParams({ url, format: 'm3u' });
    return `/api/live/playlist?${sp.toString()}`;
  },

  /** 批量测活：分片级探测频道可达性与延迟（单批最多 50 条） */
  liveProbe: (urls: string[], signal?: AbortSignal) =>
    request<{ results: LiveProbeResult[] }>(
      '/api/live/probe',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls }),
        signal,
      }
    ),

  /**
   * 流式测活：服务端以 NDJSON 逐条推送（命中缓存的立即返回），
   * 结果边测边回调，列表状态点可以边测边亮。
   */
  liveProbeStream: async (
    urls: string[],
    onResult: (result: LiveProbeResult) => void,
    signal?: AbortSignal
  ): Promise<void> => {
    const res = await fetch('/api/live/probe?stream=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls }),
      signal,
    });
    throwForAuthStatus(res);
    if (!res.ok || !res.body) throw new ApiError(`请求失败 (${res.status})`, res.status);

    await consumeNdjson<LiveProbeResult>(res, onResult);
  },
};

export interface SearchFailure {
  sourceKey: string;
  error: string;
  timedOut?: boolean;
}

/** 聚合搜索流式消费：逐源回调 + 最终聚合结果（NDJSON 行协议，同 liveProbeStream） */
async function searchStream(
  wd: string,
  sources: SourceConfig[],
  filterAdult: boolean,
  onSource: (outcome: SourceSearchOutcome) => void,
  signal?: AbortSignal
): Promise<SearchResponse> {
  const res = await fetch('/api/search?stream=1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wd, sources, filterAdult }),
    signal,
  });
    throwForAuthStatus(res);
    if (!res.ok || !res.body) throw new ApiError(`请求失败 (${res.status})`, res.status);

    // done 事件缺失（流被截断）时退化为空结果，不让整次搜索报错
    let final: SearchResponse = { list: [], failures: [] };
    const streamed: SearchResultItem[] = [];
    await consumeNdjson<SearchStreamEvent>(res, (event) => {
      if (event.type === 'source') {
        streamed.push(...event.list);
        onSource(event);
      } else if (event.type === 'done') {
        // done 不再重发全量 list：用逐源条目按服务端同一规则去重排序还原；缓存命中时才自带 list
        final = { list: event.list ?? dedupeAndSortResults(streamed, wd), failures: event.failures };
      }
    });
    return final;
  }

export type { SearchResponse, SearchResultItem };
