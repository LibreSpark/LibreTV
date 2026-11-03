import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { POST } from './route';
import { SESSION_COOKIE, signSession } from '@/lib/auth';

// 测试域名使用保留的 .test/.example 后缀；模拟公网 DNS 答案，
// 让这些测试只验证路由与上游逻辑，不依赖 CI runner 的真实 DNS。
vi.mock('node:dns/promises', () => ({
  resolve4: async () => ['93.184.216.34'],
  resolve6: async () => {
    throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
  },
}));

/**
 * 测活接口单测：流式 NDJSON、codec 解析、内容校验、结果缓存、内网放行。
 * 上游一律用 mock fetch，不产生真实网络请求。
 */

const MASTER = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS="hvc1.1.6.L93.B0,mp4a.40.2"',
  'media.m3u8',
  '',
].join('\n');

const MEDIA = ['#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXTINF:6.0,', 'seg1.ts', ''].join('\n');

const HTML = '<!doctype html><html><body>error</body></html>';

function jsonRes(body: string, contentType: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

/** 按 URL 分发的上游 mock：master / media / segment 正常，fake 站返回 HTML */
function mockUpstream(): { fn: ReturnType<typeof vi.fn> } {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/master.m3u8')) return jsonRes(MASTER, 'application/vnd.apple.mpegurl');
    if (url.includes('/media.m3u8')) return jsonRes(MEDIA, 'application/vnd.apple.mpegurl');
    if (url.includes('/seg1.ts')) {
      return new Response('binary', { status: 206, headers: { 'content-type': 'video/mp2t' } });
    }
    if (url.includes('/fake-page.m3u8')) return jsonRes(HTML, 'text/html; charset=utf-8');
    if (url.includes('/fake-stream.flv')) return jsonRes(HTML, 'text/html; charset=utf-8');
    return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  });
  vi.stubGlobal('fetch', fn);
  return { fn };
}

