'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/client-api';
import { useAppStore, resolveSource } from '@/lib/store';
import { useAuth } from '@/components/auth';
import { SmartImage } from '@/components/smart-image';
import { LoadingState, ErrorState } from '@/components/states';
import { addFavorite, addSearchHistory, db, removeFavorite } from '@/lib/db';
import { favoriteIdFor } from '@/lib/favorite-id';
import { buildWatchUrl, validateSourceUrl } from '@/lib/utils';
import { formatRemarks } from '@/lib/remarks';
import { isMovieType } from '@/lib/cms-parser';
import type { SourceConfig, VideoDetail } from '@/lib/types';
import { enqueueDownload } from '@/components/download-manager';

function detailSource(store: Pick<ReturnType<typeof useAppStore.getState>, 'customAPIs' | 'envSources'>, key: string, name: string, sourceUrl: string): SourceConfig | null {
  const local = resolveSource(store, key);
  if (key === 'friday-cms' && sourceUrl) {
    if (!validateSourceUrl(sourceUrl)) return null;
    return { ...(local ?? {}), key, name: name || local?.name || 'Friday CMS', url: sourceUrl, detail: undefined };
  }
  if (local) return local;
  if (sourceUrl && validateSourceUrl(sourceUrl)) return { key, name: name || key, url: sourceUrl };
  return null;
}

