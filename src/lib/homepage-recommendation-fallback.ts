import type { DoubanResponse } from './types';

/**
 * Prefer the live Douban endpoint, then fall back to the configured 60s-backed
 * real hot-list API. Never fabricate cards: both paths must return real items.
 */
export async function fetchHomepageWithFallback(
  primary: () => Promise<DoubanResponse>,
  fallback: () => Promise<DoubanResponse>,
  signal?: AbortSignal
): Promise<DoubanResponse> {
  let primaryError: unknown;
  try {
    const result = await primary();
    const visibleItems = result.items.filter((item) => item.title?.trim() && item.cover?.trim());
    if (visibleItems.length > 0) return { ...result, items: visibleItems };
  } catch (error) {
    if (signal?.aborted) throw error;
    primaryError = error;
  }

  try {
    const result = await fallback();
    const visibleItems = result.items.filter((item) => item.title?.trim() && item.cover?.trim());
    if (visibleItems.length > 0) return { ...result, items: visibleItems };
  } catch (error) {
    if (signal?.aborted) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    const primaryDetail = primaryError instanceof Error ? primaryError.message : '豆瓣无可展示内容';
    throw new Error(`豆瓣推荐不可用（${primaryDetail}），热榜备用源也失败（${detail}）`);
  }

  const primaryDetail = primaryError instanceof Error ? primaryError.message : '豆瓣无可展示内容';
  throw new Error(`豆瓣推荐不可用（${primaryDetail}），热榜备用源没有可展示内容`);
}
