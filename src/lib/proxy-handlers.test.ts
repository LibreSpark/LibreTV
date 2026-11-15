import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchLiveWithSafeRedirects: vi.fn(),
  fetchWithSafeRedirects: vi.fn(),
  checkLiveUrlAllowed: vi.fn(),
  isBlockedByDNS: vi.fn(),
  isValidProxyUrl: vi.fn(),
  guardRequest: vi.fn(),
  rewriteM3u8: vi.fn((text: string) => text),
}));

vi.mock('@/lib/api-guard', () => ({
  guardRequest: mocks.guardRequest,
  jsonError: (message: string, status: number) => Response.json({ error: message }, { status }),
}));
vi.mock('@/lib/ssrf', () => ({
  checkLiveUrlAllowed: mocks.checkLiveUrlAllowed,
  isBlockedByDNS: mocks.isBlockedByDNS,
  isValidProxyUrl: mocks.isValidProxyUrl,
}));
vi.mock('@/lib/fetch-utils', () => ({
  fetchLiveWithSafeRedirects: mocks.fetchLiveWithSafeRedirects,
  fetchWithSafeRedirects: mocks.fetchWithSafeRedirects,
}));
vi.mock('@/lib/m3u8', () => ({
  rewriteM3u8: mocks.rewriteM3u8,
  LIVE_STREAM_BASE: '/api/live/stream?url=',
}));

import { handleLiveStreamRequest, handleProxyRequest } from './proxy-handlers';

const TARGET = 'https://media.example.test/live/index.m3u8';

function request() {
  return new Request('https://libretv.example/api/live/stream?url=x');
}

describe('handleProxyRequest source-specific headers', () => {
  beforeEach(() => {
    mocks.guardRequest.mockReturnValue(null);
    mocks.isValidProxyUrl.mockReturnValue(true);
    mocks.isBlockedByDNS.mockResolvedValue(false);
  });

  afterEach(() => vi.clearAllMocks());

  it('adds the official KKPhim Referer to allowlisted KKPhim CDN hosts', async () => {
    const target = 'https://s6.kkphimplayer6.com/path/index.m3u8';
    mocks.fetchWithSafeRedirects.mockResolvedValue({
      res: new Response('#EXTM3U\\n#EXT-X-ENDLIST', {
        status: 200,
        headers: { 'content-type': 'application/vnd.apple.mpegurl' },
      }),
      finalUrl: target,
    });

    const response = await handleProxyRequest(request(), target);
    expect(response.status).toBe(200);
    expect(mocks.fetchWithSafeRedirects).toHaveBeenCalledWith(
      target,
      expect.objectContaining({
        headers: expect.objectContaining({
          Referer: 'https://phimapi.com/',
          'User-Agent': expect.stringContaining('Chrome/131.0.0.0'),
        }),
      }),
    );
  });

  it('does not add KKPhim Referer to unrelated media hosts', async () => {
    const target = 'https://unrelated.example.test/path/index.m3u8';
    mocks.fetchWithSafeRedirects.mockResolvedValue({
      res: new Response('#EXTM3U\\n#EXT-X-ENDLIST', {
        status: 200,
        headers: { 'content-type': 'application/vnd.apple.mpegurl' },
      }),
      finalUrl: target,
    });

    await handleProxyRequest(request(), target);
    expect(mocks.fetchWithSafeRedirects).toHaveBeenCalledWith(
      target,
      expect.objectContaining({
        headers: expect.not.objectContaining({ Referer: 'https://phimapi.com/' }),
      }),
    );
  });
});

describe('handleLiveStreamRequest HLS route regression', () => {
  beforeEach(() => {
    mocks.guardRequest.mockReturnValue(null);
    mocks.checkLiveUrlAllowed.mockResolvedValue({ ok: true });
    mocks.rewriteM3u8.mockImplementation((text: string) => text);
  });

  afterEach(() => vi.clearAllMocks());

  it('上游分片或 AES Key 返回 404 时保留 HTTP 状态，不伪装成成功响应', async () => {
    mocks.fetchLiveWithSafeRedirects.mockResolvedValue({
      res: new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } }),
      finalUrl: 'https://media.example.test/keys/live.key',
    });

    const response = await handleLiveStreamRequest(request(), 'https://media.example.test/keys/live.key');
    expect(response.status).toBe(404);
    expect(response.headers.get('x-live-upstream-status')).toBe('404');
    expect(await response.json()).toEqual({ error: '直播流上游返回 404' });
  });

  it('16 字节 AES-128 Key 原样透传', async () => {
    const key = Uint8Array.from({ length: 16 }, (_, index) => index);
    mocks.fetchLiveWithSafeRedirects.mockResolvedValue({
      res: new Response(key, { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
      finalUrl: 'https://media.example.test/keys/live.key',
    });

    const response = await handleLiveStreamRequest(request(), 'https://media.example.test/keys/live.key');
    expect(response.status).toBe(200);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...key]);
  });

  it('错误长度的 AES Key 字节不被代理篡改或伪补齐，交由 hls.js 解密层拒绝', async () => {
    const malformedKey = new Uint8Array(15).fill(7);
    mocks.fetchLiveWithSafeRedirects.mockResolvedValue({
      res: new Response(malformedKey, { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
      finalUrl: 'https://media.example.test/keys/bad.key',
    });

    const response = await handleLiveStreamRequest(request(), 'https://media.example.test/keys/bad.key');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(response.status).toBe(200);
    expect(bytes.byteLength).toBe(15);
    expect([...bytes]).toEqual([...malformedKey]);
  });

  it('密钥或分片上游超时时返回 502，不返回空成功响应', async () => {
    mocks.fetchLiveWithSafeRedirects.mockRejectedValue(new DOMException('upstream timeout', 'TimeoutError'));

    const response = await handleLiveStreamRequest(request(), 'https://media.example.test/keys/slow.key');
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('upstream timeout') });
  });

  it('每次请求直播清单都重新读取并重写最新滑动窗口，不复用旧清单', async () => {
    const first = '#EXTM3U\\n#EXT-X-MEDIA-SEQUENCE:100\\nseg-100.ts';
    const second = '#EXTM3U\\n#EXT-X-MEDIA-SEQUENCE:101\\nseg-101.ts';
    mocks.fetchLiveWithSafeRedirects
      .mockResolvedValueOnce({ res: new Response(first, { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } }), finalUrl: TARGET })
      .mockResolvedValueOnce({ res: new Response(second, { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } }), finalUrl: TARGET });

    const firstResponse = await handleLiveStreamRequest(request(), TARGET);
    const secondResponse = await handleLiveStreamRequest(request(), TARGET);
    expect(await firstResponse.text()).toContain('MEDIA-SEQUENCE:100');
    expect(await secondResponse.text()).toContain('MEDIA-SEQUENCE:101');
    expect(mocks.fetchLiveWithSafeRedirects).toHaveBeenCalledTimes(2);
    expect(mocks.rewriteM3u8).toHaveBeenCalledTimes(2);
  });
});