function makeRequest(urls: string[], stream: boolean): Request {
  const { token } = signSession();
  return new Request(`https://local.test/api/live/probe${stream ? '?stream=1' : ''}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      cookie: `${SESSION_COOKIE}=${token}`,
    },
    body: JSON.stringify({ urls }),
  });
}

async function readNdjson(res: Response) {
  const text = await res.text();
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeAll(() => {
  process.env.PASSWORD = 'test-password';
  delete process.env.PROXY_SECRET;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/live/probe', () => {
  it('stream=1 以 NDJSON 逐条返回，并解析 master 的 CODECS', async () => {
    mockUpstream();
    const res = await POST(makeRequest(['https://iptv.test/master.m3u8'], true));
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');

    const lines = await readNdjson(res);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      url: 'https://iptv.test/master.m3u8',
      ok: true,
      level: 'segment',
      codec: 'hvc1.1.6.L93.B0,mp4a.40.2',
    });
  });

  it('非流式请求保持原有 JSON 结构（向后兼容）', async () => {
    mockUpstream();
    const res = await POST(makeRequest(['https://iptv.test/master.m3u8?json=1'], false));
    const data = (await res.json()) as { results: Record<string, unknown>[] };
    expect(data.results).toHaveLength(1);
    expect(data.results[0]).toMatchObject({ ok: true, level: 'segment' });
  });

  it('返回 HTML 的伪 m3u8 判为不可用', async () => {
    mockUpstream();
    const res = await POST(makeRequest(['https://fake.test/fake-page.m3u8'], true));
    const [line] = await readNdjson(res);
    expect(line.ok).toBe(false);
    expect(String(line.error)).toContain('不是有效的 m3u8');
  });

  it('返回 HTML 的伪直链判为不可用（content-type 校验）', async () => {
    mockUpstream();
    const res = await POST(makeRequest(['https://fake.test/fake-stream.flv'], true));
    const [line] = await readNdjson(res);
    expect(line.ok).toBe(false);
    expect(String(line.error)).toContain('不是流媒体');
  });

  it('成功结果命中服务端缓存，重复测活不再请求上游', async () => {
    const { fn } = mockUpstream();
    const url = 'https://iptv.test/master.m3u8?cache-check=1';
    // 必须读完流（读到 controller.close）才能确保首轮探测已完成
    const first = await POST(makeRequest([url], true));
    const [firstLine] = await readNdjson(first);
    expect(firstLine.ok).toBe(true);
    const callsAfterFirst = fn.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const res = await POST(makeRequest([url], true));
    const [line] = await readNdjson(res);
    expect(line.ok).toBe(true);
    expect(fn.mock.calls.length).toBe(callsAfterFirst);
  });

  it('重定向到错误占位资源（令牌失效）时判为不可用', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/channel/expired')) {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://static.err.test/status/error_account_pirated.mp4' },
          });
        }
        return new Response('mp4-bytes', {
          status: 200,
          headers: { 'content-type': 'video/mp4' },
        });
      })
    );
    const res = await POST(makeRequest(['https://tv.test/channel/expired?token=x'], true));
    const [line] = await readNdjson(res);
    expect(line.ok).toBe(false);
    expect(String(line.error)).toContain('错误占位');
  });

  it('重定向到仍在 /status/ 下的正常 m3u8 时不误判为错误占位', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/entry')) {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://cdn.ok.test/status/live.m3u8' },
          });
        }
        if (url.includes('/status/live.m3u8')) {
          return jsonRes(MEDIA, 'application/vnd.apple.mpegurl');
        }
        return new Response('x', { status: 206, headers: { 'content-type': 'video/mp2t' } });
      })
    );
    const res = await POST(makeRequest(['https://cdn.ok.test/entry?token=x'], true));
    const [line] = await readNdjson(res);
    expect(line.ok).toBe(true);
    expect(line.level).toBe('segment');
  });

  it('直链 MP4 只标记为 head（可达但未验证可播性）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('mp4-bytes', {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      }))
    );
    const res = await POST(makeRequest(['https://direct.test/live/stream?id=1'], true));
    const [line] = await readNdjson(res);
    expect(line.ok).toBe(true);
    expect(line.level).toBe('head');
  });

  it('探测窗口内最新分片（滑动窗口下最不易过期）', async () => {
    const MEDIA3 = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:5',
      '#EXTINF:5.0,',
      'old_seg.ts',
      '#EXTINF:5.0,',
      'mid_seg.ts',
      '#EXTINF:5.0,',
      'newest_seg.ts',
      '',
    ].join('\n');
    const requested: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requested.push(url);
        if (url.includes('newest.test')) {
          return jsonRes(MEDIA3, 'application/vnd.apple.mpegurl');
        }
        return new Response('x', {
          status: 206,
          headers: { 'content-type': 'video/mp2t' },
        });
      })
    );

    const res = await POST(makeRequest(['https://newest.test/live/index.m3u8'], true));
    const [line] = await readNdjson(res);
    expect(line.ok).toBe(true);
    expect(line.level).toBe('segment');
    expect(requested.some((u) => u.includes('newest_seg.ts'))).toBe(true);
    expect(requested.some((u) => u.includes('old_seg.ts'))).toBe(false);
  });

  it('manifest 请求不携带 Range，分片请求才携带（避免被源截断成 2 字节误判）', async () => {
    const seen: { url: string; range?: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const headers = (init?.headers ?? {}) as Record<string, string>;
        seen.push({ url, range: headers.Range });
        if (url.includes('/live/master.m3u8') || url.includes('/live/media.m3u8')) {
          // 模拟严格按 Range 截断的源：一旦带 Range 就只回 2 字节
          if (headers.Range) {
            return new Response('#E', {
              status: 206,
              headers: { 'content-type': 'application/vnd.apple.mpegurl' },
            });
          }
          return jsonRes(
            url.includes('master.m3u8') ? MASTER : MEDIA,
            'application/vnd.apple.mpegurl'
          );
        }
        return new Response('x', {
          status: headers.Range ? 206 : 200,
          headers: { 'content-type': 'video/mp2t' },
        });
      })
    );

    const res = await POST(makeRequest(['https://range.test/live/master.m3u8'], true));
    const [line] = await readNdjson(res);
    expect(line.ok).toBe(true);
    expect(line.level).toBe('segment');

    const manifestCalls = seen.filter((s) => s.url.includes('/live/') && !s.url.includes('seg1.ts'));
    expect(manifestCalls.length).toBeGreaterThan(0);
    expect(manifestCalls.every((c) => !c.range)).toBe(true);

    const segmentCalls = seen.filter((s) => s.url.includes('seg1.ts'));
    expect(segmentCalls.length).toBeGreaterThan(0);
    // 可达性检查 bytes=0-1（收到响应头即 cancel）+ 吞吐采样 bytes=0-131071
    expect(segmentCalls.some((c) => c.range === 'bytes=0-1')).toBe(true);
    expect(segmentCalls.every((c) => c.range === 'bytes=0-1' || c.range === 'bytes=0-131071')).toBe(true);
  });

  it('未开启 LIVE_ALLOW_PRIVATE 时拒绝内网地址', async () => {
    mockUpstream();
    delete process.env.LIVE_ALLOW_PRIVATE;
    const res = await POST(makeRequest(['http://127.0.0.1:8080/live.m3u8'], true));
    const [line] = await readNdjson(res);
    expect(line.ok).toBe(false);
    expect(String(line.error)).toContain('允许范围');
  });

  it('开启 LIVE_ALLOW_PRIVATE 后自建内网源可正常探测（与直播代理口径一致）', async () => {
    process.env.LIVE_ALLOW_PRIVATE = '1';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonRes(MASTER, 'application/vnd.apple.mpegurl'))
    );
    try {
      const res = await POST(makeRequest(['http://192.168.1.10:8080/iptv/master.m3u8'], true));
      const [line] = await readNdjson(res);
      expect(line.ok).toBe(true);
    } finally {
      delete process.env.LIVE_ALLOW_PRIVATE;
    }
  });
});
