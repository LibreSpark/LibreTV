'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLiveQuery } from 'dexie-react-hooks';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { V4HomepageHeader } from '@/components/home/V4HomepageHeader';
import { SourceManagerDrawer } from '@/components/source-manager';
import { Icon } from '@/components/icon';
import { requestShowDownloadManager } from '@/components/download-manager';
import { AnimeRecommendationSection, RecommendSection } from '@/components/douban-section';
import { DoubanCard } from '@/components/video-card';
import { GlassPanel } from '@/components/ui/glass';
import { SmartImage } from '@/components/smart-image';
import { db, removeFavorite, type FavoriteEntry, type HistoryEntry } from '@/lib/db';
import { isInDisabledSubscription, isSourceDisabled, resolveSource, useAppStore } from '@/lib/store';
import type { DoubanItem, SearchResultItem, SourceConfig } from '@/lib/types';
import { api } from '@/lib/client-api';
import { collectorFetch } from '@/lib/collector-browser-config';
import { validateSourceUrl } from '@/lib/utils';
import { formatTime } from '@/lib/utils';

type Screen = 'movies' | 'tv' | 'anime' | 'variety' | 'overseas' | 'resources' | 'me' | 'settings';
const COPY: Record<Screen, { eyebrow: string; title: string; subtitle: string }> = {
  movies: { eyebrow: 'LIBRARY / MOVIES', title: '电影', subtitle: '发现热门、新片与高分电影。' },
  tv: { eyebrow: 'LIBRARY / TV SERIES', title: '电视剧', subtitle: '浏览热门电视剧与不同地区的剧集推荐。' },
  variety: { eyebrow: 'LIBRARY / VARIETY', title: '综艺', subtitle: '浏览真实综艺推荐与热门节目。' },
  overseas: { eyebrow: 'LIBRARY / OVERSEAS DRAMA', title: '海外剧', subtitle: '按美剧、英剧、韩剧、日剧等分类发现海外剧集。' },
  anime: { eyebrow: 'LIBRARY / ANIME', title: '动漫', subtitle: '按星期查看 Bangumi 当季放送，追踪正在更新的新番。' },
  resources: { eyebrow: 'LIBRARY / SOURCES', title: '资源', subtitle: '管理真实接入的点播源、订阅和源健康状态，不展示虚构网盘结果。' },
  me: { eyebrow: 'PERSONAL / LIBRARY', title: '我的', subtitle: '本机观看记录与播放进度保存在你的设备上。' },
  settings: { eyebrow: '', title: '设置', subtitle: '' },
};

