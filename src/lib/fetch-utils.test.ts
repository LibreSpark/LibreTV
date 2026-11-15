import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchUpstream, fetchWithSafeRedirects } from './fetch-utils';

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
});

describe('fetchUpstream 安全跳转', () => {
  it('普通安全重定向 API 不接受 allowPrivate 特权参数', async () => {
    const spy = mockFetch([]);
    await expect(
      fetchWithSafeRedirects('http://127.0.0.1:8080/private', {}, { allowPrivate: true } as never)
    ).rejects.toThrow(/跳转目标被拒绝/);
    expect(spy.mock.calls.length).toBe(0);
  });

  it('普通上游 API 忽略调用者注入的 allowPrivate 参数', async () => {
    const spy = mockFetch([]);
    await expect(
      fetchUpstream('http://127.0.0.1:8080/private', { allowPrivate: true } as never)
    ).rejects.toThrow(/跳转目标被拒绝/);
    expect(spy.mock.calls.length).toBe(0);
  });

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

  it('客户端中断请求时，将 abort 传递到正在进行的上游请求', async () => {
    const controller = new AbortController();
    let upstreamSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url: string | URL, init?: RequestInit) => {
      upstreamSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        upstreamSignal?.addEventListener('abort', () => reject(upstreamSignal?.reason), { once: true });
      });
    }));

    const pending = fetchWithSafeRedirects(PUBLIC_URL, { signal: controller.signal });
    await vi.waitFor(() => expect(upstreamSignal).toBeDefined());
    controller.abort(new DOMException('客户端已断开', 'AbortError'));

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
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
});
