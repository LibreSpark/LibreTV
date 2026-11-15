'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import { fetchHomepageWithFallback } from '@/lib/homepage-recommendation-fallback';
import { SmartImage } from '@/components/smart-image';
import { useAppStore } from '@/lib/store';
import type { DoubanItem } from '@/lib/types';

const AUTOPLAY_INTERVAL = 6_000;
const MANUAL_PAUSE = 9_000;
const SWIPE_THRESHOLD = 42;

export function V4HomepageHero({ onPick }: { onPick: (item: DoubanItem) => void }) {
  const [activeSlide, setActiveSlide] = useState(0);
  const [manualPause, setManualPause] = useState(false);
  const pointerStartX = useRef<number | null>(null);
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const featuredQuery = useQuery({
    queryKey: ['v4-featured-movies'],
    queryFn: ({ signal }) => fetchHomepageWithFallback(
      () => api.douban('movie', '热门', 0, 8, signal),
      () => api.hotList('douban_movie_weekly', signal),
      signal
    ),
    staleTime: 5 * 60_000,
  });
  const slides = (featuredQuery.data?.items ?? []).filter((item) => item.cover).slice(0, 5);
  const normalizedActiveSlide = slides.length > 0 ? activeSlide % slides.length : 0;
  const slide = slides[normalizedActiveSlide];

  useEffect(() => {
    if (slides.length < 2 || manualPause) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        setActiveSlide((current) => (current + 1) % slides.length);
      }
    }, AUTOPLAY_INTERVAL);
    return () => window.clearInterval(timer);
  }, [slides.length, manualPause]);

  useEffect(() => {
    if (!manualPause) return;
    const timer = window.setTimeout(() => setManualPause(false), MANUAL_PAUSE);
    return () => window.clearTimeout(timer);
  }, [manualPause]);

  const selectSlide = (index: number) => {
    setActiveSlide(index);
    setManualPause(true);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    pointerStartX.current = event.clientX;
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLElement>) => {
    if (pointerStartX.current === null || slides.length < 2) return;
    const delta = event.clientX - pointerStartX.current;
    pointerStartX.current = null;
    if (Math.abs(delta) < SWIPE_THRESHOLD) return;
    selectSlide((normalizedActiveSlide + (delta < 0 ? 1 : -1) + slides.length) % slides.length);
  };

  return (
    <section
      className="v4-hero v4-hero-immersive"
      aria-label="精选影片轮播"
      style={{ touchAction: 'pan-y' }}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => { pointerStartX.current = null; }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight' && slides.length > 1) {
          event.preventDefault();
          selectSlide((normalizedActiveSlide + 1) % slides.length);
        } else if (event.key === 'ArrowLeft' && slides.length > 1) {
          event.preventDefault();
          selectSlide((normalizedActiveSlide - 1 + slides.length) % slides.length);
        }
      }}
    >
      {slide ? (
        <>
          <div className="v4-hero-image lg-media-frame" aria-hidden="true">
            <SmartImage
              url={slide.cover}
              hdrUrl={slide.coverHdr}
              mode={imageProxyMode}
              customProxy={customImageProxy}
              alt=""
              loading="eager"
              className="absolute inset-0 h-full w-full object-cover"
            />
          </div>
          <div className="v4-hero-veil" aria-hidden="true" />
          <div className="v4-hero-content v4-hero-immersive-copy">
            <h1>{slide.title}</h1>
            <p className="v4-hero-subtitle">从热门影片中，找到下一部值得看的作品</p>
            <div className="v4-hero-tags" aria-label="内容标签">
              <span>精选影片</span>
              <span>豆瓣热门</span>
              {slide.rating ? <span>★ {slide.rating}</span> : null}
            </div>
            <div className="v4-hero-actions v4-apple-actions">
              <button type="button" className="v4-hero-primary" aria-label={`查看详情：${slide.title}`} onClick={() => onPick(slide)}>
                查看详情
              </button>
              <span className="v4-hero-plus" aria-hidden="true">+</span>
            </div>
          </div>
          <div className="v4-hero-indicators v4-hero-dots" role="group" aria-label="选择 Banner 图片">
            {slides.map((item, index) => (
              <button
                key={item.id}
                type="button"
                aria-label={`查看精选影片：${item.title}`}
                aria-pressed={normalizedActiveSlide === index}
                className={normalizedActiveSlide === index ? 'is-active' : ''}
                onClick={() => selectSlide(index)}
              />
            ))}
          </div>
        </>
      ) : (
        <div className="v4-hero-content v4-hero-empty v4-hero-immersive-copy" role="status">
          <span className="v4-hero-eyebrow">LIBRETV</span>
          <h1>{featuredQuery.isLoading ? '发现好内容' : '精选内容暂不可用'}</h1>
          <p>{featuredQuery.isLoading ? '正在为你挑选精彩影片' : '推荐内容暂时无法加载，请稍后再试'}</p>
          {!featuredQuery.isLoading && (
            <button
              type="button"
              className="v4-hero-retry"
              onClick={() => void featuredQuery.refetch()}
              disabled={featuredQuery.isFetching}
            >
              {featuredQuery.isFetching ? '正在重试…' : '重试加载'}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
