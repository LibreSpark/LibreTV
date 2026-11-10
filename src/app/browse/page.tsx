'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useMemo } from 'react';
import CatalogBrowser from '@/components/CatalogBrowser';
import { Header } from '@/components/header';
import { SiteFooter } from '@/components/site-footer';
import { SmartImage } from '@/components/smart-image';
import { useAuth } from '@/components/auth';
import { isInDisabledSubscription, resolveSource, useAppStore } from '@/lib/store';
import type { CatalogPage } from '@/lib/catalog-core';

function BrowseContent() {
  const params = useSearchParams();
  const { verified, openLogin } = useAuth();
  const selectedKeys = useAppStore(s => s.selectedKeys);
  const customAPIs = useAppStore(s => s.customAPIs), envSources = useAppStore(s => s.envSources);
  const subscriptions = useAppStore(s => s.subscriptions), filterAdult = useAppStore(s => s.yellowFilter);
  const imageMode = useAppStore(s => s.imageProxyMode), customProxy = useAppStore(s => s.customImageProxy);
  const sources = useMemo(() => {
    const seen = new Set<string>();
    return selectedKeys.map(key => resolveSource({ customAPIs, envSources }, key)).filter((s): s is NonNullable<typeof s> => {
      if (!s || seen.has(s.key) || (filterAdult && s.isAdult) || isInDisabledSubscription({ subscriptions }, s.key)) return false;
      seen.add(s.key); return true;
    });
  }, [selectedKeys, customAPIs, envSources, subscriptions, filterAdult]);
  const choices = useMemo(() => sources.map(s => ({ id: s.key, name: s.name })), [sources]);
  const fetchPage = useCallback(async (key: string, category: string, page: number, signal: AbortSignal, query: string): Promise<CatalogPage> => {
    const source = sources.find(s => s.key === key); if (!source) throw new Error('点播源不可用');
    const res = await fetch('/api/catalog', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source, category, page, filterAdult, query }), signal });
    const data = await res.json(); if (!res.ok) throw new Error(data.error || '目录加载失败'); return data;
  }, [sources, filterAdult]);
  return <><Header showSearch /><main className="max-w-6xl mx-auto px-4 py-8">
    {!verified ? <button className="btn-primary" onClick={openLogin}>登录后浏览点播源</button> : <CatalogBrowser sources={choices} fetchPage={fetchPage} initialSource={params.get('source') || ''} initialCategory={params.get('category') || ''} initialQuery={params.get('query') || ''} renderCard={(item, key) => {
      const source = sources.find(s => s.key === key)!;
      const href = '/watch?' + new URLSearchParams({ source: key, sourceUrl: source.url, id: item.id, title: item.title });
      return <Link href={href} data-catalog-play className="card block overflow-hidden hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
        <div className="aspect-[2/3] bg-chip"><SmartImage url={item.poster} mode={imageMode} customProxy={customProxy} alt={item.title} className="w-full h-full object-cover" /></div>
        <div className="p-2"><p className="text-xs font-medium truncate" title={item.title}>{item.title}</p><p className="text-xs text-muted truncate">{[item.year, item.remarks].filter(Boolean).join(' · ')}</p></div>
      </Link>;
    }} />}
  </main><SiteFooter /></>;
}
export default function BrowsePage() { return <Suspense><BrowseContent /></Suspense>; }
