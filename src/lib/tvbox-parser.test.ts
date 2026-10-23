import { describe, expect, it } from 'vitest';
import { MAX_LIVE_SOURCES, MAX_VOD_SOURCES } from './source-list';
import {
  describeParseStats,
  isTvboxPayload,
  parseSubscriptionJson,
  parseSubscriptionPayload,
  parseTvboxPayload,
  withSkipped,
} from './tvbox-parser';

const vodSite = (url: string, extra: Record<string, unknown> = {}) => ({
  name: `站点 ${url}`,
  type: 1,
  api: url,
  ...extra,
});

describe('isTvboxPayload', () => {
  it('顶层含 sites / lives 数组即判定为 TVBOX 配置', () => {
    expect(isTvboxPayload({ sites: [], lives: [] })).toBe(true);
    expect(isTvboxPayload({ sites: [{ key: 'a' }] })).toBe(true);
    expect(isTvboxPayload({ lives: [] })).toBe(true);
  });

  it('LibreTV 订阅与非法输入不误判', () => {
    expect(isTvboxPayload({ sources: [], liveSources: [] })).toBe(false);
    expect(isTvboxPayload([{ url: 'https://a.example.com/vod' }])).toBe(false);
    expect(isTvboxPayload(null)).toBe(false);
    expect(isTvboxPayload('text')).toBe(false);
  });
});

describe('parseTvboxPayload', () => {
  it('导入 type=1 点播源与 type=0 直播源（含 EPG）', () => {
    const result = parseTvboxPayload({
      sites: [vodSite('https://vod.example.com/api.php/provide/vod')],
      lives: [
        { name: '直播A', type: 0, url: 'https://live.example.com/list.m3u' },
        {
          name: '直播B',
          type: 0,
          url: 'https://live.example.com/tv.m3u8',
          epg: 'https://live.example.com/epg.xml.gz',
        },
      ],
    });

    expect(result.sources).toEqual([
      { name: '站点 https://vod.example.com/api.php/provide/vod', url: 'https://vod.example.com/api.php/provide/vod' },
    ]);
    expect(result.liveSources).toEqual([
      { name: '直播A', url: 'https://live.example.com/list.m3u', epg: undefined },
      { name: '直播B', url: 'https://live.example.com/tv.m3u8', epg: 'https://live.example.com/epg.xml.gz' },
    ]);
    expect(result.stats).toMatchObject({ format: 'tvbox', skipped: 0, truncated: 0 });
  });

  it('类型缺失或写成 XML，但地址命中 Apple CMS 特征时宽容导入', () => {
    const result = parseTvboxPayload({
      sites: [
        { name: '省略类型', api: 'https://a.example.com/api.php/provide/vod' },
        { name: 'XML 类型', type: 0, api: 'https://b.example.com/api.php/provide/vod/' },
      ],
    });

    expect(result.sources.map((s) => s.url)).toEqual([
      'https://a.example.com/api.php/provide/vod',
      // 点播地址沿用「去尾部斜杠」的既有归一化规则
      'https://b.example.com/api.php/provide/vod',
    ]);
    expect(result.stats?.skipped).toBe(0);
  });

  it('Spider、本地资源、XML 与非 CMS 外链站点跳过并分类计数', () => {
    const result = parseTvboxPayload({
      sites: [
        { name: '正版源', type: 1, api: 'https://ok.example.com/api.php/provide/vod' },
        { name: '蜘蛛A', type: 3, api: 'csp_AppYs' },
        { name: '蜘蛛B', api: 'https://cdn.example.com/spider.jar' },
        { name: '本地JS', type: 1, api: './json/heimuer.js' },
        { name: 'XML站', type: 0, api: 'https://xml.example.com/api.php/provide/vod/at/xml' },
        { name: '外链站', type: 4, api: 'https://api.example.com/v1/list' },
      ],
    });

    expect(result.sources.map((s) => s.name)).toEqual(['正版源']);
    expect(result.stats?.skipped).toBe(5);
    expect(result.stats?.skippedByReason).toEqual({ spider: 4, xml: 1 });
    expect(result.stats?.skippedSamples).toEqual(['蜘蛛A', '蜘蛛B', '本地JS']);
  });

  it('声明不可搜索的站点跳过', () => {
    const result = parseTvboxPayload({
      sites: [
        vodSite('https://a.example.com/api.php/provide/vod'),
        vodSite('https://b.example.com/api.php/provide/vod', { searchable: 0 }),
      ],
    });

    expect(result.sources).toHaveLength(1);
    expect(result.stats?.skippedByReason).toEqual({ unsearchable: 1 });
  });

  it('直播：单仓 JSON 与 txt 频道列表跳过，非 M3U 地址计入 invalidUrl', () => {
    const result = parseTvboxPayload({
      sites: [vodSite('https://a.example.com/api.php/provide/vod')],
      lives: [
        { name: '直播A', type: 0, url: 'https://live.example.com/list.m3u' },
        { name: '单仓', type: 1, url: 'https://live.example.com/all.json' },
        { name: 'txt列表', type: 0, url: 'https://live.example.com/tv.txt' },
        { name: '坏地址', type: 0, url: 'ftp://live.example.com/list.m3u' },
      ],
    });

    expect(result.liveSources.map((s) => s.name)).toEqual(['直播A']);
    expect(result.stats?.skipped).toBe(3);
    expect(result.stats?.skippedByReason).toEqual({ nonM3uLive: 2, invalidUrl: 1 });
  });

  it('按地址去重（点播去尾部斜杠后比较，直播保留原样）', () => {
    const result = parseTvboxPayload({
      sites: [
        vodSite('https://a.example.com/api.php/provide/vod'),
        vodSite('https://a.example.com/api.php/provide/vod/'),
      ],
      lives: [
        { name: 'A', type: 0, url: 'https://live.example.com/list.m3u' },
        { name: 'A 重复', type: 0, url: 'https://live.example.com/list.m3u' },
      ],
    });

    expect(result.sources).toHaveLength(1);
    expect(result.liveSources).toHaveLength(1);
    // 重复条目静默跳过，不计入跳过统计
    expect(result.stats?.skipped).toBe(0);
  });

  it('超出上限时截断并计入 truncated（去重后计数）', () => {
    const sites = [
      ...Array.from({ length: 10 }, () => vodSite('https://dup.example.com/api.php/provide/vod')),
      ...Array.from({ length: MAX_VOD_SOURCES + 5 }, (_, i) => vodSite(`https://vod${i}.example.com/api.php/provide/vod`)),
    ];
    const lives = Array.from({ length: MAX_LIVE_SOURCES + 3 }, (_, i) => ({
      name: `直播${i}`,
      type: 0,
      url: `https://live${i}.example.com/list.m3u`,
    }));

    const result = parseTvboxPayload({ sites, lives });

    expect(result.sources).toHaveLength(MAX_VOD_SOURCES);
    expect(result.liveSources).toHaveLength(MAX_LIVE_SOURCES);
    // 前段重复只占 1 个名额：1 + 99 达到上限，余下 6 个点播与 3 个直播被截断
    expect(result.stats?.truncated).toBe(9);
  });

  it('全部不可导入时抛错并带原因计数', () => {
    expect(() =>
      parseTvboxPayload({ sites: [{ name: '蜘蛛A', type: 3, api: 'csp_AppYs' }] })
    ).toThrow(/已跳过 1 个条目（Spider 引擎 1）/);
  });

  it('sites / lives 均为空时提示无可用站点', () => {
    expect(() => parseTvboxPayload({ sites: [], lives: [] })).toThrow(/没有可用的站点/);
    expect(() => parseTvboxPayload({})).toThrow(/没有可用的站点/);
  });

  it('TVBOX 顶层 name 作为订阅名透传', () => {
    const result = parseTvboxPayload({
      name: '某大佬的接口',
      sites: [vodSite('https://a.example.com/api.php/provide/vod')],
    });
    expect(result.name).toBe('某大佬的接口');
  });
});

