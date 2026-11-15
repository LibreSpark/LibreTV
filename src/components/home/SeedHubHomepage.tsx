'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLiveQuery } from 'dexie-react-hooks';
import { useQuery } from '@tanstack/react-query';
import { SmartImage } from '@/components/smart-image';
import { collectorFetch } from '@/lib/collector-browser-config';
import { db, type HistoryEntry } from '@/lib/db';
import { resolveSource, useAppStore } from '@/lib/store';
import { buildWatchUrl, formatTime } from '@/lib/utils';

type SeedHubCategory = 'movies' | 'series' | 'anime';
type SeedHubCatalogItem = {
  source_url: string;
  title: string;
  category: SeedHubCategory;
  poster_url: string | null;
  discovered_at: number;
};
type SeedHubCatalogResponse = {
  source: 'SeedHub';
  category: SeedHubCategory;
  total: number;
  items: SeedHubCatalogItem[];
};

const CATEGORIES: Array<{ id: SeedHubCategory; title: string }> = [
  { id: 'movies', title: 'SeedHub 电影目录' },
  { id: 'series', title: 'SeedHub 电视剧目录' },
  { id: 'anime', title: 'SeedHub 动漫目录' },
];

async function fetchSeedHubCatalog(category: SeedHubCategory): Promise<SeedHubCatalogResponse> {
  const response = await collectorFetch(
    `/api/resource-collector?action=seedhub-catalog&category=${category}&limit=12&offset=0`
  );
  const payload = await response.json() as SeedHubCatalogResponse & { error?: string; detail?: string };
  if (!response.ok) {
    throw new Error(payload.error || payload.detail || (
      response.status === 503
        ? '尚未配置 Collector 地址和访问 Token，或 SeedHub 目录尚未同步。'
        : `SeedHub 目录读取失败（HTTP ${response.status}）`
    ));
  }
  if (payload.source !== 'SeedHub' || !Array.isArray(payload.items)) {
    throw new Error('SeedHub 返回的数据格式不正确。');
  }
  return {
    ...payload,
    items: payload.items.filter((item) => {
      if (!item.title?.trim() || !item.source_url || !item.poster_url) return false;
      try {
        const detail = new URL(item.source_url);
        const poster = new URL(item.poster_url);
        return detail.protocol === 'https:' && detail.hostname === 'www.seedhub.cc' &&
          poster.protocol === 'https:';
      } catch {
        return false;
      }
    }),
  };
}

