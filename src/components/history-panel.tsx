'use client';

import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import Link from 'next/link';
import { Drawer } from './drawer';
import { ConfirmDialog } from './confirm-dialog';
import { EmptyState, LoadingState } from './states';
import { Icon } from './icon';
import { SmartImage } from './smart-image';
import {
  db,
  clearAllHistory,
  removeHistory,
  upsertHistory,
  MAX_HISTORY,
  type HistoryEntry,
} from '@/lib/db';
import { buildWatchUrl, cn, formatRelativeTime, formatTime } from '@/lib/utils';
import { useToast } from './toast';
import { resolveSource, useAppStore } from '@/lib/store';
import { useT } from '@/lib/i18n';

/**
 * 观看历史面板（IndexedDB 实时查询）。
 * 与旧版的区别：播放前按需重新拉取剧集详情，不再依赖历史记录里冗余存储的全集 URL。
 * 破坏性操作分级：清空全部走确认弹窗，删除单条支持撤销。
 */

/** 未搜索时列表默认展示的条数（DB 实存 MAX_HISTORY 条，其余靠搜索查阅） */
const VISIBLE_LIMIT = 50;

export function HistoryPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  // 全量读取（上限即 DB 淘汰上限）：默认只渲染最近若干条，搜索时覆盖更早的记录
  const history = useLiveQuery(
    () => db.history.orderBy('timestamp').reverse().limit(MAX_HISTORY).toArray(),
    [open]
  );
  const { toast } = useToast();
  const t = useT();
  const [confirmClear, setConfirmClear] = useState(false);
  const [query, setQuery] = useState('');

  // 关闭后重置搜索词：下次打开回到完整列表，不残留上次的过滤状态
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const keyword = query.trim().toLowerCase();
  const visible = useMemo(() => {
    const all = history ?? [];
    if (!keyword) return all.slice(0, VISIBLE_LIMIT);
    return all.filter((h) => h.title.toLowerCase().includes(keyword));
  }, [history, keyword]);

  const total = history?.length ?? 0;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={t('观看历史')}
      width="max-w-lg"
      // 搜索框放在固定副标题栏：历史较长时滚动列表仍可随时改关键字
      subheader={
        total > 0 ? (
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Icon
                name="search"
                className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-faint pointer-events-none"
              />
              <input
                type="text"
                className="w-full h-9 pl-8 pr-8 rounded-lg border border-line bg-chip text-sm text-content placeholder:text-faint focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/40"
                placeholder={t('搜索观看历史...')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label={t('搜索观看历史')}
              />
              {query && (
                <button
                  type="button"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded-full text-faint hover:text-content hover:bg-hover transition-colors"
                  onClick={() => setQuery('')}
                  aria-label={t('清空搜索')}
                >
                  <Icon name="close" className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            <button
              className="shrink-0 px-2 py-1.5 rounded-md text-xs text-faint hover:text-danger hover:bg-hover transition-colors"
              onClick={() => setConfirmClear(true)}
            >
              {t('清空历史')}
            </button>
          </div>
        ) : undefined
      }
    >
      {!history ? (
        <LoadingState />
      ) : total === 0 ? (
        <EmptyState variant="plain" title={t('暂无观看记录')} />
      ) : visible.length === 0 ? (
        <EmptyState variant="plain" title={t('没有匹配「{q}」的观看记录', { q: query.trim() })} />
      ) : (
        <>
          {!keyword && total > VISIBLE_LIMIT && (
            <p className="text-xs text-faint mb-2">
              {t('共 {total} 条记录，仅显示最近 {limit} 条，可用上方搜索查找更早的记录', { total, limit: VISIBLE_LIMIT })}
            </p>
          )}
          <ul className="space-y-2">
            {visible.map((item) => (
              <HistoryItem key={`${item.sourceKey}_${item.vodId}`} item={item} />
            ))}
          </ul>
        </>
      )}

      {/* 重操作：清空不可撤销，先确认并说明数量 */}
      <ConfirmDialog
        open={confirmClear}
        danger
        title={t('清空全部观看历史？')}
        message={history ? t('将删除 {n} 条观看记录，此操作不可撤销。', { n: history.length }) : undefined}
        confirmLabel={t('清空')}
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          void clearAllHistory().then(() => toast(t('观看历史已清空'), 'success'));
          setConfirmClear(false);
        }}
      />
    </Drawer>
  );
}

