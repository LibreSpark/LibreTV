'use client';

import { useEffect, useState } from 'react';
import { buildImageCandidates } from '@/lib/utils';

const DEFAULT_POSTER_SRC =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 300 450'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop stop-color='%231b2940'/%3E%3Cstop offset='1' stop-color='%23090f1c'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='300' height='450' fill='url(%23g)'/%3E%3Crect x='105' y='165' width='90' height='90' rx='18' fill='none' stroke='%237d91ad' stroke-width='7'/%3E%3Cpath d='M135 185v50l42-25z' fill='%237d91ad'/%3E%3Ctext x='150' y='310' text-anchor='middle' fill='%2393a4bb' font-size='17' font-family='Arial,sans-serif'%3ELibreTV%3C/text%3E%3C/svg%3E";

interface SmartImageProps {
  /** 原始图片地址（未经代理加工，降级链由本组件按加载方式生成） */
  url?: string;
  mode: 'direct' | 'proxy' | 'custom';
  customProxy?: string;
  alt: string;
  className?: string;
  loading?: 'lazy' | 'eager';
  /** 候选链耗尽后回调，调用方切换占位图等兜底 UI */
  onExhausted?: () => void;
}

/**
 * 带降级链的封面图组件：direct 模式按 buildImageCandidates 的顺序加载，
 * onError 逐级回退（豆瓣图：直连 → 公共镜像 → 内置代理）；
 * 全部失败后触发 onExhausted 并停止渲染，由调用方展示占位图。
 * referrerPolicy=no-referrer：不向图床暴露来源页，规避部分站点的 Referer 校验。
 */
export function SmartImage({
  url,
  mode,
  customProxy = '',
  alt,
  className,
  loading = 'lazy',
  onExhausted,
}: SmartImageProps) {
  const candidates = buildImageCandidates(url, mode, customProxy);
  const [idx, setIdx] = useState(0);
  const [fallback, setFallback] = useState(false);

  // 地址或加载方式变化时重置降级进度
  useEffect(() => {
    setIdx(0);
    setFallback(false);
  }, [url, mode, customProxy]);

  const src = fallback ? DEFAULT_POSTER_SRC : candidates[idx];
  if (!src) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      className={className}
      loading={loading}
      referrerPolicy="no-referrer"
      onError={() => {
        if (fallback) return;
        if (idx + 1 < candidates.length) {
          setIdx((current) => current + 1);
          return;
        }
        // 所有原图/代理候选都失败时，显示内置 SVG 海报，避免浏览器碎图图标。
        setFallback(true);
        onExhausted?.();
      }}
    />
  );
}
