export interface CatalogCategory { id: string; name: string; }
export interface CatalogItem { id: string; title: string; poster: string; year: string; remarks: string; languages?: string[]; regions?: string[]; updatedAt?: string; }
export interface CatalogPage {
  items: CatalogItem[]; categories: CatalogCategory[]; page: number;
  nextPage: number | null; rawCount: number; categoryWarning?: string;
}
type Row = Record<string, unknown>;
const row = (v: unknown): Row => v !== null && typeof v === 'object' ? v as Row : {};
const text = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '').slice(0, 1000);
const validId = (v: string) => /^[\w-]{1,100}$/.test(v);

export function catalogParameters(page: unknown, category: unknown) {
  const p = Number(page ?? 1), c = text(category);
  if (!Number.isInteger(p) || p < 1 || p > 100000 || (c !== '' && !/^\d{1,10}$/.test(c))) throw new Error('无效的目录页码或分类');
  return { page: p, category: c };
}

export function catalogUrl(base: string, page: number, category: string, metadata = false, query = '') {
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('无效的点播源地址');
  for (const key of ['wd', 'ids', 't', 'pg']) url.searchParams.delete(key);
  url.searchParams.set('ac', metadata ? 'list' : 'videolist');
  url.searchParams.set('pg', String(page));
  if (category) url.searchParams.set('t', category);
  if (query && !metadata) url.searchParams.set('wd', catalogQuery(query));
  return url.href;
}

export function parseCatalog(data: unknown, metadata: unknown, page: number, category: string, blocked: (name: string) => boolean): CatalogPage {
  const d = row(data), m = row(metadata);
  if (!Array.isArray(d.list)) throw new Error('该源未返回可浏览的目录，请稍后重试或更换点播源');
  const classes = (Array.isArray(m.class) ? m.class : []).slice(0, 1000).map(row);
  const forbidden = new Set(classes.filter(c => blocked(text(c.type_name))).map(c => text(c.type_id)));
  // A blocked parent also blocks its children even when the child name is neutral.
  for (let i = 0; i < classes.length; i++) {
    let changed = false;
    for (const c of classes) if (forbidden.has(text(c.type_pid)) && !forbidden.has(text(c.type_id))) { forbidden.add(text(c.type_id)); changed = true; }
    if (!changed) break;
  }
  if (category && forbidden.has(category)) throw new Error('此分类已被内容过滤隐藏');
  const names = new Map(classes.map(c => [text(c.type_id), text(c.type_name)]));
  const categories: CatalogCategory[] = [], seenCategories = new Set<string>();
  for (const c of classes) {
    const id = text(c.type_id), name = text(c.type_name);
    if (/^\d{1,10}$/.test(id) && name && !forbidden.has(id) && !seenCategories.has(id)) { categories.push({ id, name }); seenCategories.add(id); }
  }
  const raw = d.list.slice(0, 1000).map(row), items: CatalogItem[] = [], seen = new Set<string>();
  for (const v of raw) {
    const id = text(v.vod_id), title = text(v.vod_name), type = text(v.type_id);
    if (!validId(id) || !title || seen.has(id) || forbidden.has(type) || blocked(text(v.type_name) || names.get(type) || '')) continue;
    seen.add(id);
    let poster = '';
    try { const u = new URL(text(v.vod_pic)); if (['http:', 'https:'].includes(u.protocol)) poster = u.href; } catch { /* a missing cover uses the normal placeholder */ }
    items.push({ id, title, poster, year: text(v.vod_year), remarks: text(v.vod_remarks), languages: text(v.vod_lang).split(/[/,，、|]+/u).map(s => s.trim()).filter(Boolean), regions: text(v.vod_area).split(/[/,，、|]+/u).map(s => s.trim()).filter(Boolean), updatedAt: text(v.vod_time) });
  }
  const pages = Number(d.pagecount), reported = Number(d.page);
  const atEnd = raw.length === 0 || (Number.isFinite(pages) && pages > 0 && page >= pages) || (Number.isFinite(reported) && reported > 0 && reported !== page) || page >= 100000;
  return { items, categories, page, nextPage: atEnd ? null : page + 1, rawCount: raw.length };
}