function HistoryItem({ item }: { item: HistoryEntry }) {
  // 精确订阅：整份 useAppStore() 会让每条历史在任意 store 变化（搜索健康度、测活写回等）时重渲染
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const { toast } = useToast();
  const t = useT();
  const [imgFailed, setImgFailed] = useState(false);
  const source = resolveSource({ customAPIs, envSources }, item.sourceKey);

  const hasPercent =
    item.playbackPosition > 10 && item.duration > 0 && item.playbackPosition < item.duration * 0.95;
  const percent = hasPercent ? Math.round((item.playbackPosition / item.duration) * 100) : 0;

  const href = buildWatchUrl({
    sourceKey: item.sourceKey,
    vodId: item.vodId,
    index: item.episodeIndex,
    title: item.title,
    sourceUrl: source?.url,
    detail: source?.detail,
  });

  const remove = () => {
    void removeHistory(item.sourceKey, item.vodId).then(() => {
      // 轻操作：给撤销窗口，恢复时写回原记录
      toast(t('已删除该记录'), 'info', {
        action: {
          label: t('撤销'),
          onClick: () => {
            void upsertHistory({
              sourceKey: item.sourceKey,
              sourceUrl: item.sourceUrl,
              vodId: item.vodId,
              title: item.title,
              pic: item.pic,
              episodeIndex: item.episodeIndex,
              totalEpisodes: item.totalEpisodes,
              playbackPosition: item.playbackPosition,
              duration: item.duration,
              timestamp: item.timestamp,
            }).then(() => toast(t('已恢复'), 'success'));
          },
        },
      });
    });
  };

  return (
    <li className="relative group">
      <Link
        href={href}
        onClick={() => {
          // 点击即同步一次时间戳，置顶最近观看
          upsertHistory({ ...item, timestamp: Date.now() }).catch(() => {});
        }}
        className="block bg-card hover:bg-hover rounded-lg p-3 pr-10 transition-colors"
      >
        <div className="flex items-center gap-3">
          {item.pic && !imgFailed ? (
            <SmartImage
              url={item.pic}
              mode={imageProxyMode}
              customProxy={customImageProxy}
              alt=""
              className="w-10 h-14 object-cover rounded bg-chip"
              onExhausted={() => setImgFailed(true)}
            />
          ) : (
            <div className="w-10 h-14 rounded bg-chip flex items-center justify-center shrink-0">
              <svg className="w-4 h-4 text-faint" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 4v16m10-16v16M7 8h10M7 12h10" />
              </svg>
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-content truncate">{item.title}</div>
            <div className="text-xs text-faint mt-0.5 flex items-center gap-1.5 flex-wrap">
              {item.totalEpisodes > 0 && <span>{t('第 {cur}/{total} 集', { cur: item.episodeIndex + 1, total: item.totalEpisodes })}</span>}
              {hasPercent && <span>· {formatTime(item.playbackPosition)}</span>}
              <span>· {formatRelativeTime(item.timestamp)}</span>
            </div>
            {hasPercent && (
              <div className="mt-1.5 h-1 bg-hover rounded-full overflow-hidden">
                <div className="h-full bg-accent" style={{ width: `${percent}%` }} />
              </div>
            )}
          </div>
        </div>
      </Link>
      <button
        className={cn(
          'absolute right-2 top-2 p-2 rounded-full text-faint hover:text-danger',
          'opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity'
        )}
        aria-label={t('删除记录')}
        title={t('删除记录（可在提示中撤销）')}
        onClick={remove}
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </li>
  );
}
