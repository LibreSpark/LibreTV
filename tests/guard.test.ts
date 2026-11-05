import { describe, expect, it } from 'vitest';
import { StreamScanner, KeywordMatcher, normalizeWithMap, guardMovieItems } from '@/lib/infra/guard';
import type { KeywordRule } from '@/lib/infra/guard';

const RULES: KeywordRule[] = [
  { word: '盗版链接', level: 'high', action: 'mask' },
  { word: '链接', level: 'low', action: 'mask' },
  { word: 'Oppenheimer', level: 'high', action: 'mask' },
];

describe('KeywordMatcher & StreamScanner V2', () => {
  const matcher = new KeywordMatcher(RULES);

  it('全角字符 NFKC 归一化能命中，且不切断代理对', () => {
    const s = new StreamScanner(matcher, 'mask');
    const out = s.push('看 Ｏｐｐｅｎｈｅｉｍｅｒ 吗') + s.flush();
    expect(out).toBe('看 *********** 吗');
    expect(s.hitWords).toContain('Oppenheimer');
  });

  it('后缀重叠词（盗版链接 包含 链接）均能被记录，且完美掩码', () => {
    const s = new StreamScanner(matcher, 'mask');
    const out = s.push('这里有盗版链接') + s.flush();
    expect(out).toBe('这里有****');
    expect(s.hitWords).toContain('盗版链接');
    expect(s.hitWords).toContain('链接');
  });

  it('掩码不污染原始空格与大小写', () => {
    const s = new StreamScanner(matcher, 'mask');
    const out = s.push('Spider Man 盗版链接') + s.flush();
    expect(out).toBe('Spider Man ****');
  });

  it('被切断的跨 chunk 词汇仍能正确掩码且不丢字', () => {
    const s = new StreamScanner(matcher, 'mask');
    const a = s.push('这里有盗版'); 
    const b = s.push('链接哦，还有'); 
    const c = s.flush();
    expect(a + b + c).toBe('这里有****哦，还有');
  });
});

describe('guardMovieItems', () => {
  it('丢弃 path 非法与标题含脚本的条目', () => {
    const r = guardMovieItems([
      { id: '1', title: '正常', poster: '/p.jpg', path: '/movie/1' },
      { id: '2', title: '坏', poster: '/p.jpg', path: '//evil.com' },
      { id: '3', title: 'x', poster: '/p.jpg', path: '/movie/3' },
    ]);
    expect(r.items.map(i => i.id)).toEqual(['1']);
    expect(r.dropped).toBe(2);
  });
});
