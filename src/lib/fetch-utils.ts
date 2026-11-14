/** 服务端上游请求工具：超时、重试、安全跳转、JSON 解析 */

import { allowLivePrivate, checkLiveUrlAllowed, checkUpstreamAllowed, runWithSSRFProtection } from './ssrf';

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
   *
   * 本标志只选择「逐跳校验用哪把尺子」；连接层是否放行内网另由 allowLivePrivate()
   * 决定（#980）。两者不是同一个开关，别再把本标志原样传给受保护作用域。
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
   *
   * 本标志只选择「逐跳校验用哪把尺子」；连接层是否放行内网另由 allowLivePrivate()
   * 决定（#980）。两者不是同一个开关，别再把本标志原样传给受保护作用域。
   */
  allowPrivate?: boolean;
  /**
   * 仅对「响应头等待」限时（直播流专用）：对整个 body 限时会切断
   * HTTP-FLV 单一无限长连接，故拿到响应头后立即清除计时器，body 不再受限。
   * 超时触发即整链失败（内部 controller 已 abort，对齐直播路由原行为）。
   */
  headerTimeoutMs?: number;
}

/** 需要原样透传的中断/超时语义：调用方靠 name 判定「超时」，不能被包装成普通错误 */
function isAbortOrTimeout(value: unknown): boolean {
  if (!(value instanceof Error)) return false;
  const code = (value as { code?: string }).code;
  return value.name === 'TimeoutError' || value.name === 'AbortError'
    || code === 'ABORT_ERR' || code === 'UND_ERR_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT'
    || code === 'UND_ERR_BODY_TIMEOUT';
}

/**
 * 归一化上游请求异常：
 * 1. 连接层 SSRF 拦截 → 换成用户可读的拒绝原因；
 * 2. 其余 `TypeError: fetch failed` → undici 把真实原因挂在 err.cause 上
 *    （ENOTFOUND / EAI_AGAIN / ECONNREFUSED / 证书错误 / 跨版本 dispatcher 被拒…），
 *    只把「fetch failed」抛给用户等于没有诊断信息（issue #969 的排查就卡在这里），
 *    所以把 cause 的 code + message 提上来，同时保留 cause 链不丢原始对象；
 * 3. 超时/主动中断原样抛出，别让调用方的 TimeoutError 判定落空。
 */
function normalizeSSRFError(err: unknown): never {
  const cause = (err as { cause?: unknown } | undefined)?.cause;
  if (
    cause &&
    typeof cause === 'object' &&
    'code' in cause &&
    (cause as { code?: string }).code === 'ERR_SSRF_BLOCKED'
  ) {
    const message = (cause as { message?: string }).message;
    throw new Error(`连接目标被拒绝: ${message || '目标地址被拒绝'}`);
  }

  if (cause instanceof Error && !isAbortOrTimeout(cause) && !isAbortOrTimeout(err)) {
    const code = (cause as { code?: string }).code;
    const detail = [code, cause.message].filter(Boolean).join(' ');
    if (detail) {
      const wrapped = new Error(`上游请求失败: ${detail}`, { cause: err });
      // 原始 cause 上的 code 同时挂到顶层，方便按码分类统计与调用方判断
      if (code) (wrapped as Error & { code?: string }).code = code;
      throw wrapped;
    }
  }

  throw err;
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
  // 两个角色必须分开（#980）：allowPrivate 只决定「逐跳用哪把尺子」（下方
  // checkLiveUrlAllowed / checkUpstreamAllowed）；连接层是否放行内网要另看部署
  // 开关 LIVE_ALLOW_PRIVATE。此前把 allowPrivate 原样传进受保护作用域，而直播
  // 四个入口都无条件传 true，等于把 #941 那层连接时 DNS 校验在直播路径上整层
  // 关掉——预检放行、连接时不再复查，rebinding 域名即可读回内网响应体。
  // 取交集而非直接用开关：点播路径（allowPrivate=false）不受该开关影响，仍与
  // 修复前一样严格，开关只作用于本来就声明走直播口径的调用方。
  const connectAllowPrivate = allowPrivate && allowLivePrivate();
  return runWithSSRFProtection({ allowPrivate: connectAllowPrivate }, async () => {
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
      } catch (err: unknown) {
        normalizeSSRFError(err);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (!REDIRECT_STATUSES.has(res.status)) return { res, finalUrl: current };
      const location = res.headers.get('location');
      if (!location) return { res, finalUrl: current };
      current = new URL(location, current).href;
    }
    throw new Error('重定向次数过多');
  });
}

export async function fetchUpstream(url: string, options: FetchOptions = {}): Promise<Response> {
  return (await fetchUpstreamWithMeta(url, options)).res;
}

/** 同 fetchUpstream，额外返回重定向后的最终 URL */
export async function fetchUpstreamWithMeta(url: string, options: FetchOptions = {}): Promise<FetchResult> {
  const { timeoutMs = 8000, retries = 0, safeRedirects = true, allowPrivate = false, ...init } = options;
  // 与 fetchWithSafeRedirects 同一口径（#980）：连接层放行内网＝直播口径 + 部署开关
  const connectAllowPrivate = allowPrivate && allowLivePrivate();
  // 外部 signal（调用方的总死线中断）与单次超时合并：任一触发即中断请求
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (!safeRedirects) {
        try {
          const res = await runWithSSRFProtection({ allowPrivate: connectAllowPrivate }, () =>
            fetch(url, {
              ...init,
              signal,
              redirect: init.redirect ?? 'follow',
            })
          );
          return { res, finalUrl: res.url || url };
        } catch (err: unknown) {
          normalizeSSRFError(err);
        }
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
