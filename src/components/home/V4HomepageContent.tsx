'use client';

import Link from 'next/link';
import { useLiveQuery } from 'dexie-react-hooks';
import { useQuery } from '@tanstack/react-query';
import { SmartImage } from '@/components/smart-image';
import { api } from '@/lib/client-api';
import { fetchHomepageWithFallback } from '@/lib/homepage-recommendation-fallback';
import { db, type HistoryEntry } from '@/lib/db';
import { resolveSource, useAppStore } from '@/lib/store';
import type { DoubanItem } from '@/lib/types';
import { buildWatchUrl, formatTime } from '@/lib/utils';

const CONTINUE_LIMIT = 8;
const RAIL_LIMIT = 10;

export function V4HomepageContent({ onPick }: { onPick: (item: DoubanItem) => void }) {
  const doubanEnabled = useAppStore((s) => s.doubanEnabled);
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const history = useLiveQuery(
    () => db.history.orderBy('timestamp').reverse().limit(CONTINUE_LIMIT).toArray(),
    [],
  );

  const tvQuery = useQuery({
    queryKey: ['homepage-apple-tv-top10'],
    queryFn: ({ signal }) => fetchHomepageWithFallback(
      () => api.douban('tv', '热门', 0, RAIL_LIMIT, signal),
      () => api.hotList('douban_tv_chinese', signal),
      signal
    ),
    enabled: doubanEnabled,
    staleTime: 5 * 60_000,
  });
  const movieQuery = useQuery({
    queryKey: ['homepage-apple-movie-top10'],
    queryFn: ({ signal }) => fetchHomepageWithFallback(
      () => api.douban('movie', '热门', 0, RAIL_LIMIT, signal),
      () => api.hotList('douban_movie_weekly', signal),
      signal
    ),
    enabled: doubanEnabled,
    staleTime: 5 * 60_000,
  });
  const newQuery = useQuery({
    queryKey: ['homepage-apple-new-releases'],
    queryFn: ({ signal }) => api.douban('movie', '最新', 0, RAIL_LIMIT, signal),
    enabled: doubanEnabled,
    staleTime: 5 * 60_000,
  });

  const tvItems = (tvQuery.data?.items ?? []).filter((item) => item.cover).slice(0, RAIL_LIMIT);
  const movieItems = (movieQuery.data?.items ?? []).filter((item) => item.cover).slice(0, RAIL_LIMIT);
  const newItems = (newQuery.data?.items ?? []).filter((item) => item.cover).slice(0, RAIL_LIMIT);

  return (
    <>

      {doubanEnabled ? (
        <>
          <HomepagePosterRail
            id="apple-tv-top10"
            title="热门电视剧"
            items={tvItems}
            loading={tvQuery.isLoading}
            error={tvQuery.isError}
            onPick={onPick}
            imageProxyMode={imageProxyMode}
            customImageProxy={customImageProxy}
          />
          <HomepagePosterRail
            id="apple-movie-top10"
            title="热门电影"
            items={movieItems}
            loading={movieQuery.isLoading}
            error={movieQuery.isError}
            onPick={onPick}
            imageProxyMode={imageProxyMode}
            customImageProxy={customImageProxy}
          />
          <HomepagePosterRail
            id="apple-new-releases"
            title="新上架"
            items={newItems}
            loading={newQuery.isLoading}
            error={newQuery.isError}
            onPick={onPick}
            imageProxyMode={imageProxyMode}
            customImageProxy={customImageProxy}
          />
        </>
      ) : null}

      <section className="v4-content-section v4-continue-section" id="my-library" aria-label="继续观看">
        <div className="v4-section-heading">
          <h2>继续观看 <span aria-hidden="true">›</span></h2>
          {history && history.length > 0 ? <span className="v4-history-count">最近 {history.length} 部</span> : null}
        </div>
        {!history ? (
          <div className="v4-history-empty" role="status">正在读取本机观看记录…</div>
        ) : history.length === 0 ? (
          <div className="v4-history-empty">还没有观看记录，开始播放后会显示在这里。</div>
        ) : (
          <div className="v4-history-row">
            {history.map((item) => (
              <V4ContinueCard key={item.id} item={item} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function HomepagePosterRail({
  id,
  title,
  items,
  loading,
  error,
  onPick,
  imageProxyMode,
  customImageProxy,
}: {
  id: string;
  title: string;
  items: DoubanItem[];
  loading: boolean;
  error: boolean;
  onPick: (item: DoubanItem) => void;
  imageProxyMode: ReturnType<typeof useAppStore.getState>['imageProxyMode'];
  customImageProxy: string;
}) {
  return (
    <section className="v4-content-section v4-apple-rail-section" id={id} aria-label={title}>
      <div className="v4-section-heading">
        <h2>{title} <span aria-hidden="true">›</span></h2>
      </div>
      {loading ? (
        <div className="v4-apple-rail" aria-label={`${title}加载中`}>
          {Array.from({ length: 4 }).map((_, index) => (
            <div className="v4-apple-poster-skeleton" key={index} />
          ))}
        </div>
      ) : error ? (
        <p className="v4-apple-rail-message" role="status">内容暂时无法加载，请稍后重试。</p>
      ) : items.length > 0 ? (
        <div className="v4-apple-rail" aria-label={`${title}，可横向滑动`}>
          {items.map((item, index) => (
            <button className="v4-apple-poster-card" key={item.id} type="button" onClick={() => onPick(item)}>
              <span className="v4-apple-poster-art">
                <SmartImage
                  url={item.cover}
                  mode={imageProxyMode}
                  customProxy={customImageProxy}
                  alt={item.title}
                  className="absolute inset-0 h-full w-full object-cover"
                />
                <span className="v4-apple-poster-rank">{index + 1}</span>
                <span className="v4-apple-poster-caption">
                  <strong>{item.title}</strong>
                  {item.rating ? <small>★ {item.rating}</small> : null}
                </span>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p className="v4-apple-rail-message">暂无可展示的内容。</p>
      )}
    </section>
  );
}

function V4ContinueCard({ item }: { item: HistoryEntry }) {
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const source = resolveSource({ customAPIs, envSources }, item.sourceKey);
  const href = buildWatchUrl({
    sourceKey: item.sourceKey,
    vodId: item.vodId,
    index: item.episodeIndex,
    title: item.title,
    sourceUrl: source?.url ?? item.sourceUrl,
    detail: source?.detail,
  });
  const percent = item.duration > 0
    ? Math.max(0, Math.min(100, Math.round((item.playbackPosition / item.duration) * 100)))
    : 0;

  return (
    <Link className="v4-history-card" href={href}>
      <div className="v4-history-image">
        {item.pic ? (
          <SmartImage
            url={item.pic}
            mode={imageProxyMode}
            customProxy={customImageProxy}
            alt={item.title}
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : <span className="v4-history-image-fallback" aria-hidden="true">▶</span>}
        <span className="v4-history-play" aria-hidden="true">▶</span>
      </div>
      <div className="v4-history-copy">
        <strong title={item.title}>{item.title}</strong>
        <span>第 {item.episodeIndex + 1} 集 · {formatTime(item.playbackPosition)}{item.duration > 0 ? ` / ${formatTime(item.duration)}` : ''}</span>
        <div className="v4-progress-meta">
          <div className="v4-progress-track" role="progressbar" aria-label={`${item.title} 播放进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
            <span style={{ width: `${percent}%` }} />
          </div>
          <span className="v4-progress-percent">{percent}%</span>
        </div>
      </div>
    </Link>
  );
}
