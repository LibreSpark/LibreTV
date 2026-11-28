import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';
import { SESSION_COOKIE, signSession } from '@/lib/auth';

/**
 * 订阅接口单测：格式自动识别（LibreTV-SourceList / TVBOX）、统计透传，
 * 以及服务端校验拦下条目时的提示。上游拉取与 SSRF 校验一律 mock，不产生网络请求。
 */

const state = vi.hoisted(() => ({
  body: null as unknown,
  /** 上游原始响应文本（优先于 body），用于模拟非 JSON / 带注释响应 */
  rawText: null as string | null,
  /** 点播源公网校验的模拟实现，默认全部放行 */
  proxyAllowed: (() => true) as (url: string) => boolean,
  /** 直播源校验的模拟开关 */
  liveAllowed: true as boolean,
}));

vi.mock('@/lib/fetch-utils', () => ({
  fetchSourceSubscription: vi.fn(
    async () =>
      new Response(state.rawText ?? JSON.stringify(state.body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
  ),
}));

vi.mock('@/lib/ssrf', () => ({
  checkUpstreamAllowed: vi.fn(async () => ({ ok: true })),
  checkLiveUrlAllowed: vi.fn(async () => ({ ok: state.liveAllowed })),
  isValidProxyUrl: vi.fn((url: string) => state.proxyAllowed(url)),
}));

interface SubPayload {
  name?: string;
  sources?: { name?: string; url: string }[];
  liveSources?: { name?: string; url: string }[];
  stats?: Record<string, unknown>;
  error?: string;
}

async function readJson(res: Response): Promise<SubPayload> {
  return (await res.json()) as SubPayload;
}

function makeRequest(subUrl = 'https://feed.example.com/subscription.json'): Request {
  const { token } = signSession();
  const sp = new URLSearchParams({ url: subUrl });
  return new Request(`https://local.test/api/source-list?${sp.toString()}`, {
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  });
}

beforeAll(() => {
  process.env.PASSWORD = 'test-password';
  delete process.env.PROXY_SECRET;
});

beforeEach(() => {
  state.body = null;
  state.rawText = null;
  state.proxyAllowed = () => true;
  state.liveAllowed = true;
});

describe('GET /api/source-list', () => {
  it('TVBOX 配置：导入直连类条目并透传跳过统计', async () => {
    state.body = {
      sites: [
        { name: '正版源', type: 1, api: 'https://vod.example.com/api.php/provide/vod' },
        { name: '蜘蛛A', type: 3, api: 'csp_AppYs' },
        { name: '蜘蛛B', type: 3, api: 'csp_XBPQ' },
        { name: 'XML站', type: 0, api: 'https://xml.example.com/api.php/provide/vod/at/xml' },
      ],
      lives: [{ name: '直播', type: 0, url: 'https://live.example.com/list.m3u' }],
    };

    const res = await GET(makeRequest());
    const data = await readJson(res);

    expect(res.status).toBe(200);
    expect(data.sources).toEqual([{ name: '正版源', url: 'https://vod.example.com/api.php/provide/vod' }]);
    expect(data.liveSources).toHaveLength(1);
    expect(data.stats).toMatchObject({ format: 'tvbox', skipped: 3, skippedByReason: { spider: 2, xml: 1 } });
  });

  it('LibreTV 源列表：沿用原格式与默认统计', async () => {
    state.body = {
      name: '我的源列表',
      sources: [{ name: '点播', url: 'https://vod.example.com/api.php/provide/vod' }],
      liveSources: [{ name: '直播', url: 'https://live.example.com/list.m3u' }],
    };

    const res = await GET(makeRequest());
    const data = await readJson(res);

    expect(res.status).toBe(200);
    expect(data.name).toBe('我的源列表');
    expect(data.stats).toEqual({ format: 'libretv', skipped: 0, skippedByReason: {}, truncated: 0 });
  });

  it('全部为 Spider 时返回可读错误并带原因计数', async () => {
    state.body = { sites: [{ name: '蜘蛛A', type: 3, api: 'csp_AppYs' }] };

    const res = await GET(makeRequest());
    const data = await readJson(res);

    expect(res.status).toBe(400);
    expect(data.error).toMatch(/已跳过 1 个条目（Spider 引擎 1）/);
  });

  it('服务端校验拦下全部条目时提示原因而非静默成功', async () => {
    state.body = { sites: [{ name: '内网源', type: 1, api: 'https://192.168.1.2/api.php/provide/vod' }] };
    state.proxyAllowed = () => false;

    const res = await GET(makeRequest());
    const data = await readJson(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain('订阅未导入任何可用源');
    expect(data.error).toContain('地址不可用 1');
  });

  it('部分条目被拦下时仍正常导入，并在统计中说明', async () => {
    state.body = {
      sites: [
        { name: '公网源', type: 1, api: 'https://vod.example.com/api.php/provide/vod' },
        { name: '内网源', type: 1, api: 'https://192.168.1.2/api.php/provide/vod' },
      ],
    };
    state.proxyAllowed = (url) => !url.includes('192.168');

    const res = await GET(makeRequest());
    const data = await readJson(res);

    expect(res.status).toBe(200);
    expect(data.sources).toHaveLength(1);
    expect(data.stats).toMatchObject({ skipped: 1, skippedByReason: { invalidUrl: 1 } });
  });

  it('直播源地址非法时丢弃该条并计入统计', async () => {
    state.body = {
      sites: [{ name: '点播', type: 1, api: 'https://vod.example.com/api.php/provide/vod' }],
      lives: [{ name: '内网直播', type: 0, url: 'http://10.0.0.2/list.m3u' }],
    };
    state.liveAllowed = false;

    const res = await GET(makeRequest());
    const data = await readJson(res);

    expect(res.status).toBe(200);
    expect(data.liveSources).toHaveLength(0);
    expect(data.stats).toMatchObject({ skipped: 1, skippedByReason: { invalidUrl: 1 } });
  });

  it('带注释的配置照常导入（fastjson 式容错）', async () => {
    state.rawText = [
      '{',
      '  // 站点',
      '  "sites": [{ "name": "正版源", "type": 1, "api": "https://vod.example.com/api.php/provide/vod" }],',
      '  "lives": []',
      '}',
    ].join('\n');

    const res = await GET(makeRequest());
    const data = await readJson(res);

    expect(res.status).toBe(200);
    expect(data.sources).toHaveLength(1);
  });

  it('上游返回 HTML 等非 JSON 内容时给出可读错误', async () => {
    state.rawText = '<html>403 Forbidden</html>';

    const res = await GET(makeRequest());
    const data = await readJson(res);

    expect(res.status).toBe(400);
    expect(data.error).toBe('订阅内容不是合法的 JSON');
  });
});
