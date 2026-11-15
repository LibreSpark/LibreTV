import { describe, expect, it, vi } from 'vitest';
import { fetchHomepageWithFallback } from './homepage-recommendation-fallback';
import type { DoubanResponse } from './types';

const item = { id: '1', title: 'Real source item', cover: 'https://images.example/poster.jpg' };
const response = (items: DoubanResponse['items']): DoubanResponse => ({ items });

describe('fetchHomepageWithFallback', () => {
  it('uses Douban when it returns real items and does not call the fallback', async () => {
    const primary = vi.fn().mockResolvedValue(response([item]));
    const fallback = vi.fn();
    await expect(fetchHomepageWithFallback(primary, fallback)).resolves.toEqual(response([item]));
    expect(fallback).not.toHaveBeenCalled();
  });

  it('uses the 60s hot-list fallback when Douban fails', async () => {
    const fallback = vi.fn().mockResolvedValue(response([item]));
    await expect(fetchHomepageWithFallback(
      vi.fn().mockRejectedValue(new Error('upstream 403')),
      fallback
    )).resolves.toEqual(response([item]));
    expect(fallback).toHaveBeenCalledOnce();
  });

  it('uses the fallback when Douban returns an empty list', async () => {
    const fallback = vi.fn().mockResolvedValue(response([item]));
    await expect(fetchHomepageWithFallback(
      vi.fn().mockResolvedValue(response([])),
      fallback
    )).resolves.toEqual(response([item]));
  });


  it('uses the fallback when Douban returns records without usable poster URLs', async () => {
    const fallback = vi.fn().mockResolvedValue(response([item]));
    await expect(fetchHomepageWithFallback(
      vi.fn().mockResolvedValue(response([
        { id: 'broken', title: 'No poster', cover: '' },
      ])),
      fallback
    )).resolves.toEqual(response([item]));
    expect(fallback).toHaveBeenCalledOnce();
  });

  it('removes incomplete records when a source returns a mixed list', async () => {
    const primary = vi.fn().mockResolvedValue(response([
      item,
      { id: 'broken', title: 'Missing artwork', cover: '' },
    ]));
    await expect(fetchHomepageWithFallback(primary, vi.fn())).resolves.toEqual(response([item]));
  });

  it('does not hide an abort behind a fallback request', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = new DOMException('Aborted', 'AbortError');
    const fallback = vi.fn();
    await expect(fetchHomepageWithFallback(
      vi.fn().mockRejectedValue(error),
      fallback,
      controller.signal
    )).rejects.toBe(error);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('returns an explicit error instead of leaving skeletons when both sources fail', async () => {
    await expect(fetchHomepageWithFallback(
      vi.fn().mockRejectedValue(new Error('Douban blocked')),
      vi.fn().mockRejectedValue(new Error('60s unavailable'))
    )).rejects.toThrow('豆瓣推荐不可用（Douban blocked），热榜备用源也失败（60s unavailable）');
  });
});