export function MovieDetailPage() {
  const router = useRouter();
  const params = useSearchParams();
  const customAPIs = useAppStore((state) => state.customAPIs);
  const envSources = useAppStore((state) => state.envSources);
  const imageProxyMode = useAppStore((state) => state.imageProxyMode);
  const customImageProxy = useAppStore((state) => state.customImageProxy);
  const { checked, verified } = useAuth();
  const sourceKey = params.get('source') ?? '';
  const vodId = params.get('id') ?? '';
  const title = params.get('title') ?? '未知影片';
  const poster = params.get('pic') ?? '';
  const rating = params.get('rating') ?? '';
  const sourceName = params.get('sourceName') ?? sourceKey;
  const sourceUrl = params.get('sourceUrl') ?? '';
  const source = useMemo(
    () => detailSource({ customAPIs, envSources }, sourceKey, sourceName, sourceUrl),
    [customAPIs, envSources, sourceKey, sourceName, sourceUrl],
  );
  const [detail, setDetail] = useState<VideoDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sharing, setSharing] = useState(false);
  const [episodeMenuIndex, setEpisodeMenuIndex] = useState<number | null>(null);

  // Episode actions are a real popover: dismiss on outside tap or Escape so the
  // menu never remains stranded over the horizontal episode shelf on mobile.
  useEffect(() => {
    if (episodeMenuIndex === null) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const card = target.closest(`[data-episode-menu-index="${episodeMenuIndex}"]`);
      if (!card) setEpisodeMenuIndex(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setEpisodeMenuIndex(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [episodeMenuIndex]);

  const favoriteId = sourceKey && vodId ? favoriteIdFor(sourceKey, vodId) : '';
  const favorite = useLiveQuery(
    () => favoriteId ? db.favorites.get(favoriteId) : undefined,
    [favoriteId],
  );
  const history = useLiveQuery(
    () => sourceKey && vodId ? db.history.get(`${sourceKey}_${vodId}`) : undefined,
    [sourceKey, vodId],
  );
  const progress = useLiveQuery(
    () => sourceKey && vodId
      ? db.progress.where('key').startsWith(`${sourceKey}_${vodId}_`).toArray()
      : [],
    [sourceKey, vodId],
  );
  const progressByIndex = useMemo(
    () => new Map((progress ?? []).map((entry) => [Number(entry.key.split('_').at(-1)), entry])),
    [progress],
  );

  useEffect(() => {
    if (!sourceKey || !vodId) {
      setError('影片定位信息不完整，请从首页或搜索结果重新进入');
      setLoading(false);
      return;
    }
    // Wait for the shared auth status check, then let the API's 401/503
    // handling open the existing login/setup dialog when access is required.
    if (!checked) return;
    if (!source) {
      setError('点播源不存在或地址未通过安全校验，请检查设置中的数据源');
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setDetail(null);
    api.detail(vodId, source, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setDetail(result);
      })
      .catch((reason) => {
        if (controller.signal.aborted || (reason instanceof DOMException && reason.name === 'AbortError')) return;
        setError(reason instanceof Error ? reason.message : '获取影片详情失败');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [sourceKey, vodId, source, checked, verified]);

  const info = detail?.videoInfo;
  const episodes = detail?.episodes ?? [];
  const episodeItems = detail?.episodeItems ?? [];
  // Detail feeds often omit a dedicated backdrop even when the search result
  // already supplied a valid poster. Keep the hero artwork populated by falling
  // back through the detail cover to the original poster URL.
  const backdrop = info?.backdrop?.trim() || info?.cover?.trim() || poster.trim();
  const knownSeasonNumbers = episodeItems
    .map((item) => item.seasonNumber)
    .filter((value): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0);
  const seasonNumber = knownSeasonNumbers.length === episodes.length
    && knownSeasonNumbers.length > 0
    && knownSeasonNumbers.every((value) => value === knownSeasonNumbers[0])
    ? knownSeasonNumbers[0]
    : undefined;
  // Keep source-provided episode names authoritative. Positional fallback text is
  // explicitly described as a playback item, never fabricated as an episode number.
  const episodeTitle = (index: number) => episodeItems[index]?.title?.trim() || '第 ' + (index + 1) + ' 个播放条目';
  const episodeNumberLabel = (index: number) => {
    const value = episodeItems[index]?.title?.trim() ?? '';
    return /^第\s*[\d一二两三四五六七八九十]+\s*[集话期]$/u.test(value)
      ? value.replace(/\s+/g, '')
      : '';
  };
  const episodeDisplayTitle = (index: number) => {
    const item = episodeItems[index];
    const value = item?.title?.trim() ?? '';
    return (/^第\s*[\d一二两三四五六七八九十]+\s*[集话期]$/u.test(value) ? '' : value)
      || item?.episodeName?.trim()
      || '';
  };
  const isMovie = isMovieType(info?.typeName, episodes.length);
  const displayTitle = info?.title || title;
  const image = info?.cover || poster;
  const metadata = [
    info?.year,
    info?.area,
    info?.typeName,
    rating ? '豆瓣 ' + rating : undefined,
    formatRemarks(info?.remarks),
  ].filter((value): value is string => Boolean(value));

  const play = useCallback((index: number) => {
    if (!sourceKey || !vodId || !episodes[index]) return;
    void addSearchHistory(displayTitle).catch(() => {});
    router.push(buildWatchUrl({
      sourceKey,
      vodId,
      index,
      title: displayTitle,
      sourceUrl: source?.url || sourceUrl || undefined,
    }));
  }, [sourceKey, vodId, episodes, displayTitle, router, source, sourceUrl]);

  const toggleFavorite = async () => {
    if (!sourceKey || !vodId) return;
    if (favorite) {
      await removeFavorite(sourceKey, vodId);
      return;
    }
    await addFavorite({
      sourceKey,
      sourceUrl: source?.url || sourceUrl || undefined,
      sourceName: sourceName || sourceKey,
      vodId,
      title: displayTitle,
      pic: image || undefined,
      typeName: info?.typeName,
      year: info?.year,
      remarks: info?.remarks,
    });
  };

  const share = async () => {
    setSharing(true);
    try {
      if (navigator.share) {
        await navigator.share({ title: displayTitle, text: info?.desc || displayTitle, url: window.location.href });
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(window.location.href);
      }
    } catch {
      // User cancellation is not an error; unsupported sharing remains a no-op.
    } finally {
      setSharing(false);
    }
  };

  const completedPercent = (index: number) => {
    const item = progressByIndex.get(index);
    if (!item?.duration) return 0;
    return Math.min(100, Math.max(0, Math.round(item.position / item.duration * 100)));
  };

  if (loading) {
    return <main className="movie-detail-page min-h-screen bg-[#08080A] px-5 pt-8 text-white"><div className="pt-16"><LoadingState label="正在整理影片详情…" /></div></main>;
  }
  if (error || !detail) {
    return (
      <main className="movie-detail-page min-h-screen bg-[#08080A] px-5 pt-8 text-white">
        
        <button type="button" onClick={() => router.back()} className="mb-8 rounded-full bg-white/10 px-4 py-2 text-sm">‹ 返回</button>
        <ErrorState message={error || '暂时无法获取影片详情'} />
      </main>
    );
  }

  return (
    <main className="movie-detail-page min-h-screen overflow-x-hidden bg-[#08080A] pb-[calc(96px+env(safe-area-inset-bottom))] text-white">
      
      <section className="movie-detail-hero relative isolate min-h-[560px] overflow-hidden sm:min-h-[640px]">
        {backdrop ? (
          <SmartImage
            url={backdrop}
            mode={imageProxyMode}
            customProxy={customImageProxy}
            alt={displayTitle}
            className="movie-detail-hero__image absolute inset-0 -z-20 h-full w-full object-cover object-center"
            loading="eager"
          />
        ) : (
          <div className="absolute inset-0 -z-20 bg-[#08080A]" aria-hidden="true" />
        )}
        <div className="movie-detail-hero__scrim absolute inset-0 -z-10" />
        <div className="movie-detail-hero__bottom-gradient absolute inset-x-0 bottom-0 -z-10" />
        <div className="movie-detail-hero__side-gradient absolute inset-0 -z-10" />

        <header className="movie-detail-hero__header relative z-10 flex items-center justify-between px-5 pt-[max(18px,env(safe-area-inset-top))] sm:px-10">
          <button type="button" onClick={() => router.back()} className="movie-detail-glass-control" aria-label="返回上一页">
            <span aria-hidden="true">‹</span>
          </button>
          <button type="button" onClick={() => void share()} disabled={sharing} className="movie-detail-glass-control" aria-label="分享影片">↗</button>
        </header>

        <div className="movie-detail-hero__content relative z-10 mx-auto flex min-h-[520px] max-w-6xl flex-col justify-end px-5 pb-10 pt-32 sm:min-h-[580px] sm:px-10 sm:pb-14">
          <div className="max-w-2xl">
            <p className="movie-detail-eyebrow mb-3 text-[10px] font-semibold uppercase text-white/65">LIBRETV · TITLE DETAILS</p>
            <h1 className="movie-detail-title max-w-3xl text-4xl leading-[1.05] tracking-[-.045em] sm:text-6xl">{displayTitle}</h1>
            {metadata.length > 0 && (
              <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs font-medium text-white/75 sm:text-sm">
                {metadata.map((value) => <span key={value}>{value}</span>)}
              </div>
            )}
            {info?.desc && <p className="movie-detail-description mt-5 max-w-xl text-sm leading-7 text-white/80 sm:text-base">{info.desc}</p>}
            <div className="movie-detail-actions mt-7 flex flex-wrap items-center gap-3">
              <button type="button" onClick={() => play(0)} disabled={episodes.length === 0} className="inline-flex min-h-12 items-center gap-3 rounded-full bg-white px-7 text-sm font-semibold text-black transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-40">
                <span aria-hidden="true">▶</span>{isMovie ? '立即播放' : '开始观看'}
              </button>
              <button type="button" onClick={() => void toggleFavorite()} className="flex h-12 w-12 items-center justify-center rounded-full border border-white/25 bg-white/10 text-xl backdrop-blur-xl" aria-label={favorite ? '取消收藏' : '加入收藏'} aria-pressed={Boolean(favorite)}>
                <span aria-hidden="true">{favorite ? '♥' : '＋'}</span>
              </button>
              <button type="button" onClick={() => void share()} disabled={sharing} className="flex h-12 w-12 items-center justify-center rounded-full border border-white/25 bg-white/10 text-lg backdrop-blur-xl" aria-label="分享影片">↗</button>
            </div>
          </div>
        </div>
      </section>

      {!isMovie && episodes.length > 0 && (
        <section className="mx-auto max-w-6xl px-5 pb-12 pt-10 sm:px-10" aria-labelledby="movie-episode-heading">
          <div className="mb-5 flex items-end justify-between gap-4">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[.22em] text-white/45">EPISODES</p>
              <h2 id="movie-episode-heading" className="mt-1 text-2xl font-semibold tracking-tight text-white">{seasonNumber ? `第 ${seasonNumber} 季` : '剧集'}</h2>
            </div>
            <span className="text-xs text-white/50">共 {episodes.length} 集</span>
          </div>
          <div className="movie-episode-carousel -mx-5 flex snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain px-5 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:-mx-10 sm:px-10">
            {episodes.map((episodeUrl, index) => {
              const item = episodeItems[index];
              const titleText = episodeDisplayTitle(index) || episodeNumberLabel(index) || episodeTitle(index);
              const detailText = [item?.description?.trim(), item?.duration?.trim()].filter(Boolean).join(' · ');
              return (
                <button
                  key={item?.url || episodeUrl || index}
                  type="button"
                  onClick={() => play(index)}
                  className="movie-episode-card group flex w-[72vw] max-w-[420px] min-w-[260px] shrink-0 snap-start flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[.055] text-left transition hover:border-white/25 hover:bg-white/[.085]"
                  aria-label={`播放${titleText}`}
                >
                  <div className="relative aspect-video w-full shrink-0 overflow-hidden bg-white/[.06]">
                    {(item?.image || image) ? (
                      <SmartImage
                        url={item?.image || image}
                        mode={imageProxyMode}
                        customProxy={customImageProxy}
                        alt={titleText}
                        className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.025]"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-xs text-white/40">
                        暂无可用图片
                      </div>
                    )}
                    <span className="absolute left-3 top-3 rounded-full bg-black/70 px-2.5 py-1 text-[11px] font-medium text-white/90">{episodeNumberLabel(index) || `第 ${index + 1} 集`}</span>
                  </div>
                  <div className="min-w-0 flex-1 p-3 sm:p-4">
                    <h3 className="truncate text-sm font-semibold text-white">{titleText}</h3>
                    {detailText ? (
                      <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-white/55">{detailText}</p>
                    ) : (
                      <p className="mt-1.5 text-xs text-white/35">分集简介或时长暂缺</p>
                    )}
                    <span className="mt-2 inline-flex items-center gap-2 text-xs font-medium text-white/75">▶ 播放本集</span>
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      )}
      </main>
  );
}
