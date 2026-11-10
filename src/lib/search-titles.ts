import { fetchUpstream, getCache, setCache } from './fetch-utils';
import { cmsRequestHeaders, filterRelevantResults, normalizeTitle } from './cms-parser';

interface EnglishQuery { base: string; year?: string; season?: number }
export interface SearchTitles { terms: string[]; year?: string }

/** Localized exact titles may have seasons or source/version annotations, but not unrelated words. */
export function filterSearchTitles<T extends { name?: string; alternateNames?: string[] }>(items: T[], terms: string[]): T[] {
  const original = new Set(filterRelevantResults(items, terms[0] || ''));
  const undecorated = (title: string) => normalizeTitle(title.trim()
    .replace(/^《(.+)》$/u, '$1')
    .replace(/\s*第[\d一二三四五六七八九十百两]+季.*$/u, '')
    .replace(/\s*[（(【\[].*$/u, '')
    .replace(/\s*(?:国语|粤语|普通话|原声|中字|高清|超清|[HB]D|4K|1080P)(?:版|中字)?$/iu, ''));
  return items.filter((item) => original.has(item) || terms.slice(1).some((alias) =>
    filterRelevantResults([item], alias).length > 0 && undecorated(item.name || '') === undecorated(alias)
  ));
}

export function parseEnglishQuery(wd: string): EnglishQuery | undefined {
  if (!/[a-z]/i.test(wd) || /\p{Script=Han}/u.test(wd)) return undefined;
  let base = wd.trim();
  const year = /(?:\s+\(?|\s*\()((?:18|19|20)\d{2})\)?$/.exec(base);
  if (year) base = base.slice(0, year.index).trim();
  const season = /\s+(?:season\s*|s)(\d{1,2})$/i.exec(base);
  if (season) base = base.slice(0, season.index).trim();
  if (normalizeTitle(base).length < 2) return undefined;
  return { base, year: year?.[1], season: season ? Number(season[1]) : undefined };
}

function chineseTitle(value: unknown, query: EnglishQuery): string | undefined {
  if (typeof value !== 'string' || value.length > 100 || !/\p{Script=Han}/u.test(value)) return undefined;
  const base = value.trim().replace(/\s*第[\d一二三四五六七八九十百两]+季.*$/u, '').trim();
  if (!base) return undefined;
  return query.season ? `${base} 第${query.season}季` : base;
}

function matchesEnglish(value: unknown, base: string): boolean {
  if (typeof value !== 'string') return false;
  const candidate = normalizeTitle(value), wanted = normalizeTitle(base);
  return candidate === wanted || (wanted.length >= 4 && candidate.startsWith(wanted));
}

export function aliasesFromDouban(data: unknown, query: EnglishQuery): string[] {
  if (!Array.isArray(data)) return [];
  return [...new Set(data.slice(0, 8).flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const item = row as Record<string, unknown>;
    if (item.type !== 'movie' && item.type !== 'tv') return [];
    if (!matchesEnglish(item.sub_title, query.base)) return [];
    if (query.year && !query.season && item.year && String(item.year) !== query.year) return [];
    const title = chineseTitle(item.title, query);
    return title ? [title] : [];
  }))].slice(0, 2);
}

export function aliasesFromWikidata(data: unknown, query: EnglishQuery): string[] {
  const rows = (data as { search?: unknown[] } | null)?.search;
  if (!Array.isArray(rows)) return [];
  return [...new Set(rows.slice(0, 10).flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const item = row as { label?: string; description?: string; match?: { text?: string }; display?: { label?: { value?: string }; description?: { value?: string } } };
    const description = item.display?.description?.value || item.description || '';
    // A matching word alone can identify a property, person or software project; accept media entities only.
    if (!/film|movie|television|tv series|电影|電影|电视剧|電視劇|影集|动画|紀錄片|纪录片/iu.test(description)) return [];
    if (!matchesEnglish(item.match?.text, query.base)) return [];
    const title = chineseTitle(item.display?.label?.value || item.label, query);
    return title ? [title] : [];
  }))].slice(0, 2);
}

/** English title metadata is resolved once per search, not once per VOD source. */
export async function resolveSearchTitles(wd: string): Promise<SearchTitles> {
  const query = parseEnglishQuery(wd);
  if (!query) return { terms: [wd] };
  const nativeTerm = query.season ? wd : query.base;
  const cacheKey = `title-alias:${normalizeTitle(wd)}`;
  const cached = getCache<string[]>(cacheKey);
  if (cached) return { terms: [nativeTerm, ...cached], year: query.year };
  let aliases: string[] = [];
  const options = { timeoutMs: 4000, retries: 0, headers: {
    ...cmsRequestHeaders(), Accept: 'application/json',
    Referer: 'https://movie.douban.com/',
  } };
  try {
    const response = await fetchUpstream(`https://movie.douban.com/j/subject_suggest?q=${encodeURIComponent(query.base.toLowerCase())}`, options);
    if (response.ok) {
      aliases = aliasesFromDouban(await response.json(), query);
      // Suggestions can be temporarily empty, and original capitalization can differ in cache.
      if (!aliases.length && query.base !== query.base.toLowerCase()) {
        const retry = await fetchUpstream(`https://movie.douban.com/j/subject_suggest?q=${encodeURIComponent(query.base)}`, options);
        if (retry.ok) aliases = aliasesFromDouban(await retry.json(), query);
      }
    }
  } catch { /* Original-title search remains usable if metadata is unavailable. */ }
  if (!aliases.length) {
    try {
      const params = new URLSearchParams({ action: 'wbsearchentities', search: query.base, language: 'en', uselang: 'zh-hans', type: 'item', limit: '10', format: 'json' });
      const response = await fetchUpstream(`https://www.wikidata.org/w/api.php?${params}`, {
        ...options, timeoutMs: 2000, headers: { 'User-Agent': 'LibreTV (+https://github.com/LibreSpark/LibreTV)', Accept: 'application/json' },
      });
      if (response.ok) aliases = aliasesFromWikidata(await response.json(), query);
    } catch { /* No guessed translation or unrelated fallback catalogue. */ }
  }
  setCache(cacheKey, aliases, aliases.length ? 24 * 60 * 60 * 1000 : 60 * 1000);
  return { terms: [nativeTerm, ...aliases], year: query.year };
}
