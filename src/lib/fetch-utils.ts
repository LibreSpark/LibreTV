/** 服务端上游请求工具：超时、重试、安全跳转、JSON 解析 */

import { checkLiveUrlAllowed, checkUpstreamAllowed } from './ssrf';

export interface FetchOptions extends RequestInit {
  timeoutMs?: number;
  retries?: number;
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
async function fetchWithPolicy(
  url: string,
  init: Omit<RequestInit, 'redirect'> = {},
  options: SafeRedirectOptions = {},
  allowPrivate = false
): Promise<FetchResult> {
  const { headerTimeoutMs } = options;
  let current = url;
  const controller = new AbortController();
  const externalSignal = init.signal;
  const abortFromExternal = () => controller.abort(externalSignal?.reason);

  if (externalSignal?.aborted) {
    controller.abort(externalSignal.reason);
  } else {
    externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
  }

  try {
    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
      if (controller.signal.aborted) {
        throw controller.signal.reason ?? new DOMException('请求已取消', 'AbortError');
      }

      const verdict = allowPrivate
        ? await checkLiveUrlAllowed(current)
        : await checkUpstreamAllowed(current);
      if (controller.signal.aborted) {
        throw controller.signal.reason ?? new DOMException('请求已取消', 'AbortError');
      }
      if (!verdict.ok) {
        throw new Error(`跳转目标被拒绝: ${verdict.reason}`);
      }

      const timer = headerTimeoutMs
        ? setTimeout(() => controller.abort(new DOMException('上游响应头超时', 'TimeoutError')), headerTimeoutMs)
        : null;
      let res: Response;
      try {
        res = await fetch(current, {
          ...init,
          signal: controller.signal,
          redirect: 'manual',
        });
      } finally {
        if (timer) clearTimeout(timer);
      }

      if (!REDIRECT_STATUSES.has(res.status)) {
        return { res, finalUrl: current };
      }

      const location = res.headers.get('location');
      if (!location) return { res, finalUrl: current };

      try {
        await res.body?.cancel();
      } catch {
        // 重定向 body 取消失败不改变目标地址校验结果。
      }

      current = new URL(location, current).href;
    }
    throw new Error('重定向次数过多');
  } finally {
    externalSignal?.removeEventListener('abort', abortFromExternal);
  }
}

export async function fetchUpstreamWithMeta(url: string, options: FetchOptions = {}): Promise<FetchResult> {
  return fetchWithMetaPolicy(url, options, false);
}

export async function fetchLiveUpstreamWithMeta(url: string, options: FetchOptions = {}): Promise<FetchResult> {
  return fetchWithMetaPolicy(url, options, true);
}

/** 普通公网代理：调用者不能启用内网例外。 */
export async function fetchWithSafeRedirects(url: string, init: Omit<RequestInit, 'redirect'> = {}, options: SafeRedirectOptions = {}): Promise<FetchResult> {
  return fetchWithPolicy(url, init, options, false);
}

/** 直播专用代理：内网放行仍受 LIVE_ALLOW_PRIVATE=1 约束。 */
export async function fetchLiveWithSafeRedirects(url: string, init: Omit<RequestInit, 'redirect'> = {}, options: SafeRedirectOptions = {}): Promise<FetchResult> {
  return fetchWithPolicy(url, init, options, true);
}

export async function fetchUpstream(url: string, options: FetchOptions = {}): Promise<Response> {
  return (await fetchUpstreamWithMeta(url, options)).res;
}

export async function fetchLiveUpstream(url: string, options: FetchOptions = {}): Promise<Response> {
  return (await fetchLiveUpstreamWithMeta(url, options)).res;
}

/** 同 fetchUpstream，额外返回重定向后的最终 URL */
async function fetchWithMetaPolicy(url: string, options: FetchOptions, allowPrivate: boolean): Promise<FetchResult> {
  const { timeoutMs = 8000, retries = 0, ...init } = options;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;

    try {
      return await fetchWithPolicy(url, { ...init, signal }, {}, allowPrivate);
    } catch (err) {
      lastError = err;
      if (init.signal?.aborted) throw err;
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

/** 内存 TTL 缓存（豆瓣推荐等热点数据） */
const cache = new Map<string, { value: unknown; expiresAt: number }>();

export function getCache<T>(key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.value as T;
}

export function setCache(key: string, value: unknown, ttlMs: number): void {
  if (cache.size > 500) {
    // 简单防膨胀：超限时清掉最早过期的条目
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now > v.expiresAt) cache.delete(k);
    }
    if (cache.size > 500) cache.clear();
  }
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}
