import { describe, expect, it } from 'vitest';
import { buildRelatedSearchTerms } from './related-movies';

describe('buildRelatedSearchTerms', () => {
  it('uses actor and director credits rather than only repeating the current title', () => {
    expect(buildRelatedSearchTerms({
      actor: '张三 / 李四 / 王五',
      director: '赵六',
    }, '今天是太阳雨')).toEqual(['张三', '赵六']);
  });

  it('deduplicates people and tolerates missing credits', () => {
    expect(buildRelatedSearchTerms({
      actor: '张三、张三',
      director: '张三',
    }, '影片标题')).toEqual(['张三']);
  });

  it('falls back to the current title only when credits are unavailable', () => {
    expect(buildRelatedSearchTerms({ actor: '', director: ' ' }, '  今天是太阳雨  '))
      .toEqual(['今天是太阳雨']);
  });

  it('returns no search term when both credits and title are absent', () => {
    expect(buildRelatedSearchTerms(undefined, '  ')).toEqual([]);
  });
});
