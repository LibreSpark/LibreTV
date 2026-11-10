import { expect, it } from 'vitest';
import { mergeRecommendationPages, nextRecommendationOffset } from './recommendation-pages';
import type { DoubanResponse } from './types';

const page = (...ids: string[]): DoubanResponse => ({ items: ids.map((id) => ({ id, title: id, cover: '' })) });

it('advances the upstream cursor even when a page is shorter than the requested size', () => {
  const first = page('1', '2');
  expect(nextRecommendationOffset(first, [first], 0)).toBe(50);
  const second = page('3');
  expect(nextRecommendationOffset(second, [first, second], 50)).toBe(100);
});

it('stops at a genuinely empty page', () => {
  expect(nextRecommendationOffset(page(), [page('1'), page()], 50)).toBeUndefined();
});

it('stops when an upstream repeats an earlier page instead of advancing', () => {
  const first = page('1', '2'), repeated = page('2', '1');
  expect(nextRecommendationOffset(repeated, [first, repeated], 50)).toBeUndefined();
});

it('keeps loading a partially overlapping page and renders each movie once in source order', () => {
  const first = page('1', '2', '2'), second = page('2', '3');
  expect(nextRecommendationOffset(second, [first, second], 50)).toBe(100);
  expect(mergeRecommendationPages([first, second]).map((item) => item.id)).toEqual(['1', '2', '3']);
});

it('keeps the first metadata for duplicate IDs and does not mutate cached pages', () => {
  const first = page('1'), second = page('1');
  second.items[0].title = 'changed';
  expect(mergeRecommendationPages([first, second])[0].title).toBe('1');
  expect(second.items[0].title).toBe('changed');
});