export function V4SpatialScreen({ screen }: { screen: Screen }) {
  const copy = COPY[screen];
  const router = useRouter();
  const selectedKeys = useAppStore((s) => s.selectedKeys);
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const yellowFilter = useAppStore((s) => s.yellowFilter);
  const sourceHealth = useAppStore((s) => s.sourceHealth);
  const subscriptions = useAppStore((s) => s.subscriptions);
  const [playbackError, setPlaybackError] = useState('');
  const openDetail = (item: SearchResultItem, extra?: { rating?: string; poster?: string }) => {
    const params = new URLSearchParams({ source: item.sourceKey, id: item.vodId, title: item.name, sourceName: item.sourceName });
    if (item.pic || extra?.poster) params.set('pic', item.pic || extra?.poster || '');
    if (extra?.rating) params.set('rating', extra.rating);
    if (item.sourceUrl) params.set('sourceUrl', item.sourceUrl);
    router.push('/detail?' + params.toString());
  };
  const selectedSources = selectedKeys
    .map((key) => resolveSource({ customAPIs, envSources }, key))
    .filter((source): source is SourceConfig => Boolean(
      source && validateSourceUrl(source.url) &&
      !isSourceDisabled({ sourceHealth }, source.key) &&
      !isInDisabledSubscription({ subscriptions }, source.key)
    ));
  const openRecommendation = async (movie: DoubanItem) => {
    setPlaybackError('');
    if (selectedSources.length === 0) {
      setPlaybackError('请先在设置中启用至少一个可用点播源。');
      return;
    }
    try {
      const response = await api.search(movie.title, selectedSources, yellowFilter);
      const normalize = (value: string) => value.replace(/[\s\p{P}\p{S}]/gu, '').toLocaleLowerCase();
      const target = normalize(movie.title);
      const match = response.list.find((entry) => normalize(entry.name) === target);
      if (!match) {
        setPlaybackError('暂未在已启用的点播源中找到《' + movie.title + '》的准确资源，请更换点播源后重试。');
        return;
      }
      openDetail(match, { rating: movie.rating, poster: movie.cover });
    } catch (error) {
      setPlaybackError(error instanceof Error ? error.message : '获取影片详情失败，请稍后重试。');
    }
  };
  return (
    <div className="v4-spatial-screen min-h-screen" data-screen={screen}>
      {screen !== 'me' ? <V4HomepageHeader /> : null}
      <main className="v4-spatial-main">
        {screen !== 'me' ? (
          <div className="v4-spatial-heading">
            <div>
              {copy.eyebrow ? <span className="v4-spatial-eyebrow">{copy.eyebrow}</span> : null}
              <h1>{copy.title}</h1>
              {copy.subtitle ? <p>{copy.subtitle}</p> : null}
            </div>
          </div>
        ) : null}

        {screen === 'movies' ? <><CatalogScreen category="movie" onPick={openRecommendation} /><SeedHubCatalogSection category="movies" /></> : null}
        {screen === 'tv' ? <><CatalogScreen category="tv" onPick={openRecommendation} /><SeedHubCatalogSection category="series" /></> : null}
        {screen === 'variety' ? <CatalogScreen category="variety" onPick={openRecommendation} /> : null}
        {screen === 'overseas' ? <CatalogScreen category="overseas" onPick={openRecommendation} /> : null}
        {screen === 'anime' ? <><AnimeScreen onPick={openRecommendation} /><SeedHubCatalogSection category="anime" /></> : null}
        {screen === 'resources' ? <ResourcesScreen onPick={openDetail} /> : null}
        {screen === 'me' ? <MeScreen /> : null}
        {screen === 'settings' ? <SettingsScreen /> : null}
      </main>
      {playbackError ? <p className="v4-spatial-footnote" role="status">{playbackError}</p> : null}
    </div>
  );
}

type SeedHubCategory = 'movies' | 'series' | 'anime';
type SeedHubDetail = { title?: string; description?: string; poster_url?: string | null; still_urls?: string[]; metadata?: Record<string, string>; source_url?: string; mode?: string };
type SeedHubCatalogItem = { source_url: string; title: string; category: SeedHubCategory; poster_url?: string | null; detail?: SeedHubDetail | null };
const SEEDHUB_LABEL: Record<SeedHubCategory, string> = { movies: '电影', series: '剧集', anime: '动漫' };

