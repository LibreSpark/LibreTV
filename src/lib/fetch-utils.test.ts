import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LookupAddress } from 'node:dns';
import dns from 'node:dns/promises';
import { fetchSourceSubscription, fetchUpstream, fetchUpstreamWithMeta, fetchWithSafeRedirects } from './fetch-utils';
import * as ssrf from './ssrf';

/**
 * 安全跳转测试：mock 全局 fetch，验证 302 跳转到内网地址会被拒绝，
 * 跳转到公网地址则正常跟随。使用字面量公网 IP 避免 DNS 依赖。
 */

const PUBLIC_URL = 'https://93.184.216.34/a';

function mockFetch(handlers: Array<(url: string) => Response>) {
  const fn = vi.fn((url: string | URL) => {
    const handler = handlers.shift();
    if (!handler) throw new Error('意外的额外请求: ' + url);
    return Promise.resolve(handler(String(url)));
  });
  vi.stubGlobal('fetch', fn);
  return fn as unknown as ReturnType<typeof vi.fn> & { mock: { calls: unknown[][] } };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** 取拒绝原因：直接用 .catch 会和成功值 Response 联成一个联合类型，断言 name/code 时反而报错 */
async function rejection(promise: Promise<unknown>): Promise<Error & { code?: string }> {
  return promise.then(
    () => {
      throw new Error('预期抛错但没有');
    },
    (err: unknown) => err as Error & { code?: string }
  );
}

describe('fetchUpstream 安全跳转', () => {
  it('302 跳转到内网地址时拒绝，且不发起第二跳请求', async () => {
    const spy = mockFetch([
      () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8080/secret' } }),
    ]);
    await expect(fetchUpstream(PUBLIC_URL)).rejects.toThrow(/跳转目标被拒绝/);
    expect(spy.mock.calls.length).toBe(1); // 预检在请求前拦截，内网地址未实际请求
  });

  it('302 跳转到公网地址时正常跟随并返回最终响应', async () => {
    mockFetch([
      () => new Response(null, { status: 302, headers: { location: 'https://93.184.216.34/b' } }),
      () => new Response('ok', { status: 200 }),
    ]);
    const res = await fetchUpstream(PUBLIC_URL);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('无跳转时直接返回响应', async () => {
    const spy = mockFetch([() => new Response('direct', { status: 200 })]);
    const res = await fetchUpstream(PUBLIC_URL);
    expect(await res.text()).toBe('direct');
    expect(spy.mock.calls.length).toBe(1);
  });

  it('重定向超过上限时抛错', async () => {
    mockFetch(Array.from({ length: 10 }, () => (url: string) =>
      new Response(null, { status: 302, headers: { location: url } })
    ));
    await expect(fetchUpstream(PUBLIC_URL)).rejects.toThrow(/重定向次数过多/);
  });

  it('底层连接解析到私网 IP 时转换抛出友好错误 (连接目标被拒绝)', async () => {
    const err = Object.assign(new Error('fetch failed'), {
      cause: { code: 'ERR_SSRF_BLOCKED', message: '目标地址解析到私有/保留网络 (127.0.0.1)' },
    });
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(err)));
    await expect(fetchUpstream(PUBLIC_URL)).rejects.toThrow(/连接目标被拒绝: 目标地址解析到私有\/保留网络/);
  });

  it('safeRedirects 为 false 时，底层连接解析到私网 IP 也会转换抛出友好错误', async () => {
    const err = Object.assign(new Error('fetch failed'), {
      cause: { code: 'ERR_SSRF_BLOCKED', message: '目标地址解析到私有/保留网络 (127.0.0.1)' },
    });
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(err)));
    await expect(fetchUpstream(PUBLIC_URL, { safeRedirects: false })).rejects.toThrow(
      /连接目标被拒绝: 目标地址解析到私有\/保留网络/
    );
  });

  it('底层是网络错误时，把 cause 的 code 一起透出，不再只剩「fetch failed」', async () => {
    // issue #969 那类反馈的共同形状：只看到 fetch failed，真实原因（域名解析失败 /
    // 证书不受信 / 连接被拒）藏在 err.cause 里，用户和我们都无从判断。
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.example.com'), { code: 'ENOTFOUND' }),
    });
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(err)));
    await expect(fetchUpstream(PUBLIC_URL)).rejects.toThrow(/上游请求失败: ENOTFOUND getaddrinfo ENOTFOUND/);
  });

  it('cause 上的 code 也挂到抛出对象顶层，便于按码分类', async () => {
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('unable to verify the first certificate'), {
        code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      }),
    });
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(err)));
    const thrown = await rejection(fetchUpstream(PUBLIC_URL));
    expect(thrown.code).toBe('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    expect(thrown.message).toContain('unable to verify the first certificate');
  });

  it('超时/主动中断保持原对象抛出，不破坏调用方的 TimeoutError 判定', async () => {
    const abort = new DOMException('This operation was aborted', 'AbortError');
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(abort)));
    const thrown = await rejection(fetchUpstream(PUBLIC_URL));
    expect(thrown).toBe(abort);
    expect(thrown.name).toBe('AbortError');

    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(timeout)));
    const thrown2 = await rejection(fetchUpstream(PUBLIC_URL));
    expect(thrown2).toBe(timeout);
    expect(thrown2.name).toBe('TimeoutError');
  });

  it('cause 本身就是超时/中断时也不包装', async () => {
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('Request timed out'), { code: 'UND_ERR_HEADERS_TIMEOUT', name: 'HeadersTimeoutError' }),
    });
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(err)));
    const thrown = await rejection(fetchUpstream(PUBLIC_URL));
    expect(thrown).toBe(err);
  });
});

