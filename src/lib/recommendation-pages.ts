import type { DoubanResponse } from './types';

export const RECOMMEND_PAGE_SIZE = 50;

/** Keep the source's first occurrence and ordering when pages overlap. */
export function mergeRecommendationPages(pages: DoubanResponse[]) {
  const seen = new Set<string>();
  return pages.flatMap((page) => page.items).filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

/** A short page can still have a successor; stop only on empty/repeated pages. */
export function nextRecommendationOffset(last: DoubanResponse, pages: DoubanResponse[], offset: number) {
  const previous = new Set(pages.slice(0, -1).flatMap((page) => page.items.map((item) => item.id)));
  return last.items.some((item) => !previous.has(item.id)) ? offset + RECOMMEND_PAGE_SIZE : undefined;
}
