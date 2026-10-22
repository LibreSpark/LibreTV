import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api-guard', () => ({
  // 接口鉴权在本测试范围内不关心，假装放行
  guardRequest: vi.fn(() => null),
  jsonError: vi.fn(),
}));

/**
 * 点播代理测试：mock 全局 fetch，验证
 * - 超时只限制响应头等待，body 流式透传期间不会被切断；
 * - 客户端断开会终止上游连接；
 * - 上游错误响应不写入缓存头。
 * 使用字面量公网 IP 避免 DNS 依赖。
 */

const TARGET = 'https://93.184.216.34/video/seg-1.ts';
const TIMEOUT_MS = 50;

let handleProxyRequest: typeof import('./proxy-handlers').handleProxyRequest;

beforeAll(async () => {
  // 超时与重试次数在模块加载时读取，需先设好环境变量再导入
  process.env.REQUEST_TIMEOUT = String(TIMEOUT_MS);
  process.env.MAX_RETRIES = '0';
  ({ handleProxyRequest } = await import('./proxy-handlers'));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** mock fetch：记录每次请求收到的 signal，按 handler 返回响应 */
function mockFetch(handler: (signal: AbortSignal) => Promise<Response>) {
  const signals: AbortSignal[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string | URL, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      signals.push(signal);
      return handler(signal);
    })
  );
  return signals;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function proxyRequest(signal?: AbortSignal): Request {
  return new Request(`http://localhost/api/proxy?url=${encodeURIComponent(TARGET)}`, { signal });
}

describe('handleProxyRequest 超时', () => {
  it('拿到响应头后不再限时：传输超过 REQUEST_TIMEOUT 也不中断上游', async () => {
    const signals = mockFetch(async () => new Response('segment-bytes', { status: 200 }));
    const res = await handleProxyRequest(proxyRequest(), TARGET);
    expect(res.status).toBe(200);

    await sleep(TIMEOUT_MS * 3);
    expect(signals[0].aborted).toBe(false);
    expect(await res.text()).toBe('segment-bytes');
  });

  it('上游迟迟不返回响应头时按 REQUEST_TIMEOUT 失败并返回 502', async () => {
    const signals = mockFetch(
      (signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        })
    );
    const start = Date.now();
    const res = await handleProxyRequest(proxyRequest(), TARGET);
    expect(res.status).toBe(502);
    expect(signals[0].aborted).toBe(true);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('客户端断开时终止上游连接', async () => {
    const signals = mockFetch(async () => new Response('segment-bytes', { status: 200 }));
    const client = new AbortController();
    await handleProxyRequest(proxyRequest(client.signal), TARGET);
    expect(signals[0].aborted).toBe(false);

    client.abort();
    expect(signals[0].aborted).toBe(true);
  });
});

describe('handleProxyRequest 缓存头', () => {
  it.each([403, 404, 500, 503])('上游 %i 时返回 no-store 并透传状态码', async (status) => {
    mockFetch(async () => new Response('err', { status, headers: { 'content-type': 'video/mp2t' } }));
    const res = await handleProxyRequest(proxyRequest(), TARGET);
    expect(res.status).toBe(status);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('上游图片 404 也不缓存', async () => {
    mockFetch(async () => new Response('err', { status: 404, headers: { 'content-type': 'image/jpeg' } }));
    const res = await handleProxyRequest(proxyRequest(), TARGET);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('分片 200 / 206 保持 1 小时缓存', async () => {
    for (const status of [200, 206]) {
      mockFetch(async () => new Response('ok', { status, headers: { 'content-type': 'video/mp2t' } }));
      const res = await handleProxyRequest(proxyRequest(), TARGET);
      expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    }
  });

  it('图片 200 保持 30 天缓存', async () => {
    mockFetch(async () => new Response('ok', { status: 200, headers: { 'content-type': 'image/jpeg' } }));
    const res = await handleProxyRequest(proxyRequest(), TARGET);
    expect(res.headers.get('cache-control')).toBe('public, max-age=2592000');
  });
});
