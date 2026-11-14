import { describe, expect, it } from 'vitest';
import { appendCatalog, catalogFacets, catalogParameters, catalogQuery, catalogUrl, loadCatalog, matchesCatalog, parseCatalog, selectCatalogItems } from './catalog-core';
const item = (id: number, type = 1) => ({ vod_id: id, vod_name: 'Film ' + id, type_id: type, vod_pic: 'https://images.example/' + id + '.jpg' });
const metadata = { class: [{ type_id: 1, type_name: 'Movies' }, { type_id: 2, type_name: 'Hidden' }, { type_id: 3, type_pid: 2, type_name: 'Child' }] };
const block = (s: string) => s === 'Hidden';
const page = (ids: number[], n = 1, pagecount = 4) => parseCatalog({ list: ids.map(id => item(id)), page: n, pagecount }, metadata, n, '', block);
describe('source catalog protocol and filtering', () => {
  it('rejects invalid page/category inputs before issuing a request', () => {
    for (const p of [0, -1, 1.5, 'abc', 100001]) expect(() => catalogParameters(p, '')).toThrow();
    for (const c of ['1&ids=9', '-1', 'xyz']) expect(() => catalogParameters(1, c)).toThrow();
    expect(catalogParameters(2, '10')).toEqual({ page: 2, category: '10' });
  });
  it('preserves configured parameters while removing inherited search/detail filters', () => {
    const url = new URL(catalogUrl('https://example.com/api?token=public&wd=old&ids=5&t=4', 2, '8'));
    expect(url.searchParams.get('token')).toBe('public'); expect(url.searchParams.has('wd')).toBe(false); expect(url.searchParams.has('ids')).toBe(false);
    expect(url.searchParams.get('t')).toBe('8'); expect(url.searchParams.get('pg')).toBe('2'); expect(() => catalogUrl('https://user:password@example.com', 1, '')).toThrow();
  });
  it('hides blocked categories, their children and matching videos', () => {
    const data = parseCatalog({ list: [item(1), item(2, 2), item(3, 3)] }, metadata, 1, '', block);
    expect(data.categories).toEqual([{ id: '1', name: 'Movies' }]); expect(data.items.map(i => i.id)).toEqual(['1']); expect(() => parseCatalog({ list: [] }, metadata, 1, '3', block)).toThrow();
  });
  it('rejects malformed responses and unsafe or incomplete cards', () => {
    expect(() => parseCatalog({ list: 'bad' }, {}, 1, '', block)).toThrow();
    const data = parseCatalog({ list: [item(1), item(1), { vod_id: 'bad/id', vod_name: 'Bad' }, { vod_id: 8 }, { ...item(2), vod_pic: 'javascript:alert(1)' }] }, {}, 1, '', block);
    expect(data.items.map(i => i.id)).toEqual(['1', '2']); expect(data.items[1].poster).toBe('');
  });
  it('stops empty/last pages and wrong reported pages; tolerates absent totals', () => {
    expect(page([], 2).nextPage).toBeNull(); expect(page([1], 4).nextPage).toBeNull();
    expect(parseCatalog({ list: [item(1)], page: 1 }, {}, 2, '', block).nextPage).toBeNull(); expect(parseCatalog({ list: [item(1)] }, {}, 1, '', block).nextPage).toBe(2);
  });
  it('preserves metadata/order, merges overlap and stops fully repeated pages', () => {
    const first = page([1, 2]), second = page([2, 3], 2); second.items[0].title = 'Changed';
    const merged = appendCatalog(first.items, second); expect(merged.items.map(i => i.id)).toEqual(['1', '2', '3']); expect(merged.items[1].title).toBe('Film 2'); expect(merged.nextPage).toBe(3); expect(appendCatalog(first.items, page([2, 1], 2)).nextPage).toBeNull();
  });
  it('does not falsely stop when all records on a page are filtered', () => {
    const filtered = parseCatalog({ list: [item(1, 2)], pagecount: 3 }, metadata, 1, '', block); expect(filtered.items).toEqual([]); expect(filtered.rawCount).toBe(1); expect(appendCatalog([], filtered).nextPage).toBe(2);
  });
  it('keeps lists when metadata fails, with separately cached pages', async () => {
    let calls = 0; const base = 'https://cache-fixture.example/api';
    const fetcher = async (url: string) => { calls++; if (new URL(url).searchParams.get('ac') === 'list') throw new Error('metadata outage'); return { list: [item(Number(new URL(url).searchParams.get('pg')))], pagecount: 3 }; };
    expect((await loadCatalog(base, 1, '', block, fetcher)).categoryWarning).toBeTruthy(); await loadCatalog(base, 1, '', block, fetcher); expect(calls).toBe(3);
    expect((await loadCatalog(base, 2, '', block, fetcher)).items[0].id).toBe('2'); expect(calls).toBe(5);
  });
});

// Loaded-item views must never mutate the source order used for pagination.
const filters = { year: '', language: '', region: '' };
const records = [
  { id: 'a', title: 'Zebra', poster: '', year: '2024', remarks: '', languages: ['English'], regions: ['US'], updatedAt: '2026-01-01 00:00:00' },
  { id: 'b', title: 'Alpha', poster: '', year: '2026', remarks: '', languages: ['中文', 'English'], regions: ['中国'], updatedAt: '2026-02-01 00:00:00' },
  { id: 'c', title: 'Beta', poster: '', year: '', remarks: '' },
];
it('sorts only loaded records without changing pagination order, with missing metadata last', () => {
  expect(selectCatalogItems(records, filters, 'title-asc').map(i => i.id)).toEqual(['b', 'c', 'a']);
  expect(selectCatalogItems(records, filters, 'year-desc').map(i => i.id)).toEqual(['b', 'a', 'c']);
  expect(selectCatalogItems(records, filters, 'year-asc').map(i => i.id)).toEqual(['a', 'b', 'c']);
  expect(selectCatalogItems(records, filters, 'updated-desc').map(i => i.id)).toEqual(['b', 'a', 'c']);
  expect(records.map(i => i.id)).toEqual(['a', 'b', 'c']);
});
it('combines exact loaded year/language/region filters and derives options from real metadata', () => {
  expect(selectCatalogItems(records, { year: '2026', language: 'English', region: '中国' }, 'source').map(i => i.id)).toEqual(['b']);
  expect(matchesCatalog(records[2], { ...filters, language: 'English' })).toBe(false);
  expect(catalogFacets(records)).toEqual({ years: ['2026', '2024'], languages: ['中文', 'English'], regions: ['中国', 'US'] });
});
it('encodes title searches safely and excludes keywords from the category request', () => {
  expect(catalogQuery(' hello ')).toBe('hello'); expect(() => catalogQuery('x'.repeat(101))).toThrow();
  expect(new URL(catalogUrl('https://example.com/api', 2, '1', false, 'A&B')).searchParams.get('wd')).toBe('A&B');
  expect(new URL(catalogUrl('https://example.com/api', 1, '', true, 'A&B')).searchParams.has('wd')).toBe(false);
});
it('normalizes multi-valued language and region metadata without inventing missing values', () => {
  const parsed = parseCatalog({ list: [{ ...item(1), vod_lang: '中文 / English', vod_area: '中国, US' }] }, {}, 1, '', block);
  expect(parsed.items[0].languages).toEqual(['中文', 'English']); expect(parsed.items[0].regions).toEqual(['中国', 'US']);
});
