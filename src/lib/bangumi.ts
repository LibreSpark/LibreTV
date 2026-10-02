import type { DoubanItem } from './types';
import { fetchUpstream, getCache, setCache } from './fetch-utils';

/**
 * Bangumi 每日放送（新番时间表）数据获取。
 * api.bgm.tv 完全公开免 key，服务端直连 + 内存缓存；
 * 数据复用 DoubanItem 结构，前端推荐区可无差别渲染。
 */

const BANGUMI_API = 'https://api.bgm.tv/calendar';
const CACHE_TTL = 30 * 60 * 1000;
// Bangumi 要求自带可识别的 UA，默认 UA（如 axios/undici）会被拒绝
const UA = 'LibreTV (+https://github.com/LibreSpark/LibreTV)';

/** 星期 id：1=周一 … 7=周日；calendar 偶发返回 8 等非法值，直接丢弃 */
export function normalizeWeekday(id: number): number | undefined {
  return id >= 1 && id <= 7 ? id : undefined;
}

interface BangumiSubject {
  id?: number;
  name?: string;
  name_cn?: string;
  images?: { large?: string; common?: string; medium?: string; small?: string; grid?: string };
  rating?: { score?: number };
}

interface BangumiCalendarDay {
  weekday?: { id?: number; en?: string; cn?: string };
  items?: BangumiSubject[];
}

/** 单条 subject → DoubanItem；缺标题或封面的条目视为脏数据丢弃 */
export function subjectToItem(subject: BangumiSubject): DoubanItem | undefined {
  const title = subject.name_cn || subject.name;
  const cover = subject.images?.large || subject.images?.common || subject.images?.medium;
  if (!subject.id || !title || !cover) return undefined;
  const score = subject.rating?.score ?? 0;
  return {
    id: String(subject.id),
    title,
    cover,
    rating: score > 0 ? score.toFixed(1) : undefined,
    isTv: true,
  };
}

export function groupCalendarByWeekday(raw: BangumiCalendarDay[]): Record<number, DoubanItem[]> {
  const days: Record<number, DoubanItem[]> = {};
  for (const day of raw) {
    const weekday = normalizeWeekday(day.weekday?.id ?? -1);
    if (!weekday) continue;
    const items = (day.items ?? [])
      .map(subjectToItem)
      .filter((item): item is DoubanItem => item !== undefined);
    days[weekday] = items;
  }
  return days;
}

export async function fetchBangumiCalendar(): Promise<Record<number, DoubanItem[]>> {
  const cached = getCache<Record<number, DoubanItem[]>>(BANGUMI_API);
  if (cached) return cached;

  const res = await fetchUpstream(BANGUMI_API, {
    timeoutMs: 8000,
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Bangumi 接口响应异常 (${res.status})`);

  const raw = (await res.json()) as BangumiCalendarDay[];
  const days = groupCalendarByWeekday(Array.isArray(raw) ? raw : []);
  if (Object.keys(days).length === 0) throw new Error('Bangumi 放送表数据为空');

  setCache(BANGUMI_API, days, CACHE_TTL);
  return days;
}
