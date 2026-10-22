import { afterEach, describe, expect, it, vi } from 'vitest';
import { CACHE_MAX_ENTRIES, fetchUpstream, getCache, setCache } from './fetch-utils';

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
});

describe('getCache / setCache LRU', () => {
  const fill = (prefix: string, n: number, ttlMs = 60_000) => {
    for (let i = 0; i < n; i++) setCache(`${prefix}${i}`, i, ttlMs);
  };

  it('满额时只淘汰最久未用的条目，而不是整表清空', () => {
    fill('lru-a-', CACHE_MAX_ENTRIES);
    setCache('lru-a-new', 'new', 60_000);
    expect(getCache('lru-a-0')).toBeUndefined();
    expect(getCache('lru-a-1')).toBe(1);
    expect(getCache(`lru-a-${CACHE_MAX_ENTRIES - 1}`)).toBe(CACHE_MAX_ENTRIES - 1);
    expect(getCache('lru-a-new')).toBe('new');
  });

  it('读取过的条目被续命，淘汰顺延到下一个最久未用的', () => {
    fill('lru-b-', CACHE_MAX_ENTRIES);
    expect(getCache('lru-b-0')).toBe(0); // 移到最近使用
    setCache('lru-b-new', 'new', 60_000);
    expect(getCache('lru-b-0')).toBe(0);
    expect(getCache('lru-b-1')).toBeUndefined();
  });

  it('满额时优先清掉已过期条目', async () => {
    fill('lru-c-live-', CACHE_MAX_ENTRIES - 1);
    setCache('lru-c-expired', 'old', 1);
    await new Promise((r) => setTimeout(r, 5));
    setCache('lru-c-new', 'new', 60_000);
    expect(getCache('lru-c-live-0')).toBe(0);
    expect(getCache('lru-c-new')).toBe('new');
  });
});
