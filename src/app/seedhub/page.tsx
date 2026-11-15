'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { V4HomepageHeader } from '@/components/home/V4HomepageHeader';
import { SmartImage } from '@/components/smart-image';
import { collectorFetch } from '@/lib/collector-browser-config';
import { useAppStore } from '@/lib/store';

type SeedHubDetail = {
  source_name?: string;
  source_url?: string;
  title?: string;
  category?: string;
  description?: string;
  metadata?: Record<string, string>;
  poster_url?: string | null;
  still_urls?: string[];
  mode?: string;
  external_resource_links_extracted?: boolean;
};

function SeedHubDetailContent() {
  const params = useSearchParams();
  const router = useRouter();
  const sourceUrl = params.get('url') ?? '';
  const sourceCategory = params.get('category');
  const [detail, setDetail] = useState<SeedHubDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);

  useEffect(() => {
    let active = true;
    if (!sourceUrl) {
      setError('缺少 SeedHub 影片地址。');
      setLoading(false);
      return () => { active = false; };
    }
    setLoading(true);
    setError('');
    const categoryQuery = sourceCategory ? '&category=' + encodeURIComponent(sourceCategory) : '';
    collectorFetch('/api/resource-collector?action=seedhub-detail&url=' + encodeURIComponent(sourceUrl) + categoryQuery)
      .then(async (response) => {
        const payload = await response.json() as SeedHubDetail & { error?: string };
        if (!response.ok) throw new Error(payload.error || 'SeedHub 详情读取失败。');
        if (active) setDetail(payload);
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : 'SeedHub 详情读取失败。');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [sourceUrl, sourceCategory]);

  const category = detail?.category === 'series' ? '电视剧' : detail?.category === 'anime' ? '动漫' : '电影';
  const metadataLabels: Record<string, string> = {
    director: '导演', writers: '编剧', cast: '主演', genres: '类型',
    countries: '制片国家/地区', languages: '语言', premiere: '首播',
    episode_count: '集数', runtime: '单集片长', aliases: '又名',
  };

  return (
    <div className="v4-spatial-screen min-h-screen">
      <V4HomepageHeader />
      <main className="mx-auto w-full max-w-6xl px-4 pb-28 pt-6 sm:px-6">
        <button type="button" onClick={() => router.back()} className="mb-5 inline-flex items-center gap-2 text-sm text-muted hover:text-content">‹ 返回目录</button>
        {loading ? (
          <div className="grid gap-6 md:grid-cols-[280px_1fr]" aria-busy="true">
            <div className="aspect-[2/3] animate-pulse rounded-2xl bg-chip" />
            <div className="space-y-4"><div className="h-8 w-2/3 animate-pulse rounded bg-chip" /><div className="h-24 animate-pulse rounded bg-chip" /></div>
          </div>
        ) : error ? (
          <section className="v4-spatial-panel" role="alert"><h1 className="text-lg font-semibold">无法读取 SeedHub 详情</h1><p className="mt-3 text-sm text-muted">{error}</p><button type="button" className="v4-spatial-primary mt-5" onClick={() => router.refresh()}>重新加载</button></section>
        ) : detail ? (
          <>
            <section className="grid gap-6 md:grid-cols-[minmax(200px,280px)_1fr] md:gap-9">
              <div className="relative aspect-[2/3] overflow-hidden rounded-2xl bg-chip shadow-xl">
                {detail.poster_url ? <SmartImage url={detail.poster_url} mode={imageProxyMode} customProxy={customImageProxy} alt={detail.title || 'SeedHub 海报'} className="absolute inset-0 h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-sm text-faint">暂无真实海报</div>}
              </div>
              <div className="flex min-w-0 flex-col justify-end">
                <span className="text-xs font-medium tracking-[0.18em] text-accent">SEEDHUB / {category}</span>
                <h1 className="mt-3 text-3xl font-bold leading-tight text-content sm:text-4xl">{detail.title || '未命名影片'}</h1>
                <p className="mt-3 text-xs text-faint">来自 SeedHub 的真实采集资料 · 元数据模式</p>
                {detail.metadata && Object.keys(detail.metadata).length ? (
                  <dl className="mt-6 grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
                    {Object.entries(detail.metadata).map(([key, value]) => <div key={key} className="border-b border-subtle pb-3"><dt className="text-xs text-faint">{metadataLabels[key] || key}</dt><dd className="mt-1 text-sm leading-6 text-content">{value}</dd></div>)}
                  </dl>
                ) : <p className="mt-6 text-sm text-muted">暂未采集到更多影片资料。</p>}
              </div>
            </section>
            {detail.description ? <section className="v4-spatial-panel mt-8"><h2 className="text-lg font-semibold text-content">剧情简介</h2><p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-muted">{detail.description}</p></section> : null}
            {detail.still_urls?.length ? <section className="mt-8"><div className="v4-spatial-panel-head mb-4"><h2>影片剧照</h2><span>{detail.still_urls.length} 张真实图片</span></div><div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">{detail.still_urls.map((url) => <SmartImage key={url} url={url} mode={imageProxyMode} customProxy={customImageProxy} alt={(detail.title || '影片') + ' 剧照'} className="aspect-video w-full rounded-xl object-cover" />)}</div></section> : null}
            <section className="v4-spatial-panel mt-8"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold text-content">资源状态</h2><p className="mt-1 text-xs text-muted">当前仅完成资料采集，尚未验证可播放媒体流。</p></div><span className="rounded-full bg-amber-500/10 px-3 py-1.5 text-xs text-amber-600">未验证播放</span></div><a className="mt-4 inline-flex text-sm text-accent underline" href={detail.source_url || sourceUrl} target="_blank" rel="noopener noreferrer">访问 SeedHub 原始详情页</a></section>
          </>
        ) : null}
      </main>
    </div>
  );
}

export default function SeedHubDetailPage() {
  return <Suspense fallback={<main className="min-h-screen bg-surface" />}><SeedHubDetailContent /></Suspense>;
}
