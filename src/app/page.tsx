'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';

import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';

import { V4HomepageHeader } from '@/components/home/V4HomepageHeader';
import { V4HomepageHero } from '@/components/home/V4HomepageHero';
import { V4HomepageContent } from '@/components/home/V4HomepageContent';
import { useFridayDetailBridge } from '@/components/friday/useFridayDetailBridge';
import { useHomeSearchController } from '@/components/home/useHomeSearchController';
import { RegistryInlinePlayer } from '@/components/home/RegistryInlinePlayer';
import { SmartImage } from '@/components/smart-image';
import { AggregatedCard, aggregateResults } from '@/components/video-card';
import {
  useAppStore,
  resolveSource,
  isInDisabledSubscription,
  isSourceDisabled,
} from '@/lib/store';
import { api } from '@/lib/client-api';
import type {
  DoubanItem,
  SearchResultItem,
  SourceSearchOutcome,
  RegistrySearchResource,
  SeedHubSearchItem,
} from '@/lib/types';
import {
  formatDisableTtl,
  validateSourceUrl,
} from '@/lib/utils';
import { useToast } from '@/components/toast';
import { EmptyState } from '@/components/states';
import { rankSourcesByHealth } from '@/lib/source-ranking';
import { rankSourcesByPlaybackQuality } from '@/lib/playback-telemetry';

const RESULT_PAGE_SIZE = 60;

export default function HomePage() {
  return (
    <Suspense>
      <HomeContent />
    </Suspense>
  );
}

function HomeContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { toast } = useToast();

  const routeQuery = searchParams.get('q') ?? searchParams.get('s') ?? '';
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const selectedKeys = useAppStore((s) => s.selectedKeys);
  const yellowFilter = useAppStore((s) => s.yellowFilter);
  const sourceHealth = useAppStore((s) => s.sourceHealth);
  const playbackHealth = useAppStore((s) => s.playbackHealth);
  const subscriptions = useAppStore((s) => s.subscriptions);
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);

  const [detailItem, setDetailItem] =
    useState<SearchResultItem | null>(null);
  const [registryPlayItem, setRegistryPlayItem] =
    useState<RegistrySearchResource | null>(null);
  const [streamedOutcomes, setStreamedOutcomes] =
    useState<SourceSearchOutcome[]>([]);

  useFridayDetailBridge(setDetailItem, toast);

  const openDetail = (item: SearchResultItem, extra?: { rating?: string; poster?: string }) => {
    const params = new URLSearchParams({ source: item.sourceKey, id: item.vodId, title: item.name, sourceName: item.sourceName });
    if (item.pic || extra?.poster) params.set('pic', item.pic || extra?.poster || '');
    if (extra?.rating) params.set('rating', extra.rating);
    if (item.sourceUrl) params.set('sourceUrl', item.sourceUrl);
    router.push('/detail?' + params.toString());
  };
  
  const handleHomepagePick = async (movie: DoubanItem) => {
    if (selectedSources.length === 0) {
      toast('请先在设置中启用至少一个可用点播源。', 'warning');
      return;
    }
    try {
      const response = await api.search(movie.title, selectedSources, yellowFilter);
      const normalize = (value: string) => value.replace(/[\\s\\p{P}\\p{S}]/gu, '').toLocaleLowerCase();
      const target = normalize(movie.title);
      const match = response.list.find((entry) => normalize(entry.name) === target);
      if (!match) {
        toast('暂未在已启用的点播源中找到《' + movie.title + '》的准确资源。', 'warning');
        return;
      }
      openDetail(match, { rating: movie.rating, poster: movie.cover });
    } catch (error) {
      toast(error instanceof Error ? error.message : '获取影片详情失败，请稍后重试。', 'error');
    }
  };

  const openedFridayDetailRef = useRef<string | null>(null);
  useEffect(() => {
    if (!detailItem) {
      openedFridayDetailRef.current = null;
      return;
    }
    const key = detailItem.sourceKey + ':' + detailItem.vodId;
    if (openedFridayDetailRef.current === key) return;
    openedFridayDetailRef.current = key;
    openDetail(detailItem);
    setDetailItem(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailItem]);

  const sourceName = (key: string) =>
    customAPIs.find((a) => a.key === key)?.name ??
    envSources.find((a) => a.key === key)?.name ??
    key;

  const selectedSources = useMemo(() => {
    const seen = new Set<string>();
    const sources = selectedKeys
      .map((key) => resolveSource({ customAPIs, envSources }, key))
      .filter((s): s is NonNullable<typeof s> => {
        if (!s || !validateSourceUrl(s.url) || seen.has(s.key)) {
          return false;
        }
        seen.add(s.key);
        return true;
      })
      .filter((s) => !isSourceDisabled({ sourceHealth }, s.key))
      .filter((s) => !isInDisabledSubscription({ subscriptions }, s.key));
    const searchHealthy = rankSourcesByHealth(sources, sourceHealth);
    return rankSourcesByPlaybackQuality(searchHealthy, playbackHealth);
  }, [customAPIs, envSources, selectedKeys, sourceHealth, playbackHealth, subscriptions]);

  const { activeQuery: urlQuery } = useHomeSearchController(routeQuery, toast);


  const disabledSources = useMemo(
    () => selectedKeys.filter((key) => isSourceDisabled({ sourceHealth }, key)),
    [selectedKeys, sourceHealth]
  );

  const offSubscriptionSources = useMemo(
    () =>
      selectedKeys.filter(
        (key) =>
          !isSourceDisabled({ sourceHealth }, key) &&
          isInDisabledSubscription({ subscriptions }, key)
      ),
    [selectedKeys, sourceHealth, subscriptions]
  );

  const searchQuery = useQuery({
    queryKey: ['search', urlQuery, selectedKeys, yellowFilter],
    queryFn: ({ signal }) => {
      setStreamedOutcomes([]);
      return api.search(
        urlQuery.slice(0, 100),
        selectedSources,
        yellowFilter,
        {
          signal,
          onSource: (outcome) => {
            setStreamedOutcomes((prev) => [...prev, outcome]);
            for (const ev of useAppStore.getState().recordSourceHealth([outcome])) {
              toast(
                ev.permanent
                  ? `「${sourceName(ev.key)}」多次失败，已停止参与搜索，可在设置中恢复`
                  : `「${sourceName(ev.key)}」连续超时/失败，已停用 ${formatDisableTtl(ev.ttlMs ?? 0)}`,
                'warning'
              );
            }
          },
        }
      );
    },
    enabled: Boolean(urlQuery),
    staleTime: 300_000,
  });

  const isSearching = Boolean(urlQuery) && searchQuery.isFetching && !searchQuery.data;

  const streamedList = useMemo(
    () => streamedOutcomes.flatMap((o) => o.list),
    [streamedOutcomes]
  );

  const list = useMemo(
    () => searchQuery.data?.list ?? (isSearching ? streamedList : []),
    [searchQuery.data, isSearching, streamedList]
  );

  const registryResources = searchQuery.data?.registryResources ?? [];
  const seedhubItems: SeedHubSearchItem[] = searchQuery.data?.seedhubItems ?? [];

  const failures =
    searchQuery.data?.failures ??
    streamedOutcomes
      .filter((o) => !o.ok)
      .map((o) => ({
        sourceKey: o.sourceKey,
        error: o.error || '请求失败',
        timedOut: o.timedOut,
      }));

  const groups = useMemo(() => aggregateResults(list), [list]);

  const [visibleCount, setVisibleCount] = useState(RESULT_PAGE_SIZE);

  const visibleGroups = useMemo(
    () => groups.slice(0, visibleCount),
    [groups, visibleCount]
  );

  useEffect(() => {
    setVisibleCount(RESULT_PAGE_SIZE);
  }, [groups]);

  return (
    <div className="v4-home min-h-screen flex flex-col">
      <V4HomepageHeader overlay={!urlQuery} />
      <main className={urlQuery ? "v4-home-main" : "v4-home-main v4-home-main--cinema"}>
        {!urlQuery && <><V4HomepageHero onPick={handleHomepagePick} /><V4HomepageContent onPick={handleHomepagePick} /></>}
        {urlQuery && (
          <section aria-label="搜索结果" className="mb-10">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm text-muted">
                “<span className="text-content">{urlQuery}</span>” 的搜索结果
                {isSearching ? (
                  <span className="text-faint">
                    （已就绪 {streamedOutcomes.length}/{selectedSources.length} 个源…）
                  </span>
                ) : (
                  searchQuery.data && (
                    <span className="text-faint">
                      （{groups.length} 部影片 · {list.length} 条结果
                      {failures.length > 0 && `，${failures.length} 个源失败`}）
                    </span>
                  )
                )}
              </h2>
            </div>
            {seedhubItems.length > 0 && (
              <div className="mb-5" aria-label="SeedHub 已采集目录">
                <div className="mb-2 flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-content">已采集影片资料 · SeedHub</h3>
                  <span className="rounded-full bg-sky-500/10 px-2 py-0.5 text-[11px] text-sky-600">目录资料</span>
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                  {seedhubItems.map((item) => (
                    <button key={item.source_url + ':' + item.category} type="button"
                      onClick={() => router.push('/seedhub?url=' + encodeURIComponent(item.source_url) + '&category=' + item.category)}
                      className="overflow-hidden rounded-xl border border-line bg-card text-left transition hover:border-accent">
                      <span className="relative block aspect-video bg-chip">
                        {item.poster_url ? <SmartImage url={item.poster_url} mode={imageProxyMode} customProxy={customImageProxy} alt={item.title} className="absolute inset-0 h-full w-full object-cover" /> : null}
                      </span>
                      <span className="block truncate px-3 py-2 text-sm font-medium text-content">{item.title}</span>
                      <span className="block px-3 pb-3 text-xs text-muted">{item.category === 'movies' ? '电影' : item.category === 'series' ? '电视剧' : '动漫'} · SeedHub 目录</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {registryResources.length > 0 && (
              <div className="mb-5" aria-label="公开媒体资源">
                <div className="mb-2 flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-content">公开媒体资源 · 已通过预检</h3>
                  <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-600">Registry</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                  {registryResources.map((resource) => (
                    <button
                      key={resource.id}
                      type="button"
                      onClick={() => setRegistryPlayItem(resource)}
                      className="flex min-h-16 items-center justify-between gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-left hover:bg-emerald-500/10"
                    >
                      <span className="min-w-0">
                        <strong className="block truncate text-sm text-content">{resource.title}</strong>
                        <span className="block truncate text-xs text-muted">{resource.source_name ?? 'LibreTV Registry'} · 公开访问预检通过 · {resource.media_format?.toUpperCase() ?? 'MEDIA'}</span>
                      </span>
                      <span className="shrink-0 text-xs font-medium text-emerald-600">尝试播放 ▶</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {failures.length > 0 && (
              <div className="mb-3 text-xs bg-chip rounded-lg px-3 py-2 flex flex-wrap gap-x-3 gap-y-1">
                <span className="text-faint">
                  {isSearching ? '以下源暂时无响应：' : '部分点播源请求失败：'}
                </span>
                {failures.map((f) => (
                  <span key={f.sourceKey} className={f.timedOut ? 'text-warning' : 'text-faint'}>
                    {f.timedOut ? '⏱' : '✗'} {sourceName(f.sourceKey)}
                    {f.timedOut ? ' 超时' : ''}
                  </span>
                ))}
              </div>
            )}
            {disabledSources.length > 0 && (
              <div className="mb-3 text-xs text-faint bg-chip rounded-lg px-3 py-2">
                {disabledSources.length} 个源因连续超时/失败已暂停参与搜索（临时停用的到期自动恢复，
                长期停用的需在设置中手动恢复）：
                {disabledSources.map((key) => sourceName(key)).join('、')}
              </div>
            )}
            {offSubscriptionSources.length > 0 && (
              <div className="mb-3 text-xs text-faint bg-chip rounded-lg px-3 py-2">
                {offSubscriptionSources.length} 个源所属的订阅已停用，未参与本次搜索（在设置 → 数据源订阅中可重新启用）：
                {offSubscriptionSources.map((key) => sourceName(key)).join('、')}
              </div>
            )}
            {selectedSources.length === 0 && registryResources.length === 0 && seedhubItems.length === 0 ? (
              <NoSourceGuide hasSources={customAPIs.length > 0 || envSources.length > 0} />
            ) : list.length > 0 ? (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 items-start">
                  {visibleGroups.map((group) => (
                    <AggregatedCard
                      key={group.key}
                      group={group}
                      sources={selectedSources}
                      onOpen={openDetail}
                    />
                  ))}
                </div>
                {groups.length > visibleCount && (
                  <div className="flex justify-center mt-4">
                    <button
                      className="btn-ghost btn-sm"
                      onClick={() => setVisibleCount((v) => v + RESULT_PAGE_SIZE)}
                    >
                      加载更多（还有 {groups.length - visibleCount} 部）
                    </button>
                  </div>
                )}
              </>
            ) : registryResources.length > 0 || seedhubItems.length > 0 ? null : isSearching ? (
              <ResultsSkeleton />
            ) : searchQuery.isError || failures.length > 0 ? (
              <div className="flex flex-col items-center gap-3 py-8" role="alert">
                <EmptyState
                  icon="search"
                  title={failures.length > 0 ? "点播源暂时不可用" : "搜索暂时失败"}
                  description={searchQuery.error instanceof Error ? searchQuery.error.message : failures.length > 0 ? `有 ${failures.length} 个点播源请求失败，请重试或在设置中检查数据源。` : "请求点播源时发生错误，请稍后重试。"}
                  className="!py-4"
                />
                <button type="button" className="btn-primary btn-sm" onClick={() => void searchQuery.refetch()}>
                  重试搜索
                </button>
              </div>
            ) : (
              <EmptyState
                icon="search"
                title="没有找到匹配的结果"
                description="请尝试其他关键词或更换点播源"
                className="!py-16"
              />
            )}
          </section>
        )}

      </main>
      <RegistryInlinePlayer resource={registryPlayItem} onClose={() => setRegistryPlayItem(null)} />
    </div>
  );
}

function ResultsSkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="card flex h-28 overflow-hidden">
          <div className="w-[105px] sm:w-[120px] shrink-0 bg-chip animate-pulse" />
          <div className="flex-1 p-2.5 space-y-2">
            <div className="h-4 w-3/4 rounded bg-chip animate-pulse" />
            <div className="h-3 w-1/2 rounded bg-chip animate-pulse" />
            <div className="h-3 w-full rounded bg-chip animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}

function NoSourceGuide({ hasSources = false }: { hasSources?: boolean }) {
  return (
    <div className="border border-dashed border-line rounded-xl p-10 text-center max-w-lg mx-auto">
      <h3 className="text-content font-medium mb-2">
        {hasSources ? '尚未勾选点播源' : '先添加一个点播源'}
      </h3>
      <p className="text-sm text-muted leading-relaxed">
        {hasSources ? (
          <>
            点击右上角「设置」，勾选要参与搜索的点播源后重新搜索。
          </>
        ) : (
          <>
            LibreTV 不内置任何采集站。点击右上角「设置 → 添加 API」，填入一个
            Apple CMS 采集站地址（如{' '}
            <code className="text-accent text-xs">
              https://example.com/api.php/provide/vod
            </code>
            ），勾选后即可开始搜索。
          </>
        )}
      </p>
    </div>
  );
}
