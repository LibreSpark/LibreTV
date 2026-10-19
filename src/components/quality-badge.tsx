'use client';

import { cn } from '@/lib/utils';
import { describeQualityBadge } from '@/lib/quality';
import type { QualityEntry } from '@/lib/types';
import { useT } from '@/lib/i18n';

/**
 * 画质徽章：四态外观与 tooltip 都来自 describeQualityBadge（纯函数，可单测）。
 *
 * 「未探到」与「未知」在数据上都是没有 height，但含义相反：
 * 前者是请求失败可以重试，后者是源站本来就不给信息（单码率/直链）。
 * 所以失败态用琥珀色并渲染为可点击的 button；未知态保持灰 chip 且不可点。
 */
export function QualityBadge({
  entry,
  loading,
  onRetry,
  showReason,
  className,
}: {
  entry?: QualityEntry;
  loading?: boolean;
  /** 失败态可重试；不传则失败态退化为普通徽章 */
  onRetry?: () => void;
  /** 就地显示失败原因（超时/防盗链/无资源）：触屏看不到 tooltip，需要可见文案 */
  showReason?: boolean;
  className?: string;
}) {
  const t = useT();
  const view = describeQualityBadge(entry, loading);
  if (!view) return null;

  if (view.kind === 'loading') {
    return (
      <span
        className={cn('tag bg-chip text-faint shrink-0 animate-pulse', className)}
        title={view.title}
        aria-label={t('正在探测画质')}
      >
        …
      </span>
    );
  }

  if (view.kind === 'value') {
    const height = entry?.height ?? 0;
    return (
      <span
        className={cn(
          'tag font-medium shrink-0',
          // 高画质给强调色；≤480 的标清退到 faint，让它在「源名 / 画质 / 集数」里自然后置
          height >= 1080 ? 'bg-accent/15 text-accent' : height > 0 && height < 480 ? 'bg-chip text-faint' : 'bg-chip text-muted',
          className
        )}
        title={view.title}
      >
        {view.label}
      </span>
    );
  }

  if (view.kind === 'failed' && view.retryable && onRetry) {
    return (
      <button
        type="button"
        // 徽章常嵌在整卡可点击区域里：拦住冒泡，否则点「重试」会变成打开详情
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          onRetry();
        }}
        onKeyDown={(e) => e.stopPropagation()}
        className={cn(
          'tag font-medium shrink-0 bg-warning/15 text-warning hover:bg-warning/25 transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/40',
          className
        )}
        title={view.title}
        aria-label={`${t('本次没测到画质，点击重试')}${view.reason ? ` (${t(view.reason)})` : ''}`}
      >
        {t(view.label ?? '未测到')}
        {showReason && view.reason && <span className="ml-0.5 opacity-80">·{t(view.reason)}</span>}
      </button>
    );
  }

  return (
    <span
      className={cn('tag shrink-0', view.kind === 'failed' ? 'bg-warning/15 text-warning' : 'bg-chip text-faint', className)}
      title={view.title}
    >
      {view.kind === 'failed' ? t(view.label ?? '未测到') : t('未知')}
      {showReason && view.reason && <span className="ml-0.5 opacity-80">·{t(view.reason)}</span>}
    </span>
  );
}
