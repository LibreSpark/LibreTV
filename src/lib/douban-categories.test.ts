import { describe, expect, it } from 'vitest';
import {
  DOUBAN_NAME_MAX_LENGTH,
  DOUBAN_TAG_MAX_LENGTH,
  MAX_DOUBAN_CATEGORIES,
  MOVIE_TAGS,
  TV_TAGS,
  normalizeDoubanCategories,
  type DoubanCategory,
} from './douban-categories';

const category = (name: string, type: DoubanCategory['type'], tag: string, id = `${type}:${tag}`): DoubanCategory => ({
  id,
  name,
  type,
  tag,
});

describe('normalizeDoubanCategories', () => {
  it('非数组输入一律回到空列表', () => {
    expect(normalizeDoubanCategories(undefined)).toEqual([]);
    expect(normalizeDoubanCategories(null)).toEqual([]);
    expect(normalizeDoubanCategories({ name: '韩国电影' })).toEqual([]);
  });

  it('去掉首尾空格，空名称/空标签的条目不进入首页', () => {
    const result = normalizeDoubanCategories([
      category('  韩国电影  ', 'movie', '  韩国  ', ''),
      category('没填标签', 'movie', '   '),
      category('  ', 'tv', '悬疑'),
      null,
      'oops',
    ]);
    expect(result).toEqual([category('韩国电影', 'movie', '韩国')]);
  });

  it('type 非法时按 movie 处理，tag 与名称按后端上限截断', () => {
    const result = normalizeDoubanCategories([
      { id: 'x', name: 'a'.repeat(DOUBAN_NAME_MAX_LENGTH + 5), type: 'anime', tag: 'b'.repeat(DOUBAN_TAG_MAX_LENGTH + 5) },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('movie');
    expect(result[0].name).toHaveLength(DOUBAN_NAME_MAX_LENGTH);
    expect(result[0].tag).toHaveLength(DOUBAN_TAG_MAX_LENGTH);
  });

  it('id 冲突时补后缀，保证每个条目 key 唯一', () => {
    const result = normalizeDoubanCategories([
      category('韩国电影', 'movie', '韩国', 'dup'),
      category('韩国剧', 'tv', '韩国', 'dup'),
      category('悬疑', 'tv', '悬疑', 'dup'),
    ]);
    expect(result.map((c) => c.id)).toEqual(['dup', 'dup#2', 'dup#3']);
  });

  it('超过上限时截断，保留前面的栏目顺序', () => {
    const input = Array.from({ length: MAX_DOUBAN_CATEGORIES + 5 }, (_, i) => category(`栏目${i}`, 'movie', `tag${i}`));
    const result = normalizeDoubanCategories(input);
    expect(result).toHaveLength(MAX_DOUBAN_CATEGORIES);
    expect(result[0].name).toBe('栏目0');
    expect(result.at(-1)?.name).toBe(`栏目${MAX_DOUBAN_CATEGORIES - 1}`);
  });

  it('内置标签保留 issue #988 提到的例子', () => {
    expect(MOVIE_TAGS).toContain('韩国');
    expect(MOVIE_TAGS).toContain('华语');
    expect(TV_TAGS).toContain('美剧');
  });
});