describe('parseSubscriptionPayload', () => {
  it('TVBOX 配置走 TVBOX 分支', () => {
    const result = parseSubscriptionPayload({
      sites: [{ name: '正版源', type: 1, api: 'https://a.example.com/api.php/provide/vod' }],
      lives: [{ name: '直播', type: 0, url: 'https://live.example.com/list.m3u' }],
    });

    expect(result.stats?.format).toBe('tvbox');
    expect(result.sources).toHaveLength(1);
    expect(result.liveSources).toHaveLength(1);
  });

  it('LibreTV 订阅仍按原逻辑解析并带默认统计', () => {
    const result = parseSubscriptionPayload({
      name: '我的源列表',
      sources: [{ name: '点播', url: 'https://a.example.com/api.php/provide/vod' }],
      liveSources: [{ name: '直播', url: 'https://live.example.com/list.m3u' }],
    });

    expect(result.name).toBe('我的源列表');
    expect(result.sources).toHaveLength(1);
    expect(result.liveSources).toHaveLength(1);
    expect(result.stats).toEqual({ format: 'libretv', skipped: 0, skippedByReason: {}, truncated: 0 });
  });

  it('裸数组老格式仍按 LibreTV 解析', () => {
    const result = parseSubscriptionPayload([{ url: 'https://a.example.com/api.php/provide/vod' }]);
    expect(result.sources).toHaveLength(1);
    expect(result.stats?.format).toBe('libretv');
  });

  it('兼容 name/baseUrl 接口源目录，忽略禁用项并去重', () => {
    const result = parseSubscriptionPayload([
      { id: 'a', name: '接口A', baseUrl: 'https://a.example.com/api.php/provide/vod', enabled: true },
      { id: 'off', name: '禁用源', baseUrl: 'https://off.example.com/api.php/provide/vod', enabled: false },
      { id: 'dup', name: '重复源', baseUrl: 'https://a.example.com/api.php/provide/vod/' },
    ]);

    expect(result.name).toBe('影视接口源列表');
    expect(result.sources).toEqual([
      { name: '接口A', url: 'https://a.example.com/api.php/provide/vod' },
    ]);
    expect(result.liveSources).toEqual([]);
    expect(result.stats?.format).toBe('source-catalog');
  });

  it('接口源目录遵守点播源上限并统计截断数', () => {
    const result = parseSubscriptionPayload(
      Array.from({ length: MAX_VOD_SOURCES + 2 }, (_, i) => ({
        name: `源${i}`,
        baseUrl: `https://vod${i}.example.com/api.php/provide/vod`,
      }))
    );

    expect(result.sources).toHaveLength(MAX_VOD_SOURCES);
    expect(result.stats?.truncated).toBe(2);
  });

  it('两种格式都不匹配时抛格式错误', () => {
    expect(() => parseSubscriptionPayload({ name: '空的' })).toThrow(/格式不正确/);
    expect(() => parseSubscriptionPayload(null)).toThrow(/格式不正确/);
  });
});