export function SeedHubHomepage() {
  const router = useRouter();
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const history = useLiveQuery(
    () => db.history.orderBy('timestamp').reverse().limit(8).toArray(),
    [],
  );

  const movieQuery = useQuery({
    queryKey: ['seedhub-homepage-catalog', 'movies'],
    queryFn: () => fetchSeedHubCatalog('movies'),
    staleTime: 5 * 60_000,
    retry: 1,
  });
  const seriesQuery = useQuery({
    queryKey: ['seedhub-homepage-catalog', 'series'],
    queryFn: () => fetchSeedHubCatalog('series'),
    staleTime: 5 * 60_000,
    retry: 1,
  });
  const animeQuery = useQuery({
    queryKey: ['seedhub-homepage-catalog', 'anime'],
    queryFn: () => fetchSeedHubCatalog('anime'),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  const featured = movieQuery.data?.items[0] ?? seriesQuery.data?.items[0] ?? animeQuery.data?.items[0];
  const queries = [movieQuery, seriesQuery, animeQuery];
  const anyLoading = queries.some((query) => query.isLoading);
  const anyError = queries.some((query) => query.isError);
  const openSeedHubDetail = (item: SeedHubCatalogItem) => {
    router.push('/seedhub?url=' + encodeURIComponent(item.source_url) + '&category=' + item.category);
  };
  const openSettings = () => window.dispatchEvent(new CustomEvent('libretv:open-source-manager'));

  return (
    <>
      <section className="v4-hero v4-hero-immersive" aria-label="SeedHub 精选影片">
        {featured ? (
          <>
            <div className="v4-hero-image lg-media-frame" aria-hidden="true">
              <SmartImage
                url={featured.poster_url || ''}
                mode={imageProxyMode}
                customProxy={customImageProxy}
                alt=""
                className="absolute inset-0 h-full w-full object-cover"
              />
            </div>
            <div className="v4-hero-veil" aria-hidden="true" />
            <div className="v4-hero-content v4-hero-immersive-copy">
              <span className="v4-hero-eyebrow">SEEDHUB / 最新采集</span>
              <h1>{featured.title}</h1>
              <p className="v4-hero-subtitle">真实海报与影片资料来自 SeedHub 公开目录</p>
              <div className="v4-hero-tags"><span>SeedHub 原始海报</span><span>播放状态未验证</span></div>
              <div className="v4-hero-actions v4-apple-actions">
                <button type="button" className="v4-hero-primary" onClick={() => openSeedHubDetail(featured)}>
                  查看详情
                </button>
                <Link href="/resource-studio" className="v4-hero-primary">
                  资源管理中心
                </Link>
              </div>
            </div>
          </>
        ) : (
          <div className="v4-hero-content v4-hero-empty v4-hero-immersive-copy" role="status">
            <span className="v4-hero-eyebrow">SEEDHUB</span>
            <h1>{anyLoading ? '正在读取 SeedHub 片库' : '等待 SeedHub 目录'}</h1>
            <p>{anyLoading ? '正在读取真实海报与影片目录' : '配置 Collector 并同步 SeedHub 目录后，这里会显示真实海报。'}</p>
            {!anyLoading ? (
              <div className="flex flex-wrap gap-3">
                <button type="button" className="v4-hero-primary" onClick={openSettings}>配置资源采集中心</button>
                <Link href="/resource-studio" className="v4-hero-primary">打开资源管理中心</Link>
              </div>
            ) : null}
          </div>
        )}
      </section>

      {CATEGORIES.map(({ id, title }) => {
        const query = id === 'movies' ? movieQuery : id === 'series' ? seriesQuery : animeQuery;
        const items = query.data?.items ?? [];
        return (
          <section className="v4-content-section v4-apple-rail-section" id={`seedhub-${id}`} aria-label={title} key={id}>
            <div className="v4-section-heading"><h2>{title} <span aria-hidden="true">›</span></h2></div>
            {query.isLoading ? (
              <div className="v4-apple-rail" aria-label={`${title}加载中`}>
                {Array.from({ length: 4 }).map((_, index) => <div className="v4-apple-poster-skeleton" key={index} />)}
              </div>
            ) : query.isError ? (
              <div className="v4-apple-rail-message" role="status">
                {query.error instanceof Error ? query.error.message : 'SeedHub 目录暂不可用。'}
                <button type="button" className="ml-2 underline" onClick={() => void query.refetch()}>重试</button>
              </div>
            ) : items.length ? (
              <div className="v4-apple-rail" aria-label={`${title}，可横向滑动`}>
                {items.map((item, index) => (
                  <button className="v4-apple-poster-card" key={item.source_url} type="button" onClick={() => openSeedHubDetail(item)}>
                    <span className="v4-apple-poster-art">
                      <SmartImage
                        url={item.poster_url || ''}
                        mode={imageProxyMode}
                        customProxy={customImageProxy}
                        alt={item.title}
                        className="absolute inset-0 h-full w-full object-cover"
                      />
                      <span className="v4-apple-poster-rank">{index + 1}</span>
                      <span className="v4-apple-poster-caption"><strong>{item.title}</strong><small>SeedHub</small></span>
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="v4-apple-rail-message">该分类尚无已同步的 SeedHub 海报。</p>
            )}
          </section>
        );
      })}

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
          <div className="v4-history-row">{history.map((item) => <V4ContinueCard key={item.id} item={item} />)}</div>
        )}
      </section>
      {anyError && !featured ? (
        <p className="sr-only" role="status">SeedHub 目录读取失败，未使用豆瓣或其他来源填充海报。</p>
      ) : null}
    </>
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
          <SmartImage url={item.pic} mode={imageProxyMode} customProxy={customImageProxy} alt={item.title} className="absolute inset-0 h-full w-full object-cover" />
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
