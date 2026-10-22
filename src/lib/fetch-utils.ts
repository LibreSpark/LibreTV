/** 服务端上游请求工具：超时、重试、安全跳转、JSON 解析 */

import { checkLiveUrlAllowed, checkUpstreamAllowed } from './ssrf';

export interface FetchOptions extends RequestInit {
  timeoutMs?: number;
  retries?: number;
  /**
   * 安全跳转（默认开启）：禁用 fetch 的自动跟随，改为手动逐跳跟随，
   * 每一跳重新执行 SSRF 校验——否则公网 URL 可 302 跳转到内网地址绕过预检。
   */
  safeRedirects?: boolean;
  /**
   * 直播场景放行内网地址（自建 IPTV）：仅在部署者设置 LIVE_ALLOW_PRIVATE=1 时生效。
   * 校验复用 checkLiveUrlAllowed，与直播流代理使用同一把尺子。
   */
  allowPrivate?: boolean;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECT_HOPS = 5;

export interface FetchResult {
  res: Response;
  /** 跟随重定向后的最终 URL（manual 模式下 res.url 不可靠，须自行跟踪）。
   *  解析 manifest 内的相对地址必须用它，否则分片路径会指向错误目录。 */
  finalUrl: string;
}

export interface SafeRedirectOptions {
  /**
   * 直播场景放行内网地址（自建 IPTV）：仅在部署者设置 LIVE_ALLOW_PRIVATE=1 时生效。
   * 校验复用 checkLiveUrlAllowed，与直播流代理使用同一把尺子。
   */
  allowPrivate?: boolean;
  /**
   * 仅对「响应头等待」限时（直播流专用）：对整个 body 限时会切断
   * HTTP-FLV 单一无限长连接，故拿到响应头后立即清除计时器，body 不再受限。
   * 超时触发即整链失败（内部 controller 已 abort，对齐直播路由原行为）。
   */
  headerTimeoutMs?: number;
}

/**
 * 手动逐跳跟随重定向，每一跳重新执行 SSRF 校验。
 * 不能用 redirect:'follow'——预检之后 fetch 自动跟随的 3xx 可把请求
 * 带进内网/元数据地址，绕过对首跳的校验。
 */
export async function fetchWithSafeRedirects(
  url: string,
  init: Omit<RequestInit, 'redirect'> = {},
  options: SafeRedirectOptions = {}
): Promise<FetchResult> {
  const { allowPrivate = false, headerTimeoutMs } = options;
  let current = url;
  // headerTimeout 超时即 abort 内部 controller；外部 signal（调用方死线/客户端断开）链入同一 controller
  const controller = new AbortController();
  if (init.signal) {
    if (init.signal.aborted) controller.abort(init.signal.reason);
    else init.signal.addEventListener('abort', () => controller.abort(init.signal?.reason), { once: true });
  }
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    const verdict = allowPrivate
      ? await checkLiveUrlAllowed(current)
      : await checkUpstreamAllowed(current);
    if (!verdict.ok) {
      throw new Error(`跳转目标被拒绝: ${verdict.reason}`);
    }
    const timer = headerTimeoutMs ? setTimeout(() => controller.abort(), headerTimeoutMs) : null;
    let res: Response;
    try {
      res = await fetch(current, { ...init, signal: controller.signal, redirect: 'manual' });
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!REDIRECT_STATUSES.has(res.status)) return { res, finalUrl: current };
    const location = res.headers.get('location');
    if (!location) return { res, finalUrl: current };
    current = new URL(location, current).href;
  }
  throw new Error('重定向次数过多');
}

export async function fetchUpstream(url: string, options: FetchOptions = {}): Promise<Response> {
  return (await fetchUpstreamWithMeta(url, options)).res;
}

/** 同 fetchUpstream，额外返回重定向后的最终 URL */
export async function fetchUpstreamWithMeta(url: string, options: FetchOptions = {}): Promise<FetchResult> {
  const { timeoutMs = 8000, retries = 0, safeRedirects = true, allowPrivate = false, ...init } = options;
  // 外部 signal（调用方的总死线中断）与单次超时合并：任一触发即中断请求
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (!safeRedirects) {
        const res = await fetch(url, {
          ...init,
          signal,
          redirect: init.redirect ?? 'follow',
        });
        return { res, finalUrl: res.url || url };
      }
      // 手动逐跳跟随，每一跳重新过 SSRF 校验
      return await fetchWithSafeRedirects(url, { ...init, signal }, { allowPrivate });
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('上游请求失败');
}

export async function fetchUpstreamJson<T = unknown>(url: string, options: FetchOptions = {}): Promise<T> {
  const res = await fetchUpstream(url, options);
  if (!res.ok) throw new Error(`上游请求失败: ${res.status}`);
  const data = (await res.json()) as T;
  return data;
}

/**
 * 内存 TTL + LRU 缓存（豆瓣推荐、搜索结果等热点数据）。
 * Map 保持插入顺序：命中时移到末尾，满额时先清过期条目，仍不够再从头部淘汰最久未用的，
 * 而不是整表清空（旧做法会让豆瓣 / 榜单等热点缓存随一次搜索高峰全部失效）。
 */
export const CACHE_MAX_ENTRIES = 500;
const cache = new Map<string, { value: unknown; expiresAt: number }>();

export function getCache<T>(key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry.value as T;
}

export function setCache(key: string, value: unknown, ttlMs: number): void {
  cache.delete(key);
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now > v.expiresAt) cache.delete(k);
    }
    for (const k of cache.keys()) {
      if (cache.size < CACHE_MAX_ENTRIES) break;
      cache.delete(k);
    }
  }
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}