describe('describeParseStats / withSkipped', () => {
  it('无异常时返回空串，有跳过时给出原因与示例', () => {
    expect(describeParseStats(undefined)).toBe('');
    expect(describeParseStats({ format: 'libretv', skipped: 0, skippedByReason: {}, truncated: 0 })).toBe('');

    const stats = {
      format: 'tvbox' as const,
      skipped: 4,
      skippedByReason: { spider: 3, xml: 1 },
      skippedSamples: ['蜘蛛A', 'XML站'],
      truncated: 2,
    };
    expect(describeParseStats(stats)).toBe('跳过 4 个不可用条目（Spider 引擎 3、XML 接口 1），如「蜘蛛A」「XML站」，超出上限截断 2 条');
    // toast 场景：省略示例名以保持文案精简
    expect(describeParseStats(stats, { includeSamples: false })).toBe('跳过 4 个不可用条目（Spider 引擎 3、XML 接口 1），超出上限截断 2 条');
  });

  it('withSkipped 累加原因计数且不修改原对象', () => {
    const base = { format: 'tvbox' as const, skipped: 1, skippedByReason: { spider: 1 }, truncated: 0 };
    const merged = withSkipped(base, 'invalidUrl', 2);

    expect(merged).toEqual({ format: 'tvbox', skipped: 3, skippedByReason: { spider: 1, invalidUrl: 2 }, truncated: 0 });
    expect(base.skipped).toBe(1);
    expect(withSkipped(undefined, 'invalidUrl', 0)).toEqual({ format: 'libretv', skipped: 0, skippedByReason: {}, truncated: 0 });
  });
});

describe('parseSubscriptionJson', () => {
  it('容忍行注释、块注释与尾随逗号（共享配置常见）', () => {
    const text = [
      '{',
      '  // 站点列表',
      '  "sites": [',
      '    { "name": "A", "type": 1, "api": "https://a.example.com/api.php/provide/vod" }, // 行内注释',
      '  ],',
      '  /* 直播源 */',
      '  "lives": [],',
      '}',
    ].join('\n');

    const json = parseSubscriptionJson(text) as { sites: { api: string }[] };
    expect(json.sites).toHaveLength(1);
    expect(json.sites[0].api).toBe('https://a.example.com/api.php/provide/vod');
  });

  it('字符串内的裸换行/制表符被转义（共享配置的实际写法）', () => {
    const json = parseSubscriptionJson('{"name":"优\n酷","tab":"a\tb"}') as Record<string, string>;
    expect(json.name).toBe('优\n酷');
    expect(json.tab).toBe('a\tb');
  });

  it('字符串内的 // 与转义引号不被误伤', () => {
    const json = parseSubscriptionJson('{"a":"https://x//y","b":"say \\"hi\\""}') as Record<string, string>;
    expect(json.a).toBe('https://x//y');
    expect(json.b).toBe('say "hi"');
  });

  it('非法内容抛出可读错误', () => {
    expect(() => parseSubscriptionJson('<html>403 Forbidden</html>')).toThrow(/不是合法的 JSON/);
  });
});
