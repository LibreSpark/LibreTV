'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import { cn } from '@/lib/utils';
import type { EpgProgram } from '@/lib/types';
import { EmptyState, ErrorState, Spinner } from './states';
import { useT } from '@/lib/i18n';

/**
 * EPG 节目单面板：当前节目（含播放进度条）+ 接下来节目列表 + 简介展开。
 * 仅在频道带 tvg-id 且来源订阅配置了 EPG 地址时查询；无数据优雅降级。
 */

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function LiveEpgPanel({ epgUrl, tvgId }: { epgUrl?: string; tvgId?: string }) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  const [expandedDesc, setExpandedDesc] = useState(false);

  // 30s 心跳刷新进度
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const enabled = Boolean(epgUrl && tvgId);
  const epgQuery = useQuery({
    queryKey: ['liveEpg', epgUrl, tvgId],
    queryFn: ({ signal }) => api.liveEpg(epgUrl!, tvgId!, false, signal),
    enabled,
    staleTime: 10 * 60_000,
  });

  if (!enabled) {
    return (
      <EmptyState
        variant="plain"
        title={t('该频道未配置节目单数据（需来源订阅提供 EPG 地址且频道带 tvg-id）')}
        className="!py-4"
      />
    );
  }

  if (epgQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Spinner size="sm" />
      </div>
    );
  }

  if (epgQuery.isError) {
    return <ErrorState message={t('节目单加载失败')} onRetry={() => epgQuery.refetch()} className="!py-4" />;
  }

  const data = epgQuery.data;
  const current = data?.current;
  const upcoming: EpgProgram[] = (data?.programs ?? []).filter((p) => p.start > now).slice(0, 5);

  const progress = current ? Math.min(100, Math.max(0, ((now - current.start) / (current.stop - current.start)) * 100)) : 0;

  return (
    <div className="space-y-3">
      {current ? (
        <div className="bg-card border border-line rounded-lg p-3">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-[10px] font-semibold text-danger bg-danger/10 px-1.5 py-0.5 rounded-full">
              {t('正在播出')}
            </span>
            <span className="text-[10px] text-faint">
              {fmtTime(current.start)} - {fmtTime(current.stop)}
            </span>
          </div>
          <button
            className="text-sm font-medium text-content w-full text-left"
            aria-expanded={expandedDesc}
            onClick={() => setExpandedDesc((v) => !v)}
          >
            {current.title}
          </button>
          {current.desc && expandedDesc && (
            <p className="text-xs text-muted mt-1.5 leading-relaxed animate-fade-in">{current.desc}</p>
          )}
          {/* 已播进度条 */}
          <div className="mt-2.5 h-1 rounded-full bg-chip overflow-hidden">
            <div
              className="h-full bg-accent rounded-full transition-all duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className="flex justify-between text-[10px] text-faint mt-1">
            <span>{fmtTime(current.start)}</span>
            <span>{Math.round(progress)}%</span>
            <span>{fmtTime(current.stop)}</span>
          </div>
        </div>
      ) : (
        <p className="text-xs text-faint text-center py-2">{t('当前时段暂无节目数据')}</p>
      )}

      {upcoming.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-content mb-1.5">{t('接下来')}</h4>
          <ul className="space-y-1">
            {upcoming.map((p) => (
              <li
                key={`${p.start}-${p.title}`}
                className={cn(
                  'flex items-center gap-2 text-xs px-2 py-1.5 rounded-md',
                  'text-muted hover:bg-hover transition-colors'
                )}
                title={p.desc || p.title}
              >
                <span className="text-faint tabular-nums shrink-0">{fmtTime(p.start)}</span>
                <span className="text-content truncate">{p.title}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
