import { afterEach, describe, expect, it } from 'vitest';
import { setCurrentLang, tr } from './i18n-core';
import { EN } from './i18n-en';

describe('tr', () => {
  afterEach(() => setCurrentLang('zh'));

  it('中文模式原样返回并替换占位符', () => {
    expect(tr('共 {n} 集', { n: 3 })).toBe('共 3 集');
  });

  it('英文模式命中词典时翻译，缺项回退中文原文', () => {
    setCurrentLang('en');
    expect(tr('共 {n} 集', { n: 3 })).toBe('3 episodes');
    expect(tr('词典里没有的文案')).toBe('词典里没有的文案');
  });

  it('未提供的占位符保持原样，undefined 变量替换为空串', () => {
    expect(tr('{a}-{b}', { a: 1 })).toBe('1-{b}');
    expect(tr('[{a}]', { a: undefined })).toBe('[]');
  });

  it('词典译文与原文的占位符一致', () => {
    const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(',');
    for (const [zh, en] of Object.entries(EN)) {
      expect(placeholders(en), zh).toBe(placeholders(zh));
    }
  });
});