function SeedHubCatalogSection({ category }: { category: SeedHubCategory }) {
  const router = useRouter();
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const catalog = useQuery({
    queryKey: ['seedhub-catalog', category],
    queryFn: async () => {
      const response = await collectorFetch('/api/resource-collector?action=seedhub-catalog&category=' + category + '&limit=24&offset=0');
      const payload = await response.json() as { items?: SeedHubCatalogItem[]; total?: number; error?: string };
      if (!response.ok) throw new Error(payload.error || 'SeedHub 采集库暂不可用。');
      return { items: Array.isArray(payload.items) ? payload.items : [], total: Number(payload.total) || 0 };
    },
    staleTime: 60_000,
    retry: false,
  });
  return (
    <section className="v4-spatial-panel" aria-label={'SeedHub ' + SEEDHUB_LABEL[category] + '采集库'}>
      <div className="v4-spatial-panel-head"><h2>SeedHub {SEEDHUB_LABEL[category]}</h2><span>{catalog.data ? '已采集 ' + catalog.data.total + ' 条' : '独立采集目录'}</span></div>
      {catalog.isError ? <div className="v4-spatial-empty" role="status"><strong>SeedHub 采集库暂不可用</strong><p>{catalog.error instanceof Error ? catalog.error.message : '请检查设置中的 Scrapling HTTPS 地址和 Token，并确认采集服务已部署。'}</p></div>
      : catalog.isLoading ? <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3" aria-busy="true">{Array.from({ length: 6 }, (_, index) => <div key={index} className="aspect-[2/3] rounded-lg bg-chip animate-pulse" />)}</div>
      : !catalog.data?.items.length ? <div className="v4-spatial-empty">当前没有可展示的 SeedHub 目录记录。</div>
      : <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2.5">{catalog.data.items.map((item) => <button key={item.source_url} type="button" onClick={() => router.push('/seedhub?url=' + encodeURIComponent(item.source_url))} className="group min-w-0 overflow-hidden rounded-xl text-left" aria-label={'查看 ' + item.title + ' 的 SeedHub 详情'}><div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-chip">{item.poster_url ? <SmartImage url={item.poster_url} mode={imageProxyMode} customProxy={customImageProxy} alt="" className="absolute inset-0 h-full w-full object-cover transition-transform group-hover:scale-105" /> : <div className="flex h-full items-center justify-center px-2 text-center text-xs text-faint">暂无真实海报</div>}</div><strong className="mt-2 block line-clamp-2 text-xs text-content">{item.title}</strong><span className="mt-1 block text-[10px] text-faint">SeedHub · 详情资料</span></button>)}</div>}
    </section>
  );
}
type CatalogCategory = 'movie' | 'tv' | 'variety' | 'overseas';

const CATALOG_TAGS: Record<CatalogCategory, string[]> = {
  movie: ['热门', '最新', '经典', '豆瓣高分', '冷门佳片', '华语', '欧美', '韩国', '日本'],
  tv: ['热门', '国产剧', '美剧', '英剧', '韩剧', '日剧', '港剧'],
  variety: ['综艺'],
  overseas: ['热门', '美剧', '英剧', '韩剧', '日剧', '泰剧'],
};

function CatalogScreen({ category, onPick }: { category: CatalogCategory; onPick: (item: DoubanItem) => void }) {
  const tags = CATALOG_TAGS[category];
  const [tag, setTag] = useState(tags[0]);
  const type = category === 'movie' ? 'movie' : 'tv';
  const query = useQuery({
    queryKey: ['catalog', category, tag],
    queryFn: ({ signal }) => api.douban(type, tag, 0, 50, signal),
    // A transient upstream failure should not leave the catalogue retrying
    // invisibly for a long time; cached results remain usable across tabs.
    staleTime: 5 * 60 * 1000,
    retry: 1,
    retryDelay: 900,
    refetchOnWindowFocus: true,
  });
  const [loadingStalled, setLoadingStalled] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  useEffect(() => {
    if (!query.isLoading) {
      setLoadingStalled(false);
      return;
    }
    const timer = window.setTimeout(() => setLoadingStalled(true), 12000);
    return () => window.clearTimeout(timer);
  }, [query.isLoading, category, tag, loadAttempt]);
  const items = query.data?.items ?? [];
  return (
    <section className="v4-spatial-panel" aria-label={`${COPY[category === 'movie' ? 'movies' : category].title}推荐`}>
      <div className="v4-spatial-panel-head"><h2>{COPY[category === 'movie' ? 'movies' : category].title}推荐</h2><span>豆瓣实时数据</span></div>
      <div className="v4-catalog-filters mb-4">
        {tags.map((item) => (
          <button key={item} type="button" aria-pressed={tag === item}
            className={tag === item ? 'px-3 py-1.5 rounded-full text-xs bg-accent text-on-accent' : 'px-3 py-1.5 rounded-full text-xs bg-chip text-muted hover:text-content'}
            onClick={() => setTag(item)}>{item}</button>
        ))}
      </div>
      {query.isError ? (
        <div className="v4-spatial-empty flex flex-col items-center gap-3" role="alert">
          <span>分类数据暂时无法加载，请检查网络后重试。</span>
          <button type="button" className="v4-spatial-primary" onClick={() => void query.refetch()}>重新加载海报</button>
        </div>
      ) : query.isLoading && !loadingStalled ? (
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3" aria-label="正在加载海报" aria-busy="true">{Array.from({ length: 12 }, (_, i) => <div key={i} className="aspect-[2/3] rounded-lg bg-chip animate-pulse" />)}</div>
      ) : query.isLoading ? (
        <div className="v4-spatial-empty flex flex-col items-center gap-3" role="status">
          <span>海报请求超过 12 秒仍未完成，可能是上游数据源响应缓慢。</span>
          <button type="button" className="v4-spatial-primary" onClick={() => { setLoadingStalled(false); setLoadAttempt((value) => value + 1); void query.refetch(); }}>重试加载</button>
        </div>
      ) : items.length === 0 ? (
        <div className="v4-spatial-empty">该分类暂无推荐内容。</div>
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2.5">
          {items.map((item) => <DoubanCard key={item.id} item={item} onClick={() => onPick(item)} />)}
        </div>
      )}
    </section>
  );
}

