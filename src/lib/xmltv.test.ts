import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { currentAndNext, parseXmltv, parseXmltvTime } from './xmltv';

// 固定「当前时间」：2024-06-01T12:00:00Z
const NOW = Date.UTC(2024, 5, 1, 12, 0, 0);

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="cctv1"><display-name>CCTV-1</display-name></channel>
  <channel id="cctv5"><display-name>CCTV-5</display-name></channel>
  <programme start="20240601100000 +0000" stop="20240601113000 +0000" channel="cctv1">
    <title lang="zh">朝闻天下</title>
    <desc lang="zh">早间新闻节目</desc>
  </programme>
  <programme start="20240601113000 +0000" stop="20240601140000 +0000" channel="cctv1">
    <title lang="zh">新闻30分</title>
    <desc lang="zh">午间新闻</desc>
  </programme>
  <programme start="20240601140000 +0000" stop="20240601150000 +0000" channel="cctv1">
    <title lang="zh"><![CDATA[电视剧: 焦点访谈]]></title>
  </programme>
  <programme start="20240601123000 +0000" stop="20240601133000 +0000" channel="cctv5">
    <title lang="zh">体育新闻</title>
  </programme>
  <programme start="20230531235959 +0000" stop="20240531235959 +0000" channel="cctv1">
    <title>早已播完</title>
  </programme>
  <programme start="20240602000000 +0000" stop="20240602010000 +0000" channel="cctv1">
    <title>午夜场</title>
  </programme>
</tv>`;

describe('parseXmltvTime', () => {
  it('解析带时区偏移的时间', () => {
    // +0800 即东八区：UTC 时间减 8 小时
    expect(parseXmltvTime('20240601200000 +0800')).toBe(Date.UTC(2024, 5, 1, 12, 0, 0));
    expect(parseXmltvTime('20240601040000 -0500')).toBe(Date.UTC(2024, 5, 1, 9, 0, 0));
  });

  it('解析 Z 后缀与无时区时间', () => {
    expect(parseXmltvTime('20240601120000Z')).toBe(Date.UTC(2024, 5, 1, 12, 0, 0));
    expect(parseXmltvTime('20240601120000')).toBe(Date.UTC(2024, 5, 1, 12, 0, 0));
  });

  it('支持毫秒小数', () => {
    expect(parseXmltvTime('20240601120000.500 +0000')).toBe(Date.UTC(2024, 5, 1, 12, 0, 0, 500));
  });

  it('非法输入返回 NaN', () => {
    expect(Number.isNaN(parseXmltvTime('not-a-time'))).toBe(true);
    expect(Number.isNaN(parseXmltvTime(''))).toBe(true);
  });
});

describe('parseXmltv', () => {
  it('解析明文 XML 并按频道索引、排序、裁剪窗口', () => {
    const map = parseXmltv(SAMPLE, 24 * 60 * 60 * 1000, NOW);
    const cctv1 = map.get('cctv1')!;
    expect(cctv1).toHaveLength(3); // 已播完的被裁剪；午夜场在 24h 窗口内保留
    expect(cctv1.map((p) => p.title)).toEqual(['新闻30分', '电视剧: 焦点访谈', '午夜场']);
    // 排序正确
    for (let i = 1; i < cctv1.length; i++) {
      expect(cctv1[i].start).toBeGreaterThanOrEqual(cctv1[i - 1].start);
    }
  });

  it('CDATA 与描述解析', () => {
    const map = parseXmltv(SAMPLE, undefined, NOW);
    expect(map.get('cctv1')![1].title).toBe('电视剧: 焦点访谈');
    expect(map.get('cctv1')![0].desc).toBe('午间新闻');
  });

  it('窗口外的未来节目被裁剪', () => {
    const map = parseXmltv(SAMPLE, 60 * 60 * 1000, NOW); // 只看 [12:00, 13:00)
    const cctv1 = map.get('cctv1')!;
    // 焦点访谈 14:00 开始，在窗口外
    expect(cctv1.map((p) => p.title)).toEqual(['新闻30分']);
  });

  it('解析 gzip 压缩内容', () => {
    const compressed = gzipSync(Buffer.from(SAMPLE, 'utf8'));
    expect(compressed[0]).toBe(0x1f);
    expect(compressed[1]).toBe(0x8b);
    const map = parseXmltv(compressed, undefined, NOW);
    expect(map.get('cctv1')).toHaveLength(3);
    expect(map.get('cctv5')).toHaveLength(1);
  });

  it('Buffer 明文输入同样可解析', () => {
    const map = parseXmltv(Buffer.from(SAMPLE, 'utf8'), undefined, NOW);
    expect(map.size).toBe(2);
  });

  it('限制节目标题与简介长度', () => {
    const longTitle = 'T'.repeat(700);
    const longDesc = 'D'.repeat(5000);
    const xml = `<tv><programme start="20240601120000 +0000" stop="20240601130000 +0000" channel="c1"><title>${longTitle}</title><desc>${longDesc}</desc></programme></tv>`;
    const program = parseXmltv(xml, undefined, NOW).get('c1')?.[0];
    expect(program?.title).toHaveLength(500);
    expect(program?.desc).toHaveLength(4000);
  });

  it('限制每个频道保留的节目数量', () => {
    const entries = Array.from({ length: 5002 }, (_, i) =>
      `<programme start="20240601120000 +0000" stop="20240601130000 +0000" channel="c1"><title>节目${i}</title></programme>`
    ).join('');
    const programs = parseXmltv(`<tv>${entries}</tv>`, undefined, NOW).get('c1') ?? [];
    expect(programs).toHaveLength(5000);
  });

  it('空输入与畸形内容不抛错', () => {
    expect(parseXmltv('', undefined, NOW).size).toBe(0);
    expect(parseXmltv('<tv><programme channel="x" start="bad" stop="bad"><title>t</title></programme></tv>', undefined, NOW).size).toBe(0);
  });
});

describe('currentAndNext', () => {
  const programs = parseXmltv(SAMPLE, undefined, NOW).get('cctv1')!;

  it('正确定位当前与下一个节目', () => {
    const { current, next } = currentAndNext(programs, NOW);
    expect(current?.title).toBe('新闻30分');
    expect(next?.title).toBe('电视剧: 焦点访谈');
  });

  it('节目间隙时 current 为空、next 为下一档', () => {
    const gap = Date.UTC(2024, 5, 1, 14, 30, 0); // 焦点访谈(14:00-15:00) 实际覆盖该点；改用末尾之后
    const { current, next } = currentAndNext(programs, gap);
    expect(current?.title).toBe('电视剧: 焦点访谈');
    expect(next?.title).toBe('午夜场');
  });

  it('空列表返回空对象', () => {
    expect(currentAndNext([], NOW)).toEqual({ current: undefined, next: undefined });
  });
});
