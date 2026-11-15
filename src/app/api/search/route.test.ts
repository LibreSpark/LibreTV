import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { POST } from './route';
import { NextRequest } from 'next/server';
import { SESSION_COOKIE, signSession } from '@/lib/auth';
import type { SearchResponse, SearchStreamEvent, SourceConfig } from '@/lib/types';

// 测试域名使用保留的 .test/.example 后缀；模拟公网 DNS 答案，
// 让这些测试只验证路由与上游逻辑，不依赖 CI runner 的真实 DNS。
vi.mock('node:dns/promises', () => ({
  resolve4: async () => ['93.184.216.34'],
  resolve6: async () => {
    throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
  },
}));

/**
 * 聚合搜索接口单测：跨源聚合、同源去重、精确命中置顶、成人内容过滤、
 * 失败源不影响整体、SSRF 字面量拒绝。上游一律 mock fetch，无真实网络。
 */

function cmsList(items: Array<Record<string, unknown>>, pagecount = 1): string {
  return JSON.stringify({ code: 1, pagecount, list: items });
}

/** 按 URL 分发的上游 mock：cms-a 正常、cms-b 500、cms-c 与 a 有重叠条目 */
function mockUpstream(): void {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('cms-a.example')) {
      return new Response(
        cmsList([
          { vod_id: 1, vod_name: '测试剧', type_name: '国产剧' },
          { vod_id: 2, vod_name: '测试剧外传', type_name: '国产剧' },
          { vod_id: 3, vod_name: '福利速递', type_name: '福利视频' },
          // 同源同 vod_id 的重复条目：聚合时须按 sourceKey_vodId 去重
          { vod_id: 1, vod_name: '测试剧', type_name: '国产剧' },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url.includes('cms-b.example')) {
      return new Response('server error', { status: 500 });
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fn);
}

function makeRequest(body: unknown, stream = false): NextRequest {
  const { token } = signSession();
  return new NextRequest(`https://local.test/api/search${stream ? '?stream=1' : ''}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      cookie: `${SESSION_COOKIE}=${token}`,
    },
    body: JSON.stringify(body),
  });
}

const SOURCES = [
  { key: 'a', name: '源A', url: 'https://cms-a.example.com/api.php' },
  { key: 'b', name: '源B', url: 'https://cms-b.example.com/api.php' },
];

beforeAll(() => {
  process.env.PASSWORD = 'test-password-123';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/search', () => {
  it('聚合多源结果：同源去重、成人内容过滤、失败源进 failures', async () => {
    mockUpstream();
    const res = await POST(makeRequest({ wd: '测试剧', sources: SOURCES, filterAdult: true }));
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      list: Array<{ sourceKey: string; vodId: string; name: string }>;
      failures: Array<{ sourceKey: string; error: string }>;
    };

    // 源A 的 4 条 → 去重后 2 条有效 + 成人条目被过滤
    const aItems = data.list.filter((i) => i.sourceKey === 'a');
    expect(aItems).toHaveLength(2);
    expect(aItems.map((i) => i.vodId).sort()).toEqual(['1', '2']);

    // 源B 500 → 记入 failures，不影响源A 的结果
    expect(data.failures).toHaveLength(1);
    expect(data.failures[0].sourceKey).toBe('b');
    expect(data.failures[0].error).toContain('500');
  });

  it('uses browser-local Collector credentials only on an authenticated search request', async () => {
    const { token } = signSession();
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(url.startsWith('https://collector.example.com/')).toBe(true);
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer browser-collector-token');
      if (url.includes('/v1/registry/search')) return Response.json({ resources: [] });
      if (url.includes('/v1/seedhub/search')) return Response.json({ items: [] });
      return Response.json({});
    });
    vi.stubGlobal('fetch', fetchSpy);
    const request = new NextRequest('https://local.test/api/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: `${SESSION_COOKIE}=${token}`,
        'x-scrapling-api-base': 'https://collector.example.com',
        'x-scrapling-api-token': 'browser-collector-token',
      },
      body: JSON.stringify({ wd: '测试影片', sources: [] }),
    });
    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('returns imported SeedHub catalogue metadata as separate non-playable search results', async () => {
    const previousBase = process.env.SCRAPLING_API_BASE;
    const previousToken = process.env.SCRAPLING_API_TOKEN;
    process.env.SCRAPLING_API_BASE = 'https://collector.example.com';
    process.env.SCRAPLING_API_TOKEN = 'collector-test-token';
    const seedhubItem = {
      source_url: 'https://www.seedhub.cc/movies/130096/',
      title: '生化危机：爆发夜',
      category: 'movies' as const,
      poster_url: 'https://www.seedhub.cc/poster.jpg',
      discovered_at: 123,
      detail: { mode: 'metadata-only' },
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/registry/search')) {
        return Response.json({ resources: [] });
      }
      if (url.includes('/v1/seedhub/search')) {
        return Response.json({ source: 'SeedHub', items: [seedhubItem] });
      }
      return Response.json({ list: [], pagecount: 0 });
    }));
    try {
      const response = await POST(makeRequest({ wd: '生化危机', sources: [] }));
      expect(response.status).toBe(200);
      const data = await response.json() as SearchResponse;
      expect(data.seedhubItems).toEqual([seedhubItem]);
      expect(data.registryResources).toBeUndefined();
      expect(data.list).toEqual([]);
    } finally {
      if (previousBase === undefined) delete process.env.SCRAPLING_API_BASE;
      else process.env.SCRAPLING_API_BASE = previousBase;
      if (previousToken === undefined) delete process.env.SCRAPLING_API_TOKEN;
      else process.env.SCRAPLING_API_TOKEN = previousToken;
    }
  });

  it('searches KKPhim REST API and maps its slug, artwork, type and quality fields', async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('https://phimapi.com/v1/api/tim-kiem?');
      expect(String(input)).toContain('keyword=' + encodeURIComponent('流浪地球'));
      return new Response(JSON.stringify({
        status: 'success',
        data: {
          items: [{
            slug: 'wandering-earth',
            name: '流浪地球',
            origin_name: 'The Wandering Earth',
            poster_url: 'https://images.example.com/wandering-earth.jpg',
            thumb_url: 'https://images.example.com/wandering-earth-thumb.jpg',
            type: 'single',
            year: 2019,
            quality: 'FHD',
            lang: 'Vietsub',
            episode_current: 'Full',
            country: [{ name: '中国' }],
          }],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const response = await POST(makeRequest({
      wd: '流浪地球',
      sources: [{ key: 'kkphim', name: 'KKPhim', url: 'https://phimapi.com' }],
    }));
    expect(response.status).toBe(200);
    const data = await response.json() as SearchResponse;
    expect(data.list).toHaveLength(1);
    expect(data.list[0]).toMatchObject({
      sourceKey: 'kkphim',
      vodId: 'wandering-earth',
      name: '流浪地球',
      typeName: '电影',
      year: '2019',
      area: '中国',
      remarks: 'FHD · Vietsub · Full',
      pic: '/api/img?url=' + encodeURIComponent('https://images.example.com/wandering-earth.jpg'),
    });
    expect(data.failures).toEqual([]);
  });

  it('精确命中（忽略标点差异）排在最前', async () => {
    mockUpstream();
    const res = await POST(makeRequest({ wd: '测试剧', sources: [SOURCES[0]], filterAdult: true }));
    const data = (await res.json()) as { list: Array<{ name: string }> };
    expect(data.list[0]?.name).toBe('测试剧');
  });

  it('内网字面量地址在发起请求前被 SSRF 校验拒绝', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await POST(
      makeRequest({
        wd: 'x',
        sources: [{ key: 'evil', name: '内网', url: 'http://192.168.1.100/api.php' }],
        filterAdult: false,
      })
    );
    const data = (await res.json()) as { failures: Array<{ sourceKey: string; error: string }> };
    expect(data.failures[0]?.sourceKey).toBe('evil');
    // 上游一次请求都不应发生
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('stream=1 以 NDJSON 逐源推送并以 done 事件收尾', async () => {
    mockUpstream();
    // 用不同源地址避开同键短缓存，保留有实际匹配结果的关键词。
    const sourcesForStream = SOURCES.map((source) => ({ ...source, url: source.url + '/stream' }));
    const res = await POST(makeRequest({ wd: '测试剧', sources: sourcesForStream, filterAdult: true }, true));
    expect(res.status).toBe(200);
    const text = await res.text();
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { type: string; sourceKey?: string });
    const sources = lines.filter((l) => l.type === 'source');
    const done = lines.filter((l) => l.type === 'done');
    // 每个源恰好一条 source 事件（含失败的源B），最后一条是 done
    expect(sources.map((l) => l.sourceKey).sort()).toEqual(['a', 'b']);
    expect(done).toHaveLength(1);
    expect(lines[lines.length - 1].type).toBe('done');
  });

  it.each([true, false])('逐源、最终与缓存结果使用相同过滤规则（成人过滤：%s）', async (filterAdult) => {
    const sources: SourceConfig[] = [
      { key: 'good', name: '有效源', url: `https://cms.example.com/consistent-${filterAdult}` },
      { key: 'bad', name: '失败源', url: `https://cms.example.com/failed-${filterAdult}` },
    ];
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/failed-')) return new Response('unavailable', { status: 500 });
      return new Response(cmsList([
        { vod_id: 1, vod_name: '赛博朋克：边缘行者第二季', type_name: '动漫' },
        { vod_id: 1, vod_name: '赛博朋克：边缘行者第二季', type_name: '动漫' },
        { vod_id: 2, vod_name: '10月17日德甲联赛', type_name: '足球' },
        { vod_id: 3, vod_name: '', type_name: '动漫' },
        { vod_id: 4, vod_name: '赛博朋克：边缘行者第二季', type_name: '福利视频' },
      ]), { headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchSpy);
    const body = { wd: '赛博朋克：边缘行者 2', sources, filterAdult };
    const stream = await POST(makeRequest(body, true));
    const events = (await stream.text()).trim().split('\n').map((line) => JSON.parse(line) as SearchStreamEvent);
    const good = events.find((event) => event.type === 'source' && event.sourceKey === 'good');
    const failed = events.find((event) => event.type === 'source' && event.sourceKey === 'bad');
    const done = events.find((event) => event.type === 'done');
    const ids = filterAdult ? ['1'] : ['1', '4'];
    expect(good?.list.map((item) => item.vodId)).toEqual(ids);
    expect(good).toMatchObject({ type: 'source', sourceKey: 'good', ok: true, ms: expect.any(Number) });
    expect(failed).toMatchObject({ type: 'source', sourceKey: 'bad', ok: false, list: [], error: 'HTTP 500' });
    expect(done).toMatchObject({ type: 'done', list: good?.list, failures: [{ sourceKey: 'bad', error: 'HTTP 500' }] });

    // 同一缓存同时服务 JSON 和流式客户端，不能重新引入原始杂项。
    const calls = fetchSpy.mock.calls.length;
    const json = await POST(makeRequest(body));
    const cached = await json.json() as SearchResponse;
    expect(cached.list).toEqual(good?.list);
    expect(cached.failures).toEqual(done?.type === 'done' ? done.failures : undefined);
    const cachedStream = await POST(makeRequest(body, true));
    expect((await cachedStream.text()).trim().split('\n').map((line) => JSON.parse(line))).toEqual([done]);
    expect(fetchSpy).toHaveBeenCalledTimes(calls);

    // 新地址走非缓存 JSON 分支，仍须得到相同的筛选结果。
    const fresh = await POST(makeRequest({ ...body, sources: sources.map((source) => ({ ...source, url: source.url + '/fresh' })) }));
    const freshData = await fresh.json() as SearchResponse;
    expect(freshData.list.map((item) => item.vodId)).toEqual(ids);
    expect(freshData.failures).toEqual(cached.failures);
  });

  it('没有相关结果时，各响应模式均保留空列表', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(cmsList([
      { vod_id: 1, vod_name: '10月17日德甲联赛', type_name: '足球' },
      { vod_id: 2, vod_name: '', type_name: '动漫' },
    ]))));
    const body = {
      wd: '赛博朋克：边缘行者 2',
      sources: [{ key: 'empty', name: '不相关源', url: 'https://cms.example.com/no-relevant-results' }],
    };
    const res = await POST(makeRequest(body, true));
    const events = (await res.text()).trim().split('\n').map((line) => JSON.parse(line) as SearchStreamEvent);
    expect(events).toHaveLength(2);
    for (const event of events) expect(event.list).toEqual([]);
    expect(events[0]).toMatchObject({ type: 'source', ok: true });
    expect(events[1]).toMatchObject({ type: 'done', failures: [] });
    const cached = await POST(makeRequest(body));
    expect(await cached.json()).toEqual({ list: [], failures: [] });
    const cachedStream = await POST(makeRequest(body, true));
    expect(JSON.parse((await cachedStream.text()).trim())).toEqual({ type: 'done', list: [], failures: [] });
    const fresh = await POST(makeRequest({ ...body, sources: [{ ...body.sources[0], url: body.sources[0].url + '/fresh' }] }));
    expect(await fresh.json()).toEqual({ list: [], failures: [] });
  });

  it('未登录返回 401，未配置密码返回 503', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const saved = process.env.PASSWORD;
    delete process.env.PASSWORD;
    try {
      const noPassword = await POST(makeRequest({ wd: 'x', sources: SOURCES }));
      expect(noPassword.status).toBe(503);
    } finally {
      process.env.PASSWORD = saved;
    }
    const noCookie = new NextRequest('https://local.test/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wd: 'x', sources: SOURCES }),
    });
    const unauthorized = await POST(noCookie);
    expect(unauthorized.status).toBe(401);
  });
});
