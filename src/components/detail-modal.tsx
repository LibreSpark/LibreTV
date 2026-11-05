
'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/client-api';
import type { SearchResultItem, VideoDetail } from '@/lib/types';
import { buildWatchUrl } from '@/lib/utils';
import { formatRemarks } from '@/lib/remarks';
import { SmartImage } from './smart-image';
import { useAppStore, resolveSource } from '@/lib/store';
import { useToast } from './toast';
import { cn, validateSourceUrl } from '@/lib/utils';
import { addSearchHistory } from '@/lib/db';
import { copyToClipboard } from '@/lib/clipboard';
import { EmptyState, ErrorState, LoadingState } from './states';
import { useFocusTrap } from './use-focus-trap';
import { Icon } from './icon';

/**
 * 详情弹窗：剧集列表 + 排序 + 复制链接。
 * Friday CMS 优先使用搜索结果携带的 sourceUrl。
 * 剧集点击 → /watch 路由，URL 携带来源定位参数。
 */

export function DetailModal({
  item,
  onClose,
}: {
  item: SearchResultItem | null;
  onClose: () => void;
}) {
  const store = useAppStore();
  const router = useRouter();
  const { toast } = useToast();

  const [detail, setDetail] = useState<VideoDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reversed, setReversed] = useState(false);
  const [posterFailed, setPosterFailed] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useFocusTrap(Boolean(item), panelRef);

  useEffect(() => {
    setPosterFailed(false);
  }, [item?.pic, store.imageProxyMode, store.customImageProxy]);

  // 打开弹窗时锁定背景滚动
  useEffect(() => {
    if (!item) return;

    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = prev;
    };
  }, [item]);

  // 获取详情
  useEffect(() => {
    if (!item) {
      abortRef.current?.abort();
      setDetail(null);
      setError('');
      setLoading(false);
      return;
    }

    abortRef.current?.abort();

    const controller = new AbortController();
    abortRef.current = controller;

    setDetail(null);
    setError('');
    setLoading(true);

    const localSource = resolveSource(store, item.sourceKey);

    let source = localSource;

    // Friday：优先使用当前搜索结果的来源地址。
    // 不继承本地旧 detail，防止 HTML 详情请求串到旧站点。
    if (
      item.sourceKey === 'friday-cms' &&
      typeof item.sourceUrl === 'string' &&
      item.sourceUrl.trim()
    ) {
      const fridayUrl = item.sourceUrl.trim();

      if (!validateSourceUrl(fridayUrl)) {
        setError('Friday CMS 来源地址未通过安全校验');
        setLoading(false);
        return () => controller.abort();
      }

      source = {
        ...(localSource ?? {}),
        key: item.sourceKey,
        name: item.sourceName,
        url: fridayUrl,
        detail: undefined,
      };
    } else if (!source && item.sourceUrl?.trim()) {
      // 其他来源：本地配置不存在时才使用搜索结果地址。
      const fallbackUrl = item.sourceUrl.trim();

      if (!validateSourceUrl(fallbackUrl)) {
        setError('数据源地址未通过安全校验');
        setLoading(false);
        return () => controller.abort();
      }

      source = {
        key: item.sourceKey,
        name: item.sourceName,
        url: fallbackUrl,
      };
    }

    if (!source || !source.url) {
      setError('点播源配置不存在（可能已被删除），请在设置中重新添加');
      setLoading(false);
      return () => controller.abort();
    }

    if (!validateSourceUrl(source.url)) {
      setError('数据源地址未通过安全校验');
      setLoading(false);
      return () => controller.abort();
    }

    api
      .detail(item.vodId, source, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setDetail(result);
      })
      .catch((err) => {
        if (
          err instanceof DOMException &&
          err.name === 'AbortError'
        ) {
          return;
        }

        if (controller.signal.aborted) return;

        setError(
          err instanceof Error
            ? err.message
            : '获取详情失败'
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });

    return () => {
      controller.abort();

      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    };
    // store 的配置变化不应导致同一个详情请求反复触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item]);

  // ESC 关闭弹窗
  useEffect(() => {
    if (!item) return;

    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', handler);

    return () => {
      window.removeEventListener('keydown', handler);
    };
  }, [item, onClose]);

  if (!item) return null;

  const episodes = detail
    ? reversed
      ? [...detail.episodes].reverse()
      : detail.episodes
    : [];

  const info = detail?.videoInfo;

  const play = (index: number) => {
    if (!detail || !detail.episodes[index]) return;

    addSearchHistory(item.name).catch(() => {});

    router.push(
      buildWatchUrl({
        sourceKey: item.sourceKey,
        vodId: item.vodId,
        index,
        title: item.name,
        sourceUrl: item.sourceUrl,
      })
    );
  };

  const copyLinks = async () => {
    if (!detail) return;

    const ok = await copyToClipboard(
      detail.episodes.join('\n')
    );

    if (ok) {
      toast('播放链接已复制', 'success');
    } else {
      toast('复制失败，请检查浏览器权限', 'error');
    }
  };

  const remarks = formatRemarks(info?.remarks);

  const metaRows = [
    info?.typeName && ['类型', info.typeName],
    info?.year && ['年份', info.year],
    info?.area && ['地区', info.area],
    info?.director && ['导演', info.director],
    info?.actor && ['主演', info.actor],
    remarks && ['备注', remarks],
  ].filter(Boolean) as [string, string][];

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/80 py-10 px-4 animate-fade-in"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="bg-surface-raised rounded-xl w-full max-w-3xl shadow-2xl animate-slide-up outline-none"
        role="dialog"
        aria-modal="true"
        aria-label={`${item.name} 详情`}
      >
        <div className="flex items-start justify-between gap-4 p-5 pb-3 border-b border-line">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-content break-words">
              {item.name}
            </h2>

            <span className="text-sm text-faint">
              {item.sourceName}
            </span>
          </div>

          <button
            className="p-1.5 rounded-md text-muted hover:text-content hover:bg-hover shrink-0"
            onClick={onClose}
            aria-label="关闭"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <div className="p-5 pt-4">
          {loading && (
            <LoadingState label="正在获取剧集信息..." />
          )}

          {!loading && error && (
            <ErrorState message={error || '获取失败'} />
          )}

          {!loading && !error && detail && (
            <>
              <div className="flex flex-col sm:flex-row gap-4 mb-4">
                {item.pic && !posterFailed && (
                  <SmartImage
                    url={item.pic}
                    mode={store.imageProxyMode}
                    customProxy={store.customImageProxy}
                    alt={item.name}
                    className="w-24 sm:w-32 aspect-[2/3] object-cover rounded-lg bg-chip shrink-0 self-center sm:self-start"
                    loading="eager"
                    onExhausted={() => setPosterFailed(true)}
                  />
                )}

                <div className="min-w-0 space-y-3">
                  {metaRows.length > 0 && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
                      {metaRows.map(([key, value]) => (
                        <div
                          key={key}
                          className="truncate"
                          title={`${key}: ${value}`}
                        >
                          <span className="text-faint">
                            {key}:
                          </span>{' '}
                          <span className="text-content">
                            {value}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {info?.desc && (
                    <p className="text-sm text-muted leading-relaxed line-clamp-3">
                      {info.desc}
                    </p>
                  )}
                </div>
              </div>

              {episodes.length > 0 ? (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                    <div className="flex items-center gap-2">
                      <button
                        className="btn-ghost btn-sm"
                        onClick={() =>
                          setReversed((value) => !value)
                        }
                        aria-label={
                          reversed
                            ? '切换为正序排列'
                            : '切换为倒序排列'
                        }
                        title="调整剧集列表的排列顺序"
                      >
                        <Icon
                          name="arrowDown"
                          className={cn(
                            'w-3.5 h-3.5 transition-transform',
                            reversed && 'rotate-180'
                          )}
                        />

                        {reversed ? '正序排列' : '倒序排列'}
                      </button>

                      <span className="text-sm text-faint">
                        共 {episodes.length} 集
                      </span>
                    </div>

                    <button
                      className="btn-primary btn-sm"
                      onClick={copyLinks}
                    >
                      复制链接
                    </button>
                  </div>

                  <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-7 gap-2 max-h-[40vh] overflow-y-auto scrollbar-thin pr-1">
                    {episodes.map((_, index) => {
                      const realIndex = reversed
                        ? detail.episodes.length - 1 - index
                        : index;

                      return (
                        <button
                          key={realIndex}
                          className="btn-ghost btn-sm !px-1 text-center"
                          onClick={() => play(realIndex)}
                        >
                          {realIndex + 1}
                        </button>
                      );
                    })}
                  </div>
                </>
              ) : (
                <EmptyState
                  icon="alert"
                  title="未找到播放资源"
                  description="该视频可能暂时无法播放，请尝试其他视频"
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
