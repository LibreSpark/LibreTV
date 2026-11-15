import { describe, expect, it } from 'vitest';
import { checkLiveUrlAllowed, isPrivateIP, isValidProxyUrl } from './ssrf';

describe('isPrivateIP', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['192.168.1.1', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false],
    ['169.254.169.254', true],
    ['100.64.0.1', true],
    ['100.127.255.255', true],
    ['100.128.0.1', false],
    ['0.1.2.3', true],
    ['192.0.2.10', true],
    ['192.31.196.1', true],
    ['192.52.193.1', true],
    ['192.175.48.1', true],
    ['198.18.0.1', true],
    ['198.19.255.254', true],
    ['198.51.100.2', true],
    ['203.0.113.8', true],
    ['224.0.0.1', true],
    ['240.0.0.1', true],
    ['::1', true],
    ['fe80::1', true],
    ['fd00::1', true],
    ['8.8.8.8', false],
    ['1.2.3.4', false],
    // URL.hostname 对 IPv6 会带方括号
    ['[::1]', true],
    ['[fe80::1]', true],
    ['[fd00::1]', true],
    ['[fe90::1]', true],
    ['[ff02::1]', true],
    ['[2001:db8::1]', true],
    ['[2001:20::1]', true], // 2001::/23 特殊用途
    ['[2002:c000:0201::1]', true], // 6to4
    ['[3fff::1]', true], // 文档示例
    ['[fc00::1]', true],
    // IPv4-mapped IPv6：十六进制形式与点分形式
    ['[::ffff:c0a8:164]', true], // ::ffff:192.168.1.100
    ['::ffff:192.168.1.100', true],
    ['[::ffff:7f00:1]', true], // ::ffff:127.0.0.1
    ['::ffff:127.0.0.1', true],
    ['[::ffff:a9fe:a9fe]', true], // ::ffff:169.254.169.254
    ['[::ffff:a00:1]', true], // ::ffff:10.0.0.1
    ['[::ffff:808:808]', false], // ::ffff:8.8.8.8 公网
    ['::ffff:8.8.8.8', false],
    ['[::ffff:c0a8:164', true], // 单边括号（异常输入）仍要拦
    ['[2606:4700::1111]', false],
    ['[3001:4860::1]', false], // 公网 IPv6 不应被误杀
  ])('%s → %s', (ip, expected) => {
    expect(isPrivateIP(ip)).toBe(expected);
  });
});

describe('isValidProxyUrl', () => {
  it('放行公网 http(s)', () => {
    expect(isValidProxyUrl('https://cdn.example.com/a.m3u8')).toBe(true);
    expect(isValidProxyUrl('http://1.2.3.4/x.ts')).toBe(true);
  });

  it('拦截内网与保留地址', () => {
    expect(isValidProxyUrl('http://localhost/x')).toBe(false);
    expect(isValidProxyUrl('http://127.0.0.1/x')).toBe(false);
    expect(isValidProxyUrl('http://192.168.1.1/x')).toBe(false);
    expect(isValidProxyUrl('http://169.254.169.254/latest/meta-data')).toBe(false);
  });

  it('拦截带方括号的 IPv6 与 IPv4-mapped 写法', () => {
    expect(isValidProxyUrl('http://[::1]:8080/x')).toBe(false);
    expect(isValidProxyUrl('http://[::ffff:192.168.1.100]:8080/list.m3u')).toBe(false);
    expect(isValidProxyUrl('http://[::ffff:127.0.0.1]/x')).toBe(false);
    expect(isValidProxyUrl('http://[fe80::1]/x')).toBe(false);
    expect(isValidProxyUrl('http://[fd00::1]/x')).toBe(false);
  });

  it('不误杀公网 IPv6', () => {
    expect(isValidProxyUrl('http://[2606:4700::1111]/x')).toBe(true);
  });

  it('拒绝 URL 内嵌用户名或密码', () => {
    expect(isValidProxyUrl('https://user:pass@cdn.example.com/video.m3u8')).toBe(false);
    expect(isValidProxyUrl('https://user@cdn.example.com/video.m3u8')).toBe(false);
  });

  it('拦截非 http 协议', () => {
    expect(isValidProxyUrl('file:///etc/passwd')).toBe(false);
    expect(isValidProxyUrl('ftp://x.com/a')).toBe(false);
    expect(isValidProxyUrl('not a url')).toBe(false);
  });
});


describe('checkLiveUrlAllowed', () => {
  it('即使启用内网 IPTV，也拒绝嵌入用户名或密码的 URL', async () => {
    const previous = process.env.LIVE_ALLOW_PRIVATE;
    process.env.LIVE_ALLOW_PRIVATE = '1';
    try {
      await expect(checkLiveUrlAllowed('http://user:pass@192.168.1.10:8080/live.m3u8')).resolves.toMatchObject({ ok: false });
      await expect(checkLiveUrlAllowed('http://user@router.local/live.m3u8')).resolves.toMatchObject({ ok: false });
      await expect(checkLiveUrlAllowed('http://192.168.1.10:8080/live.m3u8')).resolves.toEqual({ ok: true });
    } finally {
      if (previous === undefined) delete process.env.LIVE_ALLOW_PRIVATE;
      else process.env.LIVE_ALLOW_PRIVATE = previous;
    }
  });
});