describe('Cloudflare Workers 统一公网出网', () => {
  const feed = 'https://feed.example.com/sources.json';

  function useWorker(publicFlag = true) {
    vi.stubGlobal('navigator', { userAgent: 'Cloudflare-Workers' });
    vi.stubGlobal('Cloudflare', { compatibilityFlags: { global_fetch_strictly_public: publicFlag } });
    vi.stubEnv('LIBRETV_WORKERS_PUBLIC_EGRESS', '1');
    const lookup = vi.spyOn(dns as { lookup: (host: string, options: { all: true }) => Promise<LookupAddress[]> }, 'lookup');
    return lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  }

  it('在非托管公网配置或未开启兼容标志时拒绝出网，不回退到 undici', async () => {
    const lookup = useWorker(false);
    const fetchMock = mockFetch([]);
    const protection = vi.spyOn(ssrf, 'runWithSSRFProtection');
    await expect(fetchUpstream(feed)).rejects.toThrow('出网未配置');
    useWorker();
    vi.stubEnv('LIBRETV_WORKERS_PUBLIC_EGRESS', undefined);
    await expect(fetchUpstream(feed)).rejects.toThrow('出网未配置');
    expect(lookup).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(protection).not.toHaveBeenCalled();
  });

  it('任意公网源都使用原生 fetch，而不进入 undici 作用域', async () => {
    useWorker();
    const protection = vi.spyOn(ssrf, 'runWithSSRFProtection');
    const fetchMock = mockFetch([() => new Response('{"sources":[]}')]);
    const res = await fetchSourceSubscription(feed);
    expect(await res.json()).toEqual({ sources: [] });
    expect(fetchMock).toHaveBeenCalledWith(feed, expect.objectContaining({ redirect: 'manual' }));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get('accept')).toBe('application/json');
    expect(protection).not.toHaveBeenCalled();
  });

  it('相对与跨源跳转均复查 DNS、不转发跨源凭据，并保留最终 URL 和流', async () => {
    const lookup = useWorker();
    const cancel = vi.fn();
    const redirect = new Response(new ReadableStream({ cancel }), { status: 302, headers: { location: './current' } });
    const final = new Response('stream');
    const fetchMock = mockFetch([
      () => redirect,
      () => new Response(null, { status: 307, headers: { location: 'https://cdn.example.com/path/file' } }),
      () => final,
    ]);
    const result = await fetchUpstreamWithMeta(feed, { headers: { Authorization: 'test', Cookie: 'private', Host: 'not-the-url.example', Range: 'bytes=0-' } });
    const [[, first], [relative, second], [cross, third]] = fetchMock.mock.calls as [string, RequestInit][];
    expect(relative).toBe('https://feed.example.com/current');
    expect(cross).toBe('https://cdn.example.com/path/file');
    expect(lookup.mock.calls.map(([host]) => host)).toEqual(['feed.example.com', 'feed.example.com', 'cdn.example.com']);
    expect(third.signal).toBe(first.signal);
    expect(second.headers).toBe(first.headers);
    expect(new Headers(first.headers).has('host')).toBe(false);
    expect(new Headers(second.headers).has('authorization')).toBe(true);
    expect(new Headers(third.headers).has('authorization')).toBe(false);
    expect(new Headers(third.headers).has('cookie')).toBe(false);
    expect(new Headers(third.headers).get('range')).toBe('bytes=0-');
    expect(cancel).toHaveBeenCalledOnce();
    expect(result.finalUrl).toBe(cross);
    expect(result.res).toBe(final);
    expect(result.res.bodyUsed).toBe(false);
    expect(await result.res.text()).toBe('stream');
  });

  it.each(['http://127.0.0.1/secret', 'https://user@feed.example.com/secret', 'ftp://feed.example.com/file'])
    ('即使请求自动跟随或允许内网直播也拒绝不安全重定向 (%s)', async (target) => {
      useWorker();
      vi.stubEnv('LIVE_ALLOW_PRIVATE', '1');
      const fetchMock = mockFetch([() => new Response(null, { status: 302, headers: { location: target } })]);
      await expect(fetchUpstream(feed, { allowPrivate: true, safeRedirects: false, redirect: 'follow' })).rejects.toThrow('跳转目标被拒绝');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(feed, expect.objectContaining({ redirect: 'manual' }));
    });

  it('目标域名解析到私网时拒绝，不发出请求', async () => {
    useWorker().mockResolvedValueOnce([{ address: '192.168.1.2', family: 4 }]);
    const fetchMock = mockFetch([]);
    await expect(fetchUpstream(feed)).rejects.toThrow('目标地址解析到私有/保留网络');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('外部中断在 DNS 查询期间生效', async () => {
    const controller = new AbortController();
    const abort = new DOMException('cancelled', 'AbortError');
    useWorker().mockImplementationOnce(async () => {
      controller.abort(abort);
      return [{ address: '93.184.216.34', family: 4 }];
    });
    const fetchMock = mockFetch([]);
    await expect(fetchUpstream(feed, { signal: controller.signal })).rejects.toBe(abort);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('超时或中断会传给原生传输，不进入自动重试的下一跳', async () => {
    useWorker();
    const ctrl = new AbortController();
    const reason = new DOMException('deadline', 'TimeoutError');
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      ctrl.abort(reason);
    }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchUpstream(feed, { signal: ctrl.signal, retries: 2 })).rejects.toBe(reason);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('仅等待响应头的超时不会切断最终的流', async () => {
    useWorker();
    vi.useFakeTimers();
    try {
      const fetchMock = mockFetch([() => new Response('live body')]);
      const { res } = await fetchWithSafeRedirects(feed, {}, { headerTimeoutMs: 10 });
      vi.advanceTimersByTime(20);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.signal?.aborted).toBe(false);
      expect(await res.text()).toBe('live body');
    } finally {
      vi.useRealTimers();
    }
  });
});
