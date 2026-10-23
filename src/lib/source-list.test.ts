import { describe, expect, it } from 'vitest';
import { MAX_LIVE_SOURCES, MAX_VOD_SOURCES, normalizeSubscriptionUrl, parseSourceListPayload } from './source-list';

const vod = (url: string, extra: Record<string, unknown> = {}) => ({ name: `源 ${url}`, url, ...extra });
const live = (url: string, extra: Record<string, unknown> = {}) => ({ name: `频道 ${url}`, url, ...extra });

describe('parseSourceListPayload', () => {
  it('解析点播源与直播源', () => {
    const result = parseSourceListPayload({
      name: '我的全站源',
      version: 2,
      sources: [vod('https://vod.example.com/api.php/provide/vod', { detail: 'https://vod.example.com', isAdult: true })],
      liveSources: [live('https://live.example.com/list.m3u', { epg: 'https://live.example.com/epg.xml.gz' })],
    });

    expect(result.name).toBe('我的全站源');
    expect(result.sources).toEqual([
      {
        name: '源 https://vod.example.com/api.php/provide/vod',
        url: 'https://vod.example.com/api.php/provide/vod',
        detail: 'https://vod.example.com',
        isAdult: true,
      },
    ]);
    expect(result.liveSources).toEqual([
      {
        name: '频道 https://live.example.com/list.m3u',
        url: 'https://live.example.com/list.m3u',
        epg: 'https://live.example.com/epg.xml.gz',
      },
    ]);
  });

  it('缺失名称时用 hostname 兜底', () => {
    const result = parseSourceListPayload({
      sources: [{ url: 'https://vod.example.com/api.php/provide/vod' }],
      liveSources: [{ url: 'https://live.example.com/list.m3u' }],
    });

    expect(result.sources[0].name).toBe('vod.example.com');
    expect(result.liveSources[0].name).toBe('live.example.com');
  });

  it('老格式（只有 sources）兼容为纯点播订阅', () => {
    const result = parseSourceListPayload({
      name: '老订阅',
      sources: [{ url: 'https://vod.example.com/api.php/provide/vod/' }],
    });

    expect(result.sources).toHaveLength(1);
    expect(result.liveSources).toEqual([]);
  });

  it('裸数组视为点播源列表', () => {
    const result = parseSourceListPayload([{ url: 'https://a.example.com/api.php/provide/vod' }]);

    expect(result.name).toBeUndefined();
    expect(result.sources).toHaveLength(1);
    expect(result.liveSources).toEqual([]);
  });

  it('只含 liveSources 的纯直播订阅可用', () => {
    const result = parseSourceListPayload({
      name: '纯直播',
      liveSources: [{ url: 'https://live.example.com/list.m3u' }],
    });

    expect(result.sources).toEqual([]);
    expect(result.liveSources).toHaveLength(1);
  });

  it('过滤非法协议与空地址', () => {
    const result = parseSourceListPayload({
      sources: [
        { url: 'ftp://vod.example.com/vod' },
        { url: '' },
        { name: '无 url' },
        { url: 'https://ok.example.com/vod' },
      ],
      liveSources: [
        { url: 'rtmp://live.example.com/live' },
        { url: 'https://live.example.com/list.m3u', epg: 'javascript:alert(1)' },
      ],
    });

    expect(result.sources.map((s) => s.url)).toEqual(['https://ok.example.com/vod']);
    expect(result.liveSources).toHaveLength(1);
    expect(result.liveSources[0].epg).toBeUndefined();
  });

  it('按 url 去重（点播去尾部斜杠后比较，直播保留原样）', () => {
    const result = parseSourceListPayload({
      sources: [
        { url: 'https://vod.example.com/vod' },
        { url: 'https://vod.example.com/vod/' },
      ],
      liveSources: [
        { url: 'https://live.example.com/list.m3u' },
        { url: 'https://live.example.com/list.m3u' },
        { url: 'https://live.example.com/other.m3u' },
      ],
    });

    expect(result.sources).toHaveLength(1);
    expect(result.liveSources).toHaveLength(2);
  });

  it('将无内容的尾随问号/井号规范化，避免重复 API 接口', () => {
    const result = parseSourceListPayload({
      sources: [
        { url: 'https://vod.example.com/api.php/provide/vod?' },
        { url: 'https://vod.example.com/api.php/provide/vod#' },
        { url: 'https://vod.example.com/api.php/provide/vod' },
      ],
    });

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].url).toBe('https://vod.example.com/api.php/provide/vod');
  });

  it('超出上限时截断', () => {
    const sources = Array.from({ length: MAX_VOD_SOURCES + 10 }, (_, i) => ({
      url: `https://vod${i}.example.com/vod`,
    }));
    const liveSources = Array.from({ length: MAX_LIVE_SOURCES + 10 }, (_, i) => ({
      url: `https://live${i}.example.com/list.m3u`,
    }));

    const result = parseSourceListPayload({ sources, liveSources });

    expect(result.sources).toHaveLength(MAX_VOD_SOURCES);
    expect(result.liveSources).toHaveLength(MAX_LIVE_SOURCES);
  });

  it('截断前先去重：前段重复不挤占上限名额', () => {
    const sources = [
      ...Array.from({ length: 60 }, () => ({ url: 'https://dup.example.com/vod' })),
      ...Array.from({ length: MAX_VOD_SOURCES }, (_, i) => ({ url: `https://vod${i}.example.com/vod` })),
    ];

    const result = parseSourceListPayload({ sources });

    expect(result.sources).toHaveLength(MAX_VOD_SOURCES);
    expect(result.sources[0].url).toBe('https://dup.example.com/vod');
  });

  it('既无点播也无直播时抛错', () => {
    expect(() => parseSourceListPayload({ name: '空的' })).toThrow(/格式不正确/);
    expect(() => parseSourceListPayload({ sources: [] })).toThrow(/格式不正确/);
    expect(() => parseSourceListPayload(null)).toThrow(/格式不正确/);
  });
});

describe('normalizeSubscriptionUrl', () => {
  it('trim 并去掉尾部斜杠，避免同一地址被存成两条订阅', () => {
    expect(normalizeSubscriptionUrl('  https://a.example.com/list.json/  ')).toBe('https://a.example.com/list.json');
    expect(normalizeSubscriptionUrl('https://a.example.com/list.json///')).toBe('https://a.example.com/list.json');
    expect(normalizeSubscriptionUrl('https://a.example.com/list.json')).toBe('https://a.example.com/list.json');
  });
});
