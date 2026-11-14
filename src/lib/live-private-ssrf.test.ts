import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { checkLiveUrlAllowed } from './ssrf';
import { fetchUpstream } from './fetch-utils';

/**
 * #980 回归：直播四个入口（epg / playlist / probe / stream 代理）都无条件传
 * `allowPrivate: true`，而这个标志此前被原样交给受保护作用域，于是 #941 那层
 * 连接时 DNS 校验在直播路径上整层失效——预检放行、连接时不再复查。
 *
 * 复现形状就是 DNS Rebinding：两份解析器给出不同答案。
 * - 预检用 `node:dns/promises`（isBlockedByDNS）→ 这里让它解析失败，
 *   按现有语义「解析失败不阻断」，预检返回 ok；
 * - 连接时用 `node:dns` 的 callback lookup（safeLookup）→ 这里让它答 127.0.0.1。
 * 两份都 mock 掉，用例不依赖外网与真实 DNS，docker 构建里跑 npm test 也稳定。
 */
const REBIND_HOST = 'rebind.invalid';
const SECRET = 'INTERNAL-SECRET-FROM-127.0.0.1';

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: unknown,
  family?: number
) => void;

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const lookup = ((_hostname: string, options: unknown, callback?: LookupCallback) => {
    const cb = (typeof options === 'function' ? options : callback) as LookupCallback;
    cb(null, [{ address: '127.0.0.1', family: 4 }]);
  }) as unknown as typeof import('node:dns').lookup;
  return { ...actual, lookup, default: { ...(actual.default as object), lookup } };
});

vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const lookup = () =>
    Promise.reject(Object.assign(new Error('getaddrinfo ENOTFOUND rebind.invalid'), { code: 'ENOTFOUND' }));
  return { ...actual, lookup, default: { ...(actual.default as object), lookup } };
});

/** 取拒绝原因：.catch 会和成功值 Response 联成联合类型，断言 message 时反而报错 */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error('预期抛错但没有');
    },
    (err: unknown) => err as Error
  );
}

describe('直播口径的连接层 SSRF 校验 (#980)', () => {
  let server: http.Server;
  let url: string;

  beforeEach(async () => {
    delete process.env.LIVE_ALLOW_PRIVATE;
    server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end(SECRET);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as AddressInfo;
    url = `http://${REBIND_HOST}:${addr.port}/live.m3u8`;
  });

  afterEach(async () => {
    delete process.env.LIVE_ALLOW_PRIVATE;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('预检本身放行该地址，所以拦截只能发生在连接层', async () => {
    await expect(checkLiveUrlAllowed(url)).resolves.toEqual({ ok: true });
  });

  it('未设 LIVE_ALLOW_PRIVATE 时，直播口径的请求必须在连接层被拦', async () => {
    const err = await rejection(
      fetchUpstream(url, { timeoutMs: 5000, retries: 0, allowPrivate: true })
    );
    expect(err.message).toBe('连接目标被拒绝: 目标地址解析到私有/保留网络 (127.0.0.1)');
  });

  it('safeRedirects:false 的另一条调用路径同样被拦', async () => {
    await expect(
      fetchUpstream(url, { timeoutMs: 5000, retries: 0, allowPrivate: true, safeRedirects: false })
    ).rejects.toThrow(/连接目标被拒绝: 目标地址解析到私有\/保留网络/);
  });

  it('LIVE_ALLOW_PRIVATE=1 时自建内网 IPTV 仍放行（不能把功能一起修没）', async () => {
    process.env.LIVE_ALLOW_PRIVATE = '1';
    const res = await fetchUpstream(url, { timeoutMs: 5000, retries: 0, allowPrivate: true });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(SECRET);
  });

  it('开关只作用于直播口径：点播路径即使开了开关也仍然严格', async () => {
    process.env.LIVE_ALLOW_PRIVATE = '1';
    await expect(fetchUpstream(url, { timeoutMs: 5000, retries: 0 })).rejects.toThrow(
      /连接目标被拒绝: 目标地址解析到私有\/保留网络/
    );
  });
});