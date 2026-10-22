import { beforeEach, describe, expect, it, vi } from 'vitest';

const lookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ default: { lookup } }));

import { clearDnsCache, isBlockedByDNS } from './ssrf';

/**
 * DNS 校验缓存：同主机短时间内只解析一次（含并发），解析失败不缓存，
 * 内网结论同样被缓存且仍然拦截。dns.lookup 一律 mock，无真实网络。
 */

beforeEach(() => {
  clearDnsCache();
  lookup.mockReset();
});

describe('isBlockedByDNS 缓存', () => {
  it('同一主机重复与并发校验只解析一次（主机名大小写不敏感）', async () => {
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const results = await Promise.all([
      isBlockedByDNS('https://cdn.example.com/a.ts'),
      isBlockedByDNS('https://cdn.example.com/b.ts'),
      isBlockedByDNS('https://CDN.example.com/c.ts'),
    ]);
    expect(await isBlockedByDNS('https://cdn.example.com/d.ts')).toBe(false);
    expect(results).toEqual([false, false, false]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('解析到内网的结论被缓存，后续请求仍被拦截', async () => {
    lookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    expect(await isBlockedByDNS('https://internal.example.com/')).toBe(true);
    expect(await isBlockedByDNS('https://internal.example.com/x')).toBe(true);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('解析失败不阻断也不缓存，下次重新解析', async () => {
    lookup.mockRejectedValueOnce(new Error('ENOTFOUND'));
    expect(await isBlockedByDNS('https://flaky.example.com/')).toBe(false);
    lookup.mockResolvedValueOnce([{ address: '192.168.1.1', family: 4 }]);
    expect(await isBlockedByDNS('https://flaky.example.com/')).toBe(true);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('缓存过期后重新解析', async () => {
    vi.useFakeTimers();
    try {
      lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
      await isBlockedByDNS('https://ttl.example.com/');
      vi.advanceTimersByTime(31_000);
      await isBlockedByDNS('https://ttl.example.com/');
      expect(lookup).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('字面量 IP 不走 DNS', async () => {
    expect(await isBlockedByDNS('http://127.0.0.1/')).toBe(true);
    expect(await isBlockedByDNS('https://93.184.216.34/')).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });
});
