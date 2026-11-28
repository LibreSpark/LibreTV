import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LookupAddress } from 'node:dns';
import dns from 'node:dns/promises';
import { fetchSourceSubscription, fetchUpstream } from './fetch-utils';

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

describe('Cloudflare Workers GitHub Raw 订阅', () => {
  const raw = 'https://raw.githubusercontent.com/owner/repo/main/sources.json';

  function useWorker() {
    vi.stubGlobal('navigator', { userAgent: 'Cloudflare-Workers' });
    const lookup = vi.spyOn(dns as { lookup: (host: string, options: { all: true }) => Promise<LookupAddress[]> }, 'lookup');
    return lookup.mockResolvedValue([{ address: '185.199.108.133', family: 4 }]);
  }

  it('使用手动跳转的原生请求拉取 GitHub Raw JSON', async () => {
    useWorker();
    const fetchMock = mockFetch([() => new Response('{"sources":[]}')]);
    const res = await fetchSourceSubscription(raw);
    expect(await res.json()).toEqual({ sources: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(raw, expect.objectContaining({
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal: expect.any(AbortSignal),
    }));
  });

  it('只跟随相对或同源跳转，并共享同一个超时信号', async () => {
    useWorker();
    const fetchMock = mockFetch([
      () => new Response(null, { status: 302, headers: { location: './current.json' } }),
      () => new Response('{"sources":[]}'),
    ]);
    await expect(fetchSourceSubscription(raw)).resolves.toMatchObject({ status: 200 });
    const [[, first], [next, second]] = fetchMock.mock.calls as [string, RequestInit][];
    expect(next).toBe('https://raw.githubusercontent.com/owner/repo/main/current.json');
    expect(second.signal).toBe(first.signal);
  });

  it.each([
    'http://raw.githubusercontent.com/owner/repo/main/sources.json',
    'https://raw.githubusercontent.com:8443/owner/repo/main/sources.json',
    'https://raw.githubusercontent.com.example.com/sources.json',
    'https://user@raw.githubusercontent.com/owner/repo/main/sources.json',
  ])('拦截跨源、降级或带凭据的跳转 (%s)', async (target) => {
    useWorker();
    const fetchMock = mockFetch([
      () => new Response(null, { status: 302, headers: { location: target } }),
    ]);
    await expect(fetchSourceSubscription(raw)).rejects.toThrow('只能跳转到原 HTTPS 源站');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('保留公网校验及重定向次数限制', async () => {
    useWorker().mockResolvedValueOnce([{ address: '192.168.1.2', family: 4 }]);
    const fetchMock = mockFetch(Array.from({ length: 6 }, () => () =>
      new Response(null, { status: 302, headers: { location: './sources.json' } })
    ));
    await expect(fetchSourceSubscription(raw)).rejects.toThrow('目标地址解析到私有/保留网络');
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(fetchSourceSubscription(raw)).rejects.toThrow('重定向次数过多');
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it.each([
    ['Node.js', raw],
    ['Cloudflare-Workers', 'https://feed.example.com/sources.json'],
  ])('%s 的非适用请求仍走原来的连接层防护', async (userAgent, url) => {
    useWorker();
    vi.stubGlobal('navigator', { userAgent });
    const error = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ERR_SSRF_BLOCKED', message: '原连接层拒绝' },
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error));
    await expect(fetchSourceSubscription(url)).rejects.toThrow('连接目标被拒绝: 原连接层拒绝');
  });
});
