/**
 * 首页豆瓣推荐的栏目定义与预设标签。
 *
 * 后端 `/api/douban` 的 tag 直接透传给豆瓣，只有长度截断、没有白名单，
 * 所以自定义栏目只需在前端保存 { name, type, tag }；这里负责把持久化数据
 * 归一化成安全可用的列表（剔除空项、限长、去重 id）。
 */

export type DoubanCategoryType = 'movie' | 'tv';

export interface DoubanCategory {
  /** 稳定标识，供 React key 与当前选中项比对 */
  id: string;
  /** 首页展示的栏目名 */
  name: string;
  type: DoubanCategoryType;
  /** 豆瓣搜索标签，与后端 slice(0, 20) 保持一致 */
  tag: string;
}

/** 栏目过多会把设置页和首页都撑爆，与后端 tag 上限一起做硬约束 */
export const MAX_DOUBAN_CATEGORIES = 20;
export const DOUBAN_NAME_MAX_LENGTH = 12;
export const DOUBAN_TAG_MAX_LENGTH = 20;

export const MOVIE_TAGS = ['热门', '最新', '经典', '豆瓣高分', '冷门佳片', '华语', '欧美', '韩国', '日本', '动画'];
export const TV_TAGS = ['热门', '美剧', '英剧', '韩剧', '日剧', '国产剧', '港剧', '日本动画', '综艺', '纪录片'];

/**
 * 归一化持久化/导入的栏目列表：空名称或空标签的条目在编辑过程中允许存在，
 * 但不会进入首页（用户填完即自动生效）。
 */
export function normalizeDoubanCategories(input: unknown): DoubanCategory[] {
  if (!Array.isArray(input)) return [];
  const out: DoubanCategory[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (out.length >= MAX_DOUBAN_CATEGORIES) break;
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const name = typeof item.name === 'string' ? item.name.trim().slice(0, DOUBAN_NAME_MAX_LENGTH) : '';
    const tag = typeof item.tag === 'string' ? item.tag.trim().slice(0, DOUBAN_TAG_MAX_LENGTH) : '';
    if (!name || !tag) continue;
    const type: DoubanCategoryType = item.type === 'tv' ? 'tv' : 'movie';
    const base = typeof item.id === 'string' && item.id.trim()
      ? item.id.trim().slice(0, 40)
      : `${type}:${tag}`;
    let id = base;
    let suffix = 2;
    while (seen.has(id)) id = `${base}#${suffix++}`;
    seen.add(id);
    out.push({ id, name, type, tag });
  }
  return out;
}
