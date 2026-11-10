import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./fetch-utils', () => ({ fetchUpstream: vi.fn(), getCache: vi.fn(), setCache: vi.fn() }));
import { fetchUpstream, getCache, setCache } from './fetch-utils';
import { aliasesFromDouban, aliasesFromWikidata, filterSearchTitles, parseEnglishQuery, resolveSearchTitles } from './search-titles';

beforeEach(() => vi.resetAllMocks());
const inception = [{ type: 'movie', title: '盗梦空间', sub_title: 'Inception', year: '2010' }];

describe('cross-language title metadata', () => {
  it('keeps year and season intent separate from the metadata title', () => {
    expect(parseEnglishQuery('Dune (2021)')).toEqual({ base: 'Dune', year: '2021', season: undefined });
    expect(parseEnglishQuery('Breaking Bad Season 2')).toEqual({ base: 'Breaking Bad', year: undefined, season: 2 });
    expect(parseEnglishQuery('盗梦空间')).toBeUndefined();
  });

  it('expands English input to its verified Chinese title without a metadata call for Chinese searches', async () => {
    vi.mocked(fetchUpstream).mockResolvedValue(Response.json(inception));
    expect(await resolveSearchTitles('Inception')).toEqual({ terms: ['Inception', '盗梦空间'], year: undefined });
    expect(fetchUpstream).toHaveBeenCalledTimes(1);
    expect(setCache).toHaveBeenCalledWith('title-alias:inception', ['盗梦空间'], 86400000);
    expect(await resolveSearchTitles('盗梦空间')).toEqual({ terms: ['盗梦空间'] });
    expect(fetchUpstream).toHaveBeenCalledTimes(1);
  });

  it('does not restrict a series title to the first season returned by suggestions', () => {
    const data = [{ type: 'movie', sub_title: 'Breaking Bad', title: '绝命毒师 第一季', episode: '7' }];
    expect(aliasesFromDouban(data, { base: 'Breaking Bad' })).toEqual(['绝命毒师']);
    expect(aliasesFromDouban(data, { base: 'Breaking Bad', season: 2 })).toEqual(['绝命毒师 第2季']);
  });

  it('rejects unrelated suggestions, non-media items, oversized text and a conflicting movie year', () => {
    expect(aliasesFromDouban([{ type: 'book', sub_title: 'Inception', title: '书' },
      { type: 'movie', sub_title: 'Titanic', title: '泰坦尼克号' },
      { type: 'movie', sub_title: 'Inception', title: '片'.repeat(101) }], { base: 'Inception' })).toEqual([]);
    expect(aliasesFromDouban(inception, { base: 'Inception', year: '2000' })).toEqual([]);
  });

  it('uses cached aliases while retaining the current original query', async () => {
    vi.mocked(getCache).mockReturnValue(['盗梦空间']);
    expect((await resolveSearchTitles('INCEPTION')).terms).toEqual(['INCEPTION', '盗梦空间']);
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it('retries an empty suggestion response with original capitalization and preserves the requested year', async () => {
    vi.mocked(fetchUpstream).mockResolvedValueOnce(Response.json([])).mockResolvedValueOnce(Response.json([
      { type: 'movie', title: '沙丘', sub_title: 'Dune', year: '2021' },
      { type: 'movie', title: '沙丘2', sub_title: 'Dune: Part Two', year: '2024' },
    ]));
    expect(await resolveSearchTitles('Dune 2021')).toEqual({ terms: ['Dune', '沙丘'], year: '2021' });
    expect(fetchUpstream).toHaveBeenCalledTimes(2);
  });

  it('uses media-only Wikidata results when the first provider is unavailable', async () => {
    vi.mocked(fetchUpstream).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(Response.json({ search: [
      { label: '建立日期', description: 'Wikidata property', match: { text: 'Inception' } },
      { label: '盗梦空间', description: '2010年科幻电影', match: { text: 'Inception' } },
    ] }));
    expect((await resolveSearchTitles('Inception')).terms).toEqual(['Inception', '盗梦空间']);
    expect(fetchUpstream).toHaveBeenCalledTimes(2);
  });

  it('preserves original search on provider failure and never accepts a non-media word match', async () => {
    vi.mocked(fetchUpstream).mockRejectedValue(new Error('offline'));
    expect((await resolveSearchTitles('Unlisted Example')).terms).toEqual(['Unlisted Example']);
    expect(aliasesFromWikidata({ search: [{ label: '建立日期', description: 'property', match: { text: 'Inception' } }] }, { base: 'Inception' })).toEqual([]);
    expect(setCache).toHaveBeenLastCalledWith('title-alias:unlistedexample', [], 60000);
  });

  it('does not turn short translated titles into broad unrelated catalogue matches', () => {
    expect(filterSearchTitles([{ name: '她' }, { name: '她（原声版）' }, { name: '她的故事' }, { name: '我和她' }], ['Her', '她']).map(x=>x.name)).toEqual(['她', '她（原声版）']);
    const seasons = [{ name: '绝命毒师 第一季' }, { name: '绝命毒师第二季' }, { name: '绝命毒师 第三季' }];
    expect(filterSearchTitles(seasons, ['Breaking Bad Season 2', '绝命毒师 第2季'])).toEqual([seasons[1]]);
    expect(filterSearchTitles([{ name: '办公室' }, { name: '办公室第八季' }, { name: '办公室的故事' }], ['The Office', '办公室']).map(x=>x.name)).toEqual(['办公室', '办公室第八季']);
  });
});
