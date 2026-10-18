'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/client-api';
import type { SourceConfig, SearchResultItem } from '@/lib/types';
import { buildWatchUrl, cn } from '@/lib/utils';
import { useAppStore, resolveSource } from '@/lib/store';
import { useToast } from './toast';
import { Icon } from './icon';
import { SmartImage } from './smart-image';
import { EmptyState, LoadingState } from './states';
import { useFocusTrap } from './use-focus-trap';

/**
 * 换源面板：跨源按标题搜索 → 匹配同名/同前缀资源 → 并发测速（详情接口耗时）→ 按速度排序展示。
 * 切换时保留当前集数索引（旧版 switchToResource 逻辑的去 DOM 化重写）。
 */

interface Candidate {
  source: SourceConfig;
  result: SearchResultItem;
  ms?: number;
  ok?: boolean;
  episodes?: number;
}

export function SwitchSourceModal({
  currentTitle,
  currentSourceKey,
  currentVodId,
  currentIndex,
  onClose,
}: {
  currentTitle: string;
  currentSourceKey: string;
  currentVodId: string;
  currentIndex: number;
  onClose: () => void;
}) {
  const store = useAppStore();
  const router = useRouter();
  const { toast } = useToast();
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [phase, setPhase] = useState<'searching' | 'testing' | 'done'>('searching');
  /** 封面加载失败记录（按卡片 key）；失败后降级为占位图标，避免破图 */
  const [imgFailed, setImgFailed] = useState<Record<string, boolean>>({});
  const [selectedTab, setSelectedTab] = useState(-1);
  const panelRef = useRef<HTMLDivElement>(null);
  const tabBarRef = useRef<HTMLDivElement>(null);

  // 打开时把焦点移入弹窗、Tab 圈闭在弹窗内、关闭后归还焦点
  useFocusTrap(true, panelRef);

  const sources = useMemo(() => {
    // selectedKeys 可能含历史残留的重复 key：按 key 去重，避免同源重复搜索/测速与 React key 撞车
    const seen = new Set<string>();
    return store.selectedKeys
      .map((key) => resolveSource(store, key))
      .filter((s): s is SourceConfig => {
        if (!s || seen.has(s.key)) return false;
        seen.add(s.key);
        return true;
      });
  }, [store]);

  useEffect(() => {
    // 弹窗打开期间锁定背景滚动；Esc 关闭（与其它弹窗一致）
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  useEffect(() => {
    // 关闭弹窗时中止在途请求：否则 N 个源的搜索 + N 个详情测速会继续占用网络与后端
    const controller = new AbortController();
    let cancelled = false;

    (async () => {
      // 1) 并行搜索所有选中源
      setPhase('searching');
      try {
        const { list } = await api.search(currentTitle, sources, store.yellowFilter, { signal: controller.signal });
        if (cancelled) return;

        // 匹配口径：优先完全同名，其次名称以标题开头（兼容「小偷 HD」「小偷[电影解说]」这类修饰名）。
        // 都没有则不展示该源——不再兜底取搜索第一条，避免把搜到的其他影片（如搜「小偷」
        // 命中的《宝贝 小偷与大盗》）误当成换源目标。
        const title = currentTitle.trim();
        const matched: Candidate[] = [];
        for (const s of sources) {
          const hits = list.filter((r) => r.sourceKey === s.key);
          const exact =
            hits.find((r) => (r.name || '').trim() === title) ??
            hits.find((r) => (r.name || '').trim().startsWith(title));
          if (exact) matched.push({ source: s, result: exact });
        }

        // 2) 并发测速（详情接口耗时）并获取集数
        setPhase('testing');
        await Promise.all(
          matched.map(async (c) => {
            const r = await api.detailSpeed(c.result.vodId, c.source, controller.signal);
            if (cancelled) return;
            c.ok = r.ok;
            c.ms = r.ms;
            c.episodes = r.detail?.episodes.length ?? 0;
          })
        );
        if (cancelled) return;
        setCandidates(matched);
        setPhase('done');
      } catch (err) {
        // 主动中止不算失败，不提示
        const aborted = err instanceof DOMException && err.name === 'AbortError';
        if (!cancelled && !aborted) {
          toast(err instanceof Error ? err.message : '换源搜索失败', 'error');
          setPhase('done');
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTitle, store.yellowFilter]);

  const sorted = useMemo(() => [...candidates].sort((a, b) => {
    const aCurrent = a.source.key === currentSourceKey && String(a.result.vodId) === String(currentVodId);
    const bCurrent = b.source.key === currentSourceKey && String(b.result.vodId) === String(currentVodId);
    if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
    const msA = a.ok ? a.ms ?? 99_999 : 99_999;
    const msB = b.ok ? b.ms ?? 99_999 : 99_999;
    return msA - msB;
  }), [candidates, currentSourceKey, currentVodId]);

  // 默认展开第一个可用的非当前源
  useEffect(() => {
    if (phase !== 'done' || sorted.length === 0 || selectedTab >= 0) return;
    const idx = sorted.findIndex(c =>
      c.ok && !(c.source.key === currentSourceKey && String(c.result.vodId) === String(currentVodId))
    );
    const target = idx >= 0 ? idx : 0;
    setSelectedTab(target);
    requestAnimationFrame(() => {
      const el = tabBarRef.current?.children[target] as HTMLElement | undefined;
      el?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    });
  }, [phase, sorted, selectedTab, currentSourceKey, currentVodId]);

  const switchTo = (c: Candidate) => {
    if (!c.episodes) {
      toast('该源无可用播放资源', 'warning');
      return;
    }
    const targetIndex = currentIndex < c.episodes ? currentIndex : 0;
    onClose(); // 先关闭面板，避免路由参数变化后弹窗残留旧数据
    router.push(
      buildWatchUrl({
        sourceKey: c.source.key,
        vodId: c.result.vodId,
        index: targetIndex,
        title: c.result.name || currentTitle,
        sourceUrl: c.source.url,
        detail: c.source.detail,
      })
    );
  };

  return (
    <div
      className="fixed inset-0 z-[65] flex items-start justify-center overflow-y-auto bg-black/80 py-10 px-4 animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="bg-surface-raised rounded-xl w-full max-w-3xl shadow-2xl p-5 animate-slide-up outline-none"
        role="dialog"
        aria-modal="true"
        aria-label={`换源：${currentTitle}`}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-content truncate" title={currentTitle}>
              {currentTitle}
            </h2>
            <p className="text-xs text-faint">
              {phase === 'searching'
                ? '正在搜索各资源...'
                : phase === 'testing'
                  ? '正在测试各资源速率...'
                  : `共 ${sorted.length} 个来源 · ${sorted.filter((c) => c.ok).length} 个可用`}
            </p>
          </div>
          <button className="p-1.5 rounded-md text-muted hover:text-content hover:bg-hover" onClick={onClose} aria-label="关闭">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {phase !== 'done' ? (
          <LoadingState label={phase === 'searching' ? '搜索各资源中...' : '测速中...'} />
        ) : sorted.length === 0 ? (
          <EmptyState variant="plain" title="其他点播源未找到同名资源" />
        ) : (
          <>
            {/* 横向可滑动 Tab 标签栏 */}
            <div ref={tabBarRef} className="flex gap-2 overflow-x-auto pb-2 scrollbar-thin">
              {sorted.map((c, i) => {
                const isCurrent = c.source.key === currentSourceKey && String(c.result.vodId) === String(currentVodId);
                return (
                  <button
                    key={`${c.source.key}_${c.result.vodId}`}
                    className={cn(
                      'shrink-0 flex flex-col items-center gap-0.5 px-3 py-2 rounded-lg text-xs transition-colors border-2',
                      selectedTab === i
                        ? 'border-accent bg-accent/10 text-accent'
                        : 'border-transparent bg-chip text-muted hover:bg-hover',
                    )}
                    onClick={() => setSelectedTab(i)}
                  >
                    <span className="font-medium whitespace-nowrap">{c.source.name}</span>
                    <span
                      className={cn(
                        'tag text-[10px]',
                        isCurrent
                          ? 'bg-accent/90 text-on-accent'
                          : !c.ok
                            ? 'bg-danger-solid/85 text-white'
                            : c.ms! > 2000
                              ? 'bg-warning-solid/85 text-white'
                              : 'bg-success-solid/85 text-white',
                      )}
                    >
                      {isCurrent ? '当前' : !c.ok ? '失败' : `${c.ms}ms`}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* 选中源的详情面板 */}
            {selectedTab >= 0 && selectedTab < sorted.length && (() => {
              const c = sorted[selectedTab];
              const isCurrent = c.source.key === currentSourceKey && String(c.result.vodId) === String(currentVodId);
              const cardKey = `${c.source.key}_${c.result.vodId}`;
              const coverFailed = imgFailed[cardKey] ?? false;
              return (
                <div className="mt-3 flex items-start gap-4 p-4 bg-card rounded-lg">
                  <div className="shrink-0 w-28 aspect-[2/3] rounded-lg overflow-hidden bg-chip">
                    {c.result.pic && !coverFailed ? (
                      <SmartImage
                        url={c.result.pic}
                        mode={store.imageProxyMode}
                        customProxy={store.customImageProxy}
                        alt={c.result.name}
                        className="w-full h-full object-cover"
                        onExhausted={() => setImgFailed((prev) => ({ ...prev, [cardKey]: true }))}
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-faint">
                        <Icon name="link" className="w-6 h-6" />
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="text-base font-semibold text-content">{c.source.name}</h3>
                    <p className="text-sm text-muted mt-0.5 truncate" title={c.result.name}>{c.result.name}</p>
                    <div className="mt-2 text-xs text-faint space-y-1">
                      <p>
                        响应速度：
                        <span className={cn(!c.ok ? 'text-danger' : c.ms! > 2000 ? 'text-warning' : 'text-success')}>
                          {c.ok ? `${c.ms}ms` : '不可用'}
                        </span>
                      </p>
                      <p>集数：{c.episodes ? `${c.episodes} 集` : '无资源'}</p>
                    </div>
                    {isCurrent ? (
                      <span className="inline-block mt-3 px-3 py-1.5 text-xs rounded-md bg-accent/10 text-accent font-medium">当前播放中</span>
                    ) : (
                      <button className="mt-3 btn-primary btn-sm" disabled={!c.ok || !c.episodes} onClick={() => switchTo(c)}>
                        切换到此源
                      </button>
                    )}
                  </div>
                </div>
              );
            })()}
          </>
        )}
      </div>
    </div>
  );
}
