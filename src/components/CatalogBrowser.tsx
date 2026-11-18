'use client';

import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { appendCatalog, catalogFacets, CatalogFilters, CatalogItem, CatalogPage, CatalogSort, matchesCatalog, selectCatalogItems } from '@/lib/catalog-core';

interface Props {
  sources: { id: string; name: string }[];
  fetchPage: (source: string, category: string, page: number, signal: AbortSignal, query: string) => Promise<CatalogPage>;
  renderCard: (item: CatalogItem, source: string) => ReactNode;
  initialSource?: string; initialCategory?: string; initialQuery?: string;
}
interface State { key: string; data?: CatalogPage; items: CatalogItem[]; next: number | null; loading: boolean; error: string; emptyPages: number; }
const empty: State = { key: '', items: [], next: 1, loading: false, error: '', emptyPages: 0 };

export default function CatalogBrowser({ sources, fetchPage, renderCard, initialSource = '', initialCategory = '', initialQuery = '' }: Props) {
  const [chosen, setChosen] = useState(initialSource), [category, setCategory] = useState(initialCategory);
  const [query, setQuery] = useState(initialQuery), [draft, setDraft] = useState(initialQuery);
  const [filters, setFilters] = useState<CatalogFilters>({ year: '', language: '', region: '' });
  const [sort, setSort] = useState<CatalogSort>('source');
  const filterRef = useRef(filters); filterRef.current = filters;
  const source = sources.some(s => s.id === chosen) ? chosen : sources[0]?.id || '';
  const key = JSON.stringify([source, category, query]);
  const [state, setState] = useState<State>(empty);
  const request = useRef<{ controller: AbortController } | null>(null);
  const more = useRef<HTMLDivElement>(null);
  const visible = state.key === key ? state : empty;
  const facets = useMemo(() => catalogFacets(visible.items), [visible.items]);
  const displayed = useMemo(() => selectCatalogItems(visible.items, filters, sort), [visible.items, filters, sort]);
  const hasFilters = Boolean(filters.year || filters.language || filters.region);
  useEffect(() => { setFilters({ year: '', language: '', region: '' }); }, [key]);
  useEffect(() => { setState(s => ({ ...s, emptyPages: 0 })); }, [filters]);

  const load = useCallback(async (page: number, reset = false) => {
    if (!source || (!reset && request.current)) return;
    if (reset) request.current?.controller.abort();
    const current = { controller: new AbortController() }; request.current = current;
    setState(s => ({ ...(reset || s.key !== key ? empty : s), key, loading: true, error: '' }));
    try {
      const data = await fetchPage(source, category, page, current.controller.signal, query);
      if (request.current !== current || current.controller.signal.aborted) return;
      setState(s => {
        const before = reset || s.key !== key ? [] : s.items;
        const merged = appendCatalog(before, data);
        return { key, data, ...merged, next: merged.nextPage, loading: false, error: '', emptyPages: !data.items.some(i => matchesCatalog(i, filterRef.current)) && data.nextPage ? (reset || s.key !== key ? 0 : s.emptyPages) + 1 : 0 };
      });
    } catch (e) {
      if (request.current !== current || current.controller.signal.aborted) return;
      setState(s => ({ ...s, loading: false, error: e instanceof Error ? e.message : '目录加载失败' }));
    } finally { if (request.current === current) request.current = null; }
  }, [source, category, query, key, fetchPage]);

  useEffect(() => {
    void load(1, true);
    if (source) {
      const url = new URL(window.location.href); url.searchParams.set('source', source);
      if (category) url.searchParams.set('category', category); else url.searchParams.delete('category');
      if (query) url.searchParams.set('query', query); else url.searchParams.delete('query');
      window.history.replaceState(window.history.state, '', url);
    }
    return () => { request.current?.controller.abort(); request.current = null; };
  }, [load, source, category, query]);

  useEffect(() => {
    const target = more.current;
    if (!target || !visible.data || visible.loading || visible.error || !visible.next || visible.emptyPages >= 3 || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) void load(visible.next as number);
    }, { rootMargin: '600px 0px' });
    observer.observe(target); return () => observer.disconnect();
  }, [visible.data, visible.loading, visible.error, visible.next, visible.emptyPages, load]);

  const control = 'w-full rounded-lg border border-gray-400 px-3 py-2 bg-white text-gray-900 dark:bg-gray-800 dark:text-gray-100';
  const button = 'rounded-lg border border-gray-400 px-4 py-2 hover:bg-gray-500/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-500';
  return <section aria-label="点播源目录" className="w-full min-w-0">
    <h1 className="text-2xl font-bold mb-2">浏览源</h1>
    <p className="text-sm opacity-75 mb-5">选择点播源，按分类浏览内容</p>
    {sources.length === 0 ? <p role="status">暂无可用点播源，请在设置中启用点播源。</p> : <>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5">
        <label className="block text-sm">点播源<select aria-label="点播源" className={control + ' mt-1'} value={source} onChange={e => { setChosen(e.target.value); setCategory(''); setQuery(''); setDraft(''); }}>
          {sources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select></label>
        <label className="block text-sm">分类<select aria-label="分类" className={control + ' mt-1'} value={category} onChange={e => setCategory(e.target.value)} disabled={!visible.data || !visible.data.categories.length}>
          <option value="">全部分类</option>{visible.data?.categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select></label>
      </div>
      <form className="flex gap-2 mb-4" onSubmit={e => { e.preventDefault(); setQuery(draft.trim().slice(0, 100)); }}>
        <input aria-label="搜索此源片名" placeholder="搜索此源片名" maxLength={100} className={control + ' min-w-0 flex-1'} value={draft} onChange={e => setDraft(e.target.value)} />
        <button className={button + ' shrink-0'} type="submit">搜索目录</button>
        {query && <button className={button + ' shrink-0'} type="button" onClick={() => { setQuery(''); setDraft(''); }}>清除</button>}
      </form>
      <p className="text-xs opacity-75 mb-3">片名搜索查询源站目录；以下筛选和排序作用于已加载内容。</p>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        {([['year', '年份', facets.years], ['language', '语言', facets.languages], ['region', '地区', facets.regions]] as const).map(([field, label, options]) => <label key={field} className="block text-sm">{label}（已加载）<select aria-label={label + '（已加载）'} className={control + ' mt-1'} value={filters[field]} disabled={!options.length} onChange={e => setFilters(f => ({ ...f, [field]: e.target.value }))}>
          <option value="">全部</option>{options.map(value => <option key={value} value={value}>{value}</option>)}
        </select></label>)}
        <label className="block text-sm">排序（已加载）<select aria-label="排序（已加载）" className={control + ' mt-1'} value={sort} onChange={e => setSort(e.target.value as CatalogSort)}>
          <option value="source">源站顺序</option><option value="title-asc">片名 A–Z</option><option value="title-desc">片名 Z–A</option><option value="year-desc">年份从新到旧</option><option value="year-asc">年份从旧到新</option><option value="updated-desc">更新从新到旧</option><option value="updated-asc">更新从旧到新</option>
        </select></label>
      </div>
      {visible.data?.categoryWarning && <p role="status" className="text-sm opacity-75 mb-3">{visible.data.categoryWarning}</p>}
      <p className="text-sm opacity-75 mb-3" data-catalog-count>已加载 {visible.items.length} 部{hasFilters && ` · 筛选后 ${displayed.length} 部`}</p>
      <div data-catalog-grid className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-3">
        {displayed.map(item => <div key={item.id} data-catalog-id={item.id} className="min-w-0">{renderCard(item, source)}</div>)}
      </div>
      <div ref={more} data-catalog-more className="py-7 text-center text-sm">
        {visible.loading ? <p role="status">正在加载目录...</p> : visible.error ? <div role="status"><p className="mb-3">{visible.error}</p><button className={button} onClick={() => void load(visible.next || 1, !visible.data)}>重试加载</button>{category && <button className={button + ' ml-2'} onClick={() => setCategory('')}>返回全部分类</button>}</div> : !visible.data ? <p role="status">正在准备目录...</p> : visible.next ? <>
          {visible.emptyPages >= 3 && <p className="mb-3">当前页暂无可显示内容，可继续查看下一页。</p>}
          <button className={button} onClick={() => void load(visible.next as number)}>加载更多</button>
        </> : <p role="status">{visible.items.length ? (hasFilters ? `已加载 ${visible.items.length} 部，筛选后 ${displayed.length} 部` : `已显示全部 ${visible.items.length} 部`) : '该分类暂无内容'}</p>}
      </div>
    </>}
  </section>;
}
