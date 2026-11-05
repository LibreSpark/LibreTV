import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolve4, resolve6 } = vi.hoisted(() => ({
  resolve4: vi.fn(),
  resolve6: vi.fn(),
}));

vi.mock('node:dns/promises', () => ({ resolve4, resolve6 }));

import { isBlockedByDNS } from './ssrf';

function dnsError(code: string) {
  return Object.assign(new Error(code), { code });
}

describe('isBlockedByDNS', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('允许解析到公网 IPv4、且 IPv6 无记录的域名', async () => {
    resolve4.mockResolvedValue(['8.8.8.8']);
    resolve6.mockRejectedValue(dnsError('ENODATA'));
    await expect(isBlockedByDNS('https://public.example')).resolves.toBe(false);
  });

  it('只要任一地址族返回私有地址就拒绝', async () => {
    resolve4.mockResolvedValue(['8.8.8.8']);
    resolve6.mockResolvedValue(['fd00::1234']);
    await expect(isBlockedByDNS('https://mixed.example')).resolves.toBe(true);
  });

  it('DNS 临时故障时 fail-closed', async () => {
    resolve4.mockRejectedValue(dnsError('ETIMEOUT'));
    resolve6.mockRejectedValue(dnsError('ETIMEOUT'));
    await expect(isBlockedByDNS('https://timeout.example')).resolves.toBe(true);
  });

  it('没有任何 A/AAAA 记录时拒绝', async () => {
    resolve4.mockRejectedValue(dnsError('ENODATA'));
    resolve6.mockRejectedValue(dnsError('ENODATA'));
    await expect(isBlockedByDNS('https://empty.example')).resolves.toBe(true);
  });

  it('允许解析到公网 IPv6、且 IPv4 无记录的域名', async () => {
    resolve4.mockRejectedValue(dnsError('ENODATA'));
    resolve6.mockResolvedValue(['2606:4700:4700::1111']);
    await expect(isBlockedByDNS('https://ipv6.example')).resolves.toBe(false);
  });
});
