import type { DoubanItem } from './types';
import { fetchUpstream, getCache, setCache } from './fetch-utils';

/**
 * 影视热榜聚合（经 60s API，免 key，https://github.com/vikiboss/60s）。
 * 豆瓣周榜走其 rexxar 移动端接口（需伪装 iPhone UA），百度热播剧榜解析 top.baidu.com，
 * 均由 60s 代为抓取；这里只做服务端转发 + 内存缓存 + 字段归一。
 * 默认优先使用已验证可返回数据的 60s.viki.moe，失败后回退 60s.crystelf.top；
 * 可用 API_60S_BASE 指向自部署实例。
 */

const CACHE_TTL = 60 * 60 * 1000;
const UA = 'LibreTV (+https://github.com/LibreSpark/LibreTV)';

const FALLBACK_BASE = 'https://60s.crystelf.top';

function apiBase(): string {
  return (process.env['API_60S_BASE'] || 'https://60s.viki.moe').replace(/\/+$/, '');
}

/** 榜单标识：豆瓣五个周榜 + 百度热播剧榜 */
export const HOT_LIST_IDS = [
  'douban_movie_weekly',
  'douban_tv_chinese',
  'douban_tv_global',
  'douban_show_chinese',
  'douban_show_global',
  'baidu_teleplay',
] as const;

export type HotListId = (typeof HOT_LIST_IDS)[number];

export function isHotListId(id: string): id is HotListId {
  return (HOT_LIST_IDS as readonly string[]).includes(id);
}

const DOUBAN_WEEKLY_CATEGORY: Partial<Record<HotListId, string>> = {
  douban_movie_weekly: 'movie',
  douban_tv_chinese: 'tv_chinese',
  douban_tv_global: 'tv_global',
  douban_show_chinese: 'show_chinese',
  douban_show_global: 'show_global',
};

// —— 60s API 原始结构（只取用到的字段） ——

interface DoubanWeeklyRaw {
  id?: number | string;
  title?: string;
  rating?: number;
  cover_proxy?: string;
  cover?: string;
}

interface BaiduTeleplayRaw {
  title?: string;
  cover?: string | null;
}

interface SixtyResponse<T> {
  code?: number;
  data?: T;
}

/** 豆瓣周榜条目 → DoubanItem；缺标题或封面的脏数据丢弃 */
export function doubanWeeklyToItem(raw: DoubanWeeklyRaw, isTv: boolean): DoubanItem | undefined {
  // 原生 cover 是 img*.doubanio.com，命中图片代理的豆瓣白名单并带 Referer 伪装，
  // 可稳定加载；cover_proxy（doubanio.viki.moe 公共镜像）限流严重，仅作兜底
  const cover = raw.cover || raw.cover_proxy;
  if (!raw.id || !raw.title || !cover) return undefined;
  return {
    id: String(raw.id),
    title: raw.title,
    cover,
    rating: raw.rating && raw.rating > 0 ? String(raw.rating) : undefined,
    isTv,
  };
}

/** 百度热播剧条目 → DoubanItem；无评分，海报为空的条目丢弃 */
export function baiduTeleplayToItem(raw: BaiduTeleplayRaw, index: number): DoubanItem | undefined {
  if (!raw.title || !raw.cover) return undefined;
  return {
    // 百度榜无稳定 id，用榜单内序号保证 React key 唯一
    id: `baidu_${index}`,
    title: raw.title,
    cover: raw.cover,
    isTv: true,
  };
}

function assertArray<T>(value: unknown, what: string): T[] {
  if (!Array.isArray(value)) throw new Error(`${what}数据异常`);
  return value as T[];
}

async function fetchJson(path: string): Promise<unknown> {
  const primary = apiBase();

  // 主实例失败后回退备用实例；相同地址只请求一次
  const bases = primary === FALLBACK_BASE
    ? [primary]
    : [primary, FALLBACK_BASE];

  const failures: string[] = [];

  for (let index = 0; index < bases.length; index++) {
    const base = bases[index];
    const label = index === 0 ? '主接口' : '备用接口';

    let host = '未知地址';
    try {
      host = new URL(base).host;
    } catch {
      // 保留未知地址标记
    }

    try {
      const res = await fetchUpstream(`${base}${path}`, {
        timeoutMs: 8000,
        headers: {
          'User-Agent': UA,
          Accept: 'application/json',
        },
      });

      if (!res.ok) {
        const reason = `HTTP ${res.status}`;
        failures.push(`${label}(${host}) ${reason}`);

        console.warn(
          `[hot-list] ${label} ${host} ${path} 请求失败：${reason}`
        );

        continue;
      }

      try {
        const data: unknown = await res.json();

        console.info(
          `[hot-list] ${label} ${host} ${path} 请求成功`
        );

        return data;
      } catch (err) {
        const reason = err instanceof Error
          ? `JSON解析失败：${err.message}`
          : 'JSON解析失败';

        failures.push(`${label}(${host}) ${reason}`);

        console.error(
          `[hot-list] ${label} ${host} ${path} ${reason}`
        );
      }
    } catch (err) {
      const reason = err instanceof Error
        ? err.message
        : String(err);

      failures.push(`${label}(${host}) ${reason}`);

      console.error(
        `[hot-list] ${label} ${host} ${path} 请求异常：${reason}`
      );
    }
  }

  throw new Error(
    `60s API 请求失败：${failures.join('；') || '未知错误'}`
  );
}

export async function fetchHotList(id: HotListId): Promise<DoubanItem[]> {
  const cacheKey = `hot-list:${id}`;
  const cached = getCache<DoubanItem[]>(cacheKey);
  if (cached) return cached;

  let items: DoubanItem[];

  const category = DOUBAN_WEEKLY_CATEGORY[id];
  if (category) {
    const raw = (await fetchJson(`/v2/douban/weekly/${category}`)) as SixtyResponse<DoubanWeeklyRaw[]>;
    const isTv = id !== 'douban_movie_weekly';
    items = assertArray<DoubanWeeklyRaw>(raw.data, '豆瓣周榜')
      .map((entry) => doubanWeeklyToItem(entry, isTv))
      .filter((item): item is DoubanItem => item !== undefined);
  } else {
    const raw = (await fetchJson('/v2/baidu/teleplay')) as SixtyResponse<BaiduTeleplayRaw[]>;
    items = assertArray<BaiduTeleplayRaw>(raw.data, '百度热播剧榜')
      .map((entry, i) => baiduTeleplayToItem(entry, i))
      .filter((item): item is DoubanItem => item !== undefined);
  }

  if (items.length === 0) throw new Error('榜单数据为空');

  setCache(cacheKey, items, CACHE_TTL);
  return items;
}