function MoviesScreen({ onPick }: { onPick: (item: DoubanItem) => void }) {
  return (
    <section className="v4-spatial-panel" aria-label="影视推荐">
      <div className="v4-spatial-panel-head"><h2>热门影视</h2><span>实时推荐数据</span></div>
      <RecommendSection onPick={onPick} />
    </section>
  );
}

function AnimeScreen({ onPick }: { onPick: (item: DoubanItem) => void }) {
  return (
    <>
      <section className="v4-spatial-panel v4-anime-feature">
        <div className="v4-spatial-panel-head"><h2>每日放送</h2><span>Bangumi · 当季日历</span></div>
        <AnimeRecommendationSection onPick={onPick} />
      </section>
      <p className="v4-spatial-footnote">新番数据来自现有 Bangumi 日历接口；无数据时显示空状态，不使用示例海报填充。</p>
    </>
  );
}

function ResourcesScreen({ onPick }: { onPick: (item: SearchResultItem) => void }) {
  const selectedKeys = useAppStore((s) => s.selectedKeys);
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const sourceHealth = useAppStore((s) => s.sourceHealth);
  const subscriptions = useAppStore((s) => s.subscriptions);
  const yellowFilter = useAppStore((s) => s.yellowFilter);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const all = [...envSources, ...customAPIs];
  const activeSources = selectedKeys
    .map((key) => resolveSource({ customAPIs, envSources }, key))
    .filter((source): source is SourceConfig => Boolean(
      source && validateSourceUrl(source.url) &&
      !isSourceDisabled({ sourceHealth }, source.key) &&
      !isInDisabledSubscription({ subscriptions }, source.key)
    ));
  const runSearch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const keyword = query.trim().slice(0, 100);
    if (!keyword) return;
    if (activeSources.length === 0) {
      setError('请先在设置中启用至少一个可用点播源。');
      setResults([]);
      return;
    }
    setSearching(true);
    setError('');
    try {
      const response = await api.search(keyword, activeSources, yellowFilter);
      setResults(response.list);
      if (response.list.length === 0) setError('没有在当前启用的点播源中找到结果。');
    } catch (err) {
      setError(err instanceof Error ? err.message : '资源搜索失败，请稍后重试。');
      setResults([]);
    } finally {
      setSearching(false);
    }
  };
  const sourceName = (key: string) =>
    all.find((source) => source.key === key)?.name ?? key;

  return (
    <div className="v4-resources-layout space-y-5">
      <section className="v4-spatial-panel">
        <div className="v4-spatial-panel-head"><h2>搜索播放资源</h2><span>{activeSources.length} 个可用点播源</span></div>
        <form className="v4-resource-search" onSubmit={runSearch}>
          <input aria-label="搜索影视资源" value={query} maxLength={100} onChange={(event) => setQuery(event.target.value)} placeholder="搜索片名、剧集…" />
          <button type="submit" disabled={searching || !query.trim()}>{searching ? '搜索中…' : '搜索资源'}</button>
        </form>
        {error ? <p className="v4-resource-feedback" role="status">{error}</p> : null}
        {results.length > 0 ? (
          <div className="v4-resource-results">
            {results.map((item) => (
              <button key={`${item.sourceKey}:${item.vodId}`} type="button" onClick={() => onPick(item)} className="v4-resource-result">
                <div><strong>{item.name}</strong><span>{sourceName(item.sourceKey)} · {item.remarks || '可查看详情'}</span></div>
                <b>立即播放 ›</b>
              </button>
            ))}
          </div>
        ) : null}
      </section>
      <section className="v4-spatial-panel">
        <div className="v4-spatial-panel-head"><h2>已配置的数据源</h2><span>{all.length} 个来源 · {selectedKeys.length} 个已勾选</span></div>
        {all.length === 0 ? (
          <div className="v4-spatial-empty"><strong>还没有配置点播源</strong><p>添加一个兼容的采集 API 后，即可搜索和播放影视内容。</p></div>
        ) : (
          <div className="v4-source-grid">
            {all.map((source) => {
              const selected = selectedKeys.includes(source.key);
              const health = sourceHealth[source.key];
              return (
                <article className="v4-source-card" key={source.key}>
                  <div className="v4-source-status"><i className={selected ? 'is-enabled' : ''} />{selected ? '已勾选' : '未勾选'}</div>
                  <h3>{source.name}</h3>
                  <p title={source.url}>{source.url}</p>
                  <span>{health?.ok ? `最近响应 ${health.ms}ms` : health?.error ? '最近请求异常' : '尚无健康度记录'}</span>
                </article>
              );
            })}
          </div>
        )}
        <button type="button" className="v4-spatial-primary" onClick={() => window.dispatchEvent(new CustomEvent('libretv:open-source-manager'))}>管理点播源与订阅</button>
      </section>
    </div>
  );
}

