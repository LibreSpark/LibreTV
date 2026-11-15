'use client';

import { useEffect, useState } from 'react';
import { buildImageCandidates } from '@/lib/utils';

const DEFAULT_POSTER_SRC =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 300 450'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop stop-color='%231b2940'/%3E%3Cstop offset='1' stop-color='%23090f1c'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='300' height='450' fill='url(%23g)'/%3E%3Crect x='105' y='165' width='90' height='90' rx='18' fill='none' stroke='%237d91ad' stroke-width='7'/%3E%3Cpath d='M135 185v50l42-25z' fill='%237d91ad'/%3E%3Ctext x='150' y='310' text-anchor='middle' fill='%2393a4bb' font-size='17' font-family='Arial,sans-serif'%3ELibreTV%3C/text%3E%3C/svg%3E";

interface SmartImageProps {
  /** SDR 图片地址；HDR 不可用或加载失败时的可靠回退 */
  url?: string;
  /** 主图候选全部失败后继续尝试的备用图片地址 */
  fallbackUrl?: string;
  /** 可选的独立 HDR / gain-map 图片地址。只有高动态范围显示设备会优先尝试 */
  hdrUrl?: string;
  mode: 'direct' | 'proxy' | 'custom';
  customProxy?: string;
  alt: string;
  className?: string;
  loading?: 'lazy' | 'eager';
  /** 是否在所有图片候选失败后显示通用海报占位；剧集卡片应关闭并显示自身占位 */
  showDefaultFallback?: boolean;
  /** 候选链耗尽后回调，调用方切换占位图等兜底 UI */
  onExhausted?: () => void;
}

/**
 * 统一海报解码入口：
 * - 原图若内嵌 Ultra HDR / gain map，交给浏览器原生解码，避免 CSS filter 破坏 HDR 高光；
 * - 有独立 HDR 地址时，仅在 dynamic-range: high 设备优先尝试；
 * - HDR 候选失败自动回退 SDR 候选，再回退占位图；
 * - 不对图片像素做 canvas 重绘，避免丢失增益图、广色域和原始细节。
 */
export function SmartImage({
  url,
  fallbackUrl,
  hdrUrl,
  mode,
  customProxy = '',
  alt,
  className,
  loading = 'lazy',
  showDefaultFallback = true,
  onExhausted,
}: SmartImageProps) {
  const candidates = [...new Set([
    ...buildImageCandidates(url, mode, customProxy),
    ...buildImageCandidates(fallbackUrl, mode, customProxy),
  ])];
  const hdrCandidates = buildImageCandidates(hdrUrl, mode, customProxy);
  const [supportsHdr, setSupportsHdr] = useState(false);
  const [hdrFailed, setHdrFailed] = useState(false);
  const [idx, setIdx] = useState(0);
  const [fallback, setFallback] = useState(false);
  const useHdrSource = supportsHdr && hdrCandidates.length > 0 && !hdrFailed;
  const activeCandidates = useHdrSource ? hdrCandidates : candidates;
  const src = fallback
    ? (showDefaultFallback ? DEFAULT_POSTER_SRC : undefined)
    : activeCandidates[idx];

  useEffect(() => {
    const query = window.matchMedia('(dynamic-range: high)');
    const update = () => setSupportsHdr(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);

  // 地址、代理或显示能力变化时重新尝试首选候选
  useEffect(() => {
    setIdx(0);
    setHdrFailed(false);
    setFallback(false);
  }, [url, fallbackUrl, hdrUrl, mode, customProxy]);

  if (!src) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      className={className}
      loading={loading}
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => {
        if (fallback) return;
        if (idx + 1 < activeCandidates.length) {
          setIdx((current) => current + 1);
          return;
        }
        if (useHdrSource) {
          setHdrFailed(true);
          setIdx(0);
          return;
        }
        setFallback(true);
        onExhausted?.();
      }}
    />
  );
}