export function appendCatalog(previous: CatalogItem[], incoming: CatalogPage) {
  const seen = new Set(previous.map(i => i.id));
  const additions = incoming.items.filter(i => { if (seen.has(i.id)) return false; seen.add(i.id); return true; });
  return { items: [...previous, ...additions], nextPage: incoming.items.length > 0 && additions.length === 0 ? null : incoming.nextPage };
}

const cache = new Map<string, { until: number; data: unknown }>();
async function cached(key: string, ttl: number, fetcher: () => Promise<unknown>) {
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.data;
  const data = await fetcher();
  if (cache.size >= 200) cache.delete(cache.keys().next().value as string);
  cache.set(key, { until: Date.now() + ttl, data });
  return data;
}
export async function loadCatalog(base: string, page: number, category: string, blocked: (name: string) => boolean, fetchJson: (url: string) => Promise<unknown>, query = ''): Promise<CatalogPage> {
  let metadata: unknown = {}, warning: string | undefined;
  try { metadata = await cached('meta:' + base, 300000, () => fetchJson(catalogUrl(base, 1, '', true))); }
  catch { warning = '分类暂时不可用，仍可浏览全部内容'; }
  const url = catalogUrl(base, page, category, false, query);
  const data = await cached('page:' + url, 60000, () => fetchJson(url));
  const result = parseCatalog(data, metadata, page, category, blocked);
  if (warning || !result.categories.length) result.categoryWarning = warning || '该源未提供分类，可浏览全部内容';
  return result;
}

export interface CatalogFilters { year: string; language: string; region: string; }
export type CatalogSort = 'source' | 'title-asc' | 'title-desc' | 'year-desc' | 'year-asc' | 'updated-desc' | 'updated-asc';
export function catalogQuery(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.trim().length > 100) throw new Error('无效的片名搜索条件');
  return value.trim();
}
export function catalogYear(item: CatalogItem) { return item.year?.match(/\d{4}/)?.[0] || ''; }
export function matchesCatalog(item: CatalogItem, filters: CatalogFilters) {
  return (!filters.year || catalogYear(item) === filters.year) && (!filters.language || (item.languages || []).includes(filters.language)) && (!filters.region || (item.regions || []).includes(filters.region));
}
export function catalogFacets(items: CatalogItem[]) {
  const collect = (values: string[]) => Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  return { years: collect(items.map(catalogYear)).reverse(), languages: collect(items.flatMap(i => i.languages || [])), regions: collect(items.flatMap(i => i.regions || [])) };
}
export function selectCatalogItems(items: CatalogItem[], filters: CatalogFilters, sort: CatalogSort): CatalogItem[] {
  const result = items.filter(i => matchesCatalog(i, filters));
  if (sort === 'source') return result;
  const direction = sort.endsWith('asc') ? 1 : -1;
  const updated = (i: CatalogItem) => { const value = i.updatedAt || ''; const n = /^\d{10,13}$/.test(value) ? Number(value) * (value.length === 10 ? 1000 : 1) : Date.parse(value.replace(' ', 'T')); return Number.isFinite(n) ? n : undefined; };
  return result.sort((a, b) => {
    if (sort.startsWith('title')) return direction * a.title.localeCompare(b.title, 'zh-CN', { numeric: true });
    const x = sort.startsWith('year') ? Number(catalogYear(a)) || undefined : updated(a), y = sort.startsWith('year') ? Number(catalogYear(b)) || undefined : updated(b);
    if (x === undefined) return y === undefined ? 0 : 1; if (y === undefined) return -1;
    return direction * (x - y);
  });
}