function MeScreen() {
  const history = useLiveQuery(() => db.history.orderBy('timestamp').reverse().limit(24).toArray(), []);
  const downloads = useLiveQuery(() => db.downloads.orderBy('createdAt').reverse().limit(20).toArray(), []);
  const favorites = useLiveQuery(() => db.favorites.orderBy('addedAt').reverse().toArray(), []);
  const liveFavorites = useAppStore((state) => state.liveFavorites);
  const [showFavorites, setShowFavorites] = useState(false);

  return (
    <div className="v4-me-layout v52-me-layout">
      <header className="v52-me-header">
        <div className="v52-me-heading">
          <h2>我的空间</h2>
          <span>PERSONAL LIBRARY</span>
        </div>
      </header>

      <section className="v52-me-section v52-me-continue" aria-label="继续观看">
        <div className="v52-me-section-head">
          <h3>继续观看</h3>
          {history && history.length > 0 ? (
            <button type="button" onClick={() => window.dispatchEvent(new CustomEvent('libretv:open-history-panel'))}>
              全部 <span aria-hidden="true">›</span>
            </button>
          ) : null}
        </div>
        {!history ? (
          <p className="v52-me-empty">正在读取本机观看记录…</p>
        ) : history.length === 0 ? (
          <div className="v52-me-empty">
            <strong>尚无继续观看</strong>
            <span>开始播放影片后，播放进度会显示在这里。</span>
          </div>
        ) : (
          <div className="v52-me-poster-rail">
            {history.map((item) => <MeHistoryCard key={item.id} item={item} />)}
          </div>
        )}
      </section>

      <section className="v52-me-section v52-me-library" aria-label="媒体库">
        <div className="v52-me-section-head"><h3>媒体库</h3></div>
        <div className="v52-me-library-grid">
          <button type="button" className="v52-me-library-tile" aria-expanded={showFavorites}
            onClick={() => setShowFavorites((value) => !value)}>
            <span className="v52-me-tile-icon v52-me-heart"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 8.8c0 4.1-8.8 10-8.8 10s-8.8-5.9-8.8-10a4.7 4.7 0 0 1 8.8-2.3 4.7 4.7 0 0 1 8.8 2.3Z" /></svg></span>
            <strong>影视收藏</strong>
            <small>{favorites?.length ?? 0} 部收藏影片</small>
            <span className="v52-me-tile-chevron" aria-hidden="true">›</span>
          </button>
          <button type="button" className="v52-me-library-tile" onClick={() => window.dispatchEvent(new CustomEvent('libretv:open-history-panel'))}>
            <span className="v52-me-tile-icon v52-me-clock"><Icon name="clock" /></span>
            <strong>观看历史</strong>
            <small>{history?.length ?? 0} 条最近记录</small>
            <span className="v52-me-tile-chevron" aria-hidden="true">›</span>
          </button>
        </div>
        {showFavorites ? (
          <div className="v52-me-favorites-content">
            {!favorites ? <p className="v52-me-empty">正在读取影视收藏…</p> : favorites.length === 0 ? (
              <p className="v52-me-empty">还没有收藏影片，收藏后会显示在这里。</p>
            ) : (
              <div className="v52-me-favorites-list">
                {favorites.map((item) => <MeFavoriteCard key={item.id} item={item} />)}
              </div>
            )}
          </div>
        ) : null}
      </section>

      <section className="v52-me-section v52-me-other" aria-label="其他功能">
        <div className="v52-me-section-head"><h3>其他功能</h3></div>
        <div className="v52-me-list">
          <Link href="/search" className="v52-me-list-row">
            <span className="v52-me-list-icon"><Icon name="search" /></span>
            <strong>搜索记录</strong><span className="v52-me-chevron" aria-hidden="true">›</span>
          </Link>
          <Link href="/live" className="v52-me-list-row">
            <span className="v52-me-list-icon"><Icon name="radio" /></span>
            <strong>频道收藏</strong><small>{liveFavorites.length} 个</small><span className="v52-me-chevron" aria-hidden="true">›</span>
          </Link>
          <button type="button" className="v52-me-list-row" onClick={() => requestShowDownloadManager()}>
            <span className="v52-me-list-icon"><Icon name="download" /></span>
            <strong>下载管理</strong><small>{downloads?.length ?? 0} 个任务</small><span className="v52-me-chevron" aria-hidden="true">›</span>
          </button>
          <Link href="/settings" className="v52-me-list-row">
            <span className="v52-me-list-icon"><Icon name="gear" /></span>
            <strong>设置</strong><span className="v52-me-chevron" aria-hidden="true">›</span>
          </Link>
        </div>
      </section>
    </div>
  );
}

