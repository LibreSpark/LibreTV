'use client';

import {
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';

import { Header } from '@/components/header';
import { HomeSearchSection } from '@/components/home/HomeSearchSection';
import { FridayHero } from '@/components/friday/FridayHero';
import { useFridayDetailBridge } from '@/components/friday/useFridayDetailBridge';
import { RecommendSection } from '@/components/douban-section';
import { DetailModal } from '@/components/detail-modal';
import { AggregatedCard, aggregateResults } from '@/components/video-card';
import {
  useAppStore,
  resolveSource,
  isInDisabledSubscription,
  isSourceDisabled,
} from '@/lib/store';
import { api } from '@/lib/client-api';
import type {
  SearchResultItem,
  SourceSearchOutcome,
} from '@/lib/types';
import {
  useSearchHistory,
} from '@/components/search-history';
import {
  cn,
  formatDisableTtl,
  validateSourceUrl,
} from '@/lib/utils';
import { useToast } from '@/components/toast';
import { EmptyState } from '@/components/states';
import { SiteFooter } from '@/components/site-footer';

const RESULT_PAGE_SIZE = 60;

const HOME_V2_ENABLED = process.env.NEXT_PUBLIC_HOME_V2 === 'true';

export default function HomePage() {
  return (
    <Suspense>
      {HOME_V2_ENABLED ? <HomePageV2 /> : <HomeContent />}
    </Suspense>
  );
}

/**
 * Feature-flag entry for the Friday-first homepage.
 * The V2 shell reuses HomeContent's existing search, recommendations,
 * detail modal, and navigation data flow; only the presentation variant changes.
 */
function HomePageV2() {
  return <HomeContent variant="v2" />;
}

type HomeContentProps = {
  variant?: 'legacy' | 'v2';
};

function HomeContent({ variant = 'legacy' }: HomeContentProps) {
  const isV2 = variant === 'v2';
  const searchParams = useSearchParams();
  const router = useRouter();
  const { toast } = useToast();

  const urlQuery = searchParams.get('q') ?? searchParams.get('s') ?? '';

  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const selectedKeys = useAppStore((s) => s.selectedKeys);
  const yellowFilter = useAppStore((s) => s.yellowFilter);
  const sourceHealth = useAppStore((s) => s.sourceHealth);
  const subscriptions = useAppStore((s) => s.subscriptions);
  const doubanEnabled = useAppStore((s) => s.doubanEnabled);

  const [input, setInput] = useState(urlQuery);
  const [detailItem, setDetailItem] =
    useState<SearchResultItem | null>(null);
  const [streamedOutcomes, setStreamedOutcomes] =
    useState<SourceSearchOutcome[]>([]);

  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (urlQuery) setInput(urlQuery);
  }, [urlQuery]);

  useFridayDetailBridge(setDetailItem, toast);

  const sourceName = (key: string) =>
    customAPIs.find((a) => a.key === key)?.name ??
    envSources.find((a) => a.key === key)?.name ??
    key;

  const selectedSources = useMemo(() => {
    const seen = new Set<string>();
    return selectedKeys
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
  }, [customAPIs, envSources, selectedKeys, sourceHealth, subscriptions]);

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
    enabled: Boolean(urlQuery) && selectedSources.length > 0,
    staleTime: 300_000,
  });

  const searchHistory = useSearchHistory(input);

  const runSearch = (q: string) => {
    const query = q.trim().slice(0, 100);
    if (!query) {
      toast('请输入搜索内容', 'info');
      inputRef.current?.focus();
      return;
    }
    if (selectedSources.length === 0) {
      toast('请先在设置中添加并勾选点播源', 'warning');
      return;
    }
    router.push(`/?q=${encodeURIComponent(query)}`, { scroll: false });
    searchHistory.record(query);
  };

  const pickHistory = (text: string) => {
    setInput(text);
    searchHistory.close();
    runSearch(text);
  };

  const isSearching = Boolean(urlQuery) && searchQuery.isFetching && !searchQuery.data;

  const streamedList = useMemo(
    () => streamedOutcomes.flatMap((o) => o.list),
    [streamedOutcomes]
  );

  const list = useMemo(
    () => searchQuery.data?.list ?? (isSearching ? streamedList : []),
    [searchQuery.data, isSearching, streamedList]
  );

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
    <div className={isV2 ? "home-v2 min-h-screen flex flex-col" : "legacy-home min-h-screen flex flex-col"}>
      <Header showFridayFab={!isV2} />
      <main className="relative flex-1 max-w-6xl w-full mx-auto px-4 py-6">
        {!urlQuery && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-[420px] -z-10"
            style={{
              background:
                'radial-gradient(60% 60% at 50% 0%, rgba(35,173,229,0.10) 0%, rgba(35,173,229,0.03) 45%, transparent 75%)',
            }}
          />
        )}
        {!urlQuery && isV2 ? (
          <FridayHero onSearchFocus={() => inputRef.current?.focus()} />
        ) : null}
        <HomeSearchSection
          urlQuery={urlQuery}
          input={input}
          setInput={setInput}
          inputRef={inputRef}
          searchHistory={searchHistory}
          runSearch={runSearch}
          pickHistory={pickHistory}
          showBrandTitle={!isV2}
          showQuickSearches={isV2}
        />
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
            {selectedSources.length === 0 ? (
              <NoSourceGuide hasSources={customAPIs.length > 0 || envSources.length > 0} />
            ) : list.length > 0 ? (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 items-start">
                  {visibleGroups.map((group) => (
                    <AggregatedCard
                      key={group.key}
                      group={group}
                      sources={selectedSources}
                      onOpen={(item) => setDetailItem(item)}
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
            ) : isSearching ? (
              <ResultsSkeleton />
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
        {!urlQuery && (
          <>
            {isV2 && doubanEnabled ? (
              <h2 className="home-v2-trending-title">今日热门</h2>
            ) : null}
            <RecommendSection
              onPick={(title) => {
                setInput(title);
                runSearch(title);
              }}
            />
          </>
        )}
      </main>
      <SiteFooter />
      <DetailModal item={detailItem} onClose={() => setDetailItem(null)} />
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