function MeFavoriteCard({ item }: { item: FavoriteEntry }) {
  const imageProxyMode = useAppStore((state) => state.imageProxyMode);
  const customImageProxy = useAppStore((state) => state.customImageProxy);
  const customAPIs = useAppStore((state) => state.customAPIs);
  const envSources = useAppStore((state) => state.envSources);
  const source = resolveSource({ customAPIs, envSources }, item.sourceKey);
  const params = new URLSearchParams({ source: item.sourceKey, id: item.vodId, title: item.title, sourceName: item.sourceName });
  if (item.pic) params.set('pic', item.pic);
  const sourceUrl = source?.url ?? item.sourceUrl;
  if (sourceUrl) params.set('sourceUrl', sourceUrl);
  const href = '/detail?' + params.toString();
  return (
    <article className="v4-me-history-card relative">
      <Link href={href} className="flex min-w-0 flex-1 items-center gap-3">
        <div className="v4-me-history-image">{item.pic ? <SmartImage url={item.pic} mode={imageProxyMode} customProxy={customImageProxy} alt="" className="absolute inset-0 h-full w-full object-cover" /> : <span>▶</span>}</div>
        <div className="v4-me-history-copy min-w-0"><strong>{item.title}</strong><span>{[item.year, item.typeName, item.sourceName].filter(Boolean).join(' · ')}</span></div>
      </Link>
      <button type="button" className="ml-2 shrink-0 rounded-lg px-3 py-2 text-xs text-muted hover:bg-chip" aria-label={"取消收藏 " + item.title} onClick={() => { void removeFavorite(item.sourceKey, item.vodId); }}>取消收藏</button>
    </article>
  );
}

function MeHistoryCard({ item }: { item: HistoryEntry }) {
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const source = resolveSource({ customAPIs, envSources }, item.sourceKey);
  const params = new URLSearchParams({ source: item.sourceKey, id: item.vodId, title: item.title, sourceName: source?.name ?? item.sourceKey });
  if (item.pic) params.set('pic', item.pic);
  const sourceUrl = source?.url ?? item.sourceUrl;
  if (sourceUrl) params.set('sourceUrl', sourceUrl);
  const href = '/detail?' + params.toString();
  const percent = item.duration > 0 ? Math.max(0, Math.min(100, Math.round(item.playbackPosition / item.duration * 100))) : 0;
  return (
    <Link className="v4-me-history-card" href={href}>
      <div className="v4-me-history-image">
        {item.pic ? <SmartImage url={item.pic} mode={imageProxyMode} customProxy={customImageProxy} alt="" className="absolute inset-0 h-full w-full object-cover" /> : <span>▶</span>}
      </div>
      <div className="v4-me-history-copy"><strong>{item.title}</strong><span>第 {item.episodeIndex + 1} 集 · {formatTime(item.playbackPosition)}</span><div><i style={{ width: `${percent}%` }} /></div></div>
    </Link>
  );
}

function SettingsScreen() {
  const downloads = useLiveQuery(
    () => db.downloads.orderBy('createdAt').reverse().toArray(),
    [],
  );
  const activeCount = (downloads ?? []).filter((task) =>
    ['queued', 'waiting', 'validating', 'downloading', 'merging', 'paused'].includes(task.status),
  ).length;

  return (
    <div className="mx-auto w-full max-w-5xl space-y-5 px-4 pb-12 sm:px-6">

      <SourceManagerDrawer open embedded onClose={() => undefined} />
      <section className="card p-4 sm:p-5" aria-labelledby="settings-downloads-title">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-accent/10 text-accent">
              <Icon name="download" />
            </span>
            <div className="min-w-0">
              <h2 id="settings-downloads-title" className="text-base font-semibold text-content">下载管理</h2>
              <p className="mt-1 text-xs text-faint">
                {downloads ? `共 ${downloads.length} 个任务 · ${activeCount} 个进行中或待处理` : '正在读取下载任务…'}
              </p>
            </div>
          </div>
          <button
            type="button"
            className="shrink-0 rounded-full bg-accent px-4 py-2 text-sm font-medium text-white transition hover:opacity-90"
            onClick={() => requestShowDownloadManager()}
          >
            管理任务
          </button>
        </div>
        <p className="mt-3 text-xs leading-5 text-faint">
          查看下载进度与状态，暂停、继续、取消、重试或删除任务。下载完成状态以实际文件保存结果为准。
        </p>
      </section>
    </div>
  );
}
