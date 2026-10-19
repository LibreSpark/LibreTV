'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '@/lib/utils';
import { SmartImage } from './smart-image';
import { Dropdown } from './dropdown';
import { useAppStore } from '@/lib/store';
import {
  isSlowSource,
  matchesAlive,
  matchesKeyword,
  normalizeForSearch,
  sortChannels,
  type AliveFilter,
  type LiveSortMode,
} from '@/lib/live-channel-filter';
import { useLiveProbe, type ProbeResult } from './use-live-probe';
import type { LiveChannel } from '@/lib/types';
import { EmptyState } from './states';
import { tr, useT } from '@/lib/i18n';

/**
 * 直播频道侧栏：全部/收藏/最近三个视图 + 分组横向标签条 + 关键字搜索 + 排序。
 * - 搜索对分隔符归一化（cctv1 命中 CCTV-1），并匹配分组名；输入防抖后过滤；
 * - 可用性两档筛选（绿点=分片级验证 / 可播=含弱验证）；
 * - 支持批量测活：频道名前显示可达性状态点；
 * - 虚拟列表（@tanstack/react-virtual）：仅渲染可视区内的频道行，数千频道下 DOM 恒定，
 *   电视盒子 / 低端设备滑动不掉帧；行高动态测量（有无分组名两档）；
 * - 键盘：容器聚焦后 ↑↓ 移动光标、Enter 播放；
 * - 性能：本组件与 ChannelRow 均精确订阅 store，探测节流写回不会全列表重渲染。
 */

const SEARCH_DEBOUNCE_MS = 200;

/** 测活进度文案：按已完成均速估算剩余时间（长尾在途期间由每秒 tick 重渲染保持走动） */
function formatProbeProgress(p: { done: number; total: number; startedAt: number }): string {
  const base = `${p.done}/${p.total}`;
  const remaining = p.total - p.done;
  if (remaining <= 0) return base;
  if (p.done <= 0) return `${base} · ${tr('估算中…')}`;
  const remainMin = Math.ceil(((Date.now() - p.startedAt) / p.done) * remaining / 60000);
  return `${base} · ${tr('预计剩余 {n} 分钟', { n: Math.max(1, remainMin) })}`;
}

export interface LiveChannelItem extends LiveChannel {
  /** 来源订阅的 EPG 地址（用于节目单查询） */
  epg?: string;
  /** 所属直播源地址（M3U 订阅 URL），写入最近观看以便订阅删除时清理 */
  sourceUrl?: string;
}

interface ChannelListProps {
  channels: LiveChannelItem[];
  groups: string[];
  currentUrl: string;
  onSelect: (channel: LiveChannelItem) => void;
  /** 筛选+排序结果变化时上报（页面级键盘换台沿此列表顺序切换） */
  onFilteredChange?: (list: LiveChannelItem[]) => void;
}

type View = 'all' | 'fav' | 'recent';

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function LiveChannelList({ channels, groups, currentUrl, onSelect, onFilteredChange }: ChannelListProps) {
  const t = useT();
  // 精确订阅：避免任何 store 字段变化（尤其测活节流写回）引发本组件重渲染
  const liveFavorites = useAppStore((s) => s.liveFavorites);
  const liveRecent = useAppStore((s) => s.liveRecent);
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);

  const [view, setView] = useState<View>('all');
  const [group, setGroup] = useState<string>('');
  const [keyword, setKeyword] = useState('');
  const debouncedKeyword = useDebouncedValue(keyword, SEARCH_DEBOUNCE_MS);
  const [sortMode, setSortMode] = useState<LiveSortMode>('default');
  const [aliveFilter, setAliveFilter] = useState<AliveFilter>('off');
  /** 键盘光标（filtered 的下标），与"正在播放"高亮独立 */
  const [cursor, setCursor] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);
  const {
    results: probeResults,
    progress: probeProgress,
    probe,
    cancel: cancelProbe,
    clear: clearProbe,
    isProbing,
    hint: probeHint,
  } = useLiveProbe();

  // 测活 ETA 每秒刷新：探测长尾（在途请求未返回）期间进度不推进，剩余时间也要走动
  const [, setProbeTick] = useState(0);
  useEffect(() => {
    if (!isProbing) return;
    const timer = setInterval(() => setProbeTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [isProbing]);

  const favSet = useMemo(() => new Set(liveFavorites), [liveFavorites]);
  const recentOrder = useMemo(() => new Map(liveRecent.map((r, i) => [r.url, i] as const)), [liveRecent]);
  const normalizedKeyword = useMemo(() => normalizeForSearch(debouncedKeyword.trim()), [debouncedKeyword]);

  // 先做视图/分组/搜索/排序（不含可用性筛选）：可用性计数必须基于这份列表，
  // 否则点击筛选后 filtered 收缩，两个计数会跟着变小、与实际展示对不上
  const matched = useMemo(() => {
    let list: LiveChannelItem[];
    if (view === 'fav') {
      list = channels.filter((c) => favSet.has(c.url));
    } else if (view === 'recent') {
      // 按最近观看时间倒序
      list = liveRecent
        .map((r) => channels.find((c) => c.url === r.url))
        .filter((c): c is LiveChannelItem => Boolean(c));
    } else {
      list = channels;
    }
    if (view !== 'recent' && group) {
      list = list.filter((c) => c.group === group);
    }
    if (normalizedKeyword) {
      list = list.filter((c) => matchesKeyword(c, normalizedKeyword));
    }
    return sortChannels(list, sortMode, { recentOrder, probeOf: (url) => probeResults.get(url) });
  }, [channels, favSet, liveRecent, view, group, normalizedKeyword, sortMode, recentOrder, probeResults]);

  const filtered = useMemo(
    () =>
      aliveFilter === 'off'
        ? matched
        : matched.filter((c) => matchesAlive(probeResults.get(c.url), aliveFilter)),
    [matched, aliveFilter, probeResults]
  );

  // 上报筛选排序结果给页面（键盘换台用）；列表存父组件 ref，不触发父组件重渲染
  useEffect(() => {
    onFilteredChange?.(filtered);
  }, [filtered, onFilteredChange]);

  // 口径与两个筛选按钮一致：绿点=分片级验证且吞吐达标（排除限速源），可播=任何验证级别通过
  const aliveCounts = useMemo(() => {
    let ok = 0;
    let green = 0;
    for (const c of matched) {
      const p = probeResults.get(c.url);
      if (!p?.ok) continue;
      ok++;
      if (matchesAlive(p, 'green')) green++;
    }
    return { ok, green };
  }, [matched, probeResults]);

  // 键盘/锚定滚动需要按 URL 反查索引；filtered 随测活结果变化（排序含可用性），
  // 用 ref 读取最新值，避免测活写回触发重新锚定打断用户滚动
  const filteredRef = useRef(filtered);
  filteredRef.current = filtered;

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => listRef.current,
    // 行高两档：带分组名的双行 / 无分组名单行（含 4px 行距），measureElement 会修正估值
    estimateSize: (i) => (filtered[i].group ? 51 : 47),
    overscan: 10,
    getItemKey: (i) => filtered[i].url,
  });

  // 切换筛选/排序/频道时：重置键盘光标，并把当前播放频道锚定到可视区（找不到则回顶部）
  useEffect(() => {
    setCursor(-1);
    if (!currentUrl) {
      virtualizer.scrollToOffset(0);
      return;
    }
    const idx = filteredRef.current.findIndex((c) => c.url === currentUrl);
    if (idx >= 0) virtualizer.scrollToIndex(idx, { align: 'auto' });
    else virtualizer.scrollToOffset(0);
  }, [view, group, sortMode, debouncedKeyword, aliveFilter, currentUrl, virtualizer]);

  const scrollToChannelRow = useCallback(
    (url: string) => {
      const idx = filteredRef.current.findIndex((c) => c.url === url);
      if (idx >= 0) virtualizer.scrollToIndex(idx, { align: 'auto' });
    },
    [virtualizer]
  );

  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (filtered.length === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      const base = cursor === -1 ? (delta === 1 ? -1 : 0) : cursor;
      const next = Math.min(Math.max(base + delta, 0), filtered.length - 1);
      setCursor(next);
      virtualizer.scrollToIndex(next, { align: 'auto' });
      return;
    }
    if (e.key === 'Enter' && cursor >= 0 && cursor < filtered.length) {
      // 焦点在行内按钮（收藏/删除）上时，Enter 交给按钮自身
      if ((e.target as HTMLElement).closest('button')) return;
      e.preventDefault();
      onSelect(filtered[cursor]);
    }
  };

  const removeRecent = useCallback((url: string) => {
    useAppStore.getState().removeLiveRecent(url);
  }, []);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 视图 tab */}
      <div className="flex items-center gap-1 px-3 pt-2.5 pb-2 border-b border-line shrink-0">
        {(
          [
            ['all', `${t('全部')}${channels.length ? ` ${channels.length}` : ''}`],
            ['fav', `${t('收藏')}${liveFavorites.length ? ` ${liveFavorites.length}` : ''}`],
            ['recent', t('最近')],
          ] as [View, string][]
        ).map(([v, label]) => (
          <button
            key={v}
            className={cn(
              'px-2.5 py-1 rounded-md text-xs transition-colors',
              view === v ? 'bg-accent/10 text-accent font-medium' : 'text-muted hover:text-content hover:bg-hover'
            )}
            onClick={() => setView(v)}
          >
            {label}
          </button>
        ))}
      </div>

      {/* 搜索 + 排序 */}
      <div className="px-3 py-2 shrink-0 flex items-center gap-1.5">
        <input
          className="input w-full !py-1.5 text-xs"
          placeholder={t('搜索频道 / tvg-id / 分组...')}
          value={keyword}
          maxLength={60}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => {
            // 搜索框内按 ↓ 进入列表光标导航
            if (e.key === 'ArrowDown' && filtered.length > 0) {
              e.preventDefault();
              setCursor(0);
              scrollToChannelRow(filtered[0].url);
              listRef.current?.focus();
            }
          }}
        />
        <Dropdown
          className="shrink-0 [&>button]:!py-1.5 [&>button]:!px-2 [&>button]:text-xs"
          value={sortMode}
          ariaLabel={t('排序方式')}
          onChange={(v) => setSortMode(v as LiveSortMode)}
          options={[
            { value: 'default', label: t('默认') },
            { value: 'name', label: t('名称') },
            { value: 'group', label: t('分组') },
            { value: 'probe', label: t('可用优先') },
            { value: 'recent', label: t('最近看') },
          ]}
        />
      </div>

      {/* 测活 + 可用性筛选工具条 */}
      <div className="flex items-center gap-1.5 px-3 pb-2 shrink-0 flex-wrap">
        <button
          className="btn-ghost btn-sm"
          disabled={isProbing || filtered.length === 0}
          onClick={() => void probe(filtered)}
          title={t('探测当前列表频道是否可播（分片级校验；量大时自动分批排队跑完，结果 6 小时内有效）')}
        >
          {t('测活')}
        </button>
        {/* 同一操作位按时机切换：测活中=取消（保留已完成结果）；空闲且有结果=清除全部 */}
        {isProbing ? (
          <button
            className="btn-ghost btn-sm"
            onClick={cancelProbe}
            title={t('中止本次测活，已完成的结果会保留')}
          >
            {t('取消')}
          </button>
        ) : (
          probeResults.size > 0 && (
            <button
              className="btn-ghost btn-sm"
              onClick={() => {
                clearProbe();
                setAliveFilter('off');
              }}
              title={t('清除全部测活结果，并取消可用性筛选')}
            >
              {t('清除')}
            </button>
          )
        )}
        {isProbing && probeProgress && (
          <span className="text-[10px] text-faint whitespace-nowrap">
            {t('探测中')} {formatProbeProgress(probeProgress)}
          </span>
        )}
        {probeHint && (
          <span className="text-[10px] text-faint">{probeHint}</span>
        )}
        {probeResults.size > 0 && !isProbing && (
          <>
            <button
              className={cn(
                'shrink-0 px-2 py-0.5 rounded-full text-[10px] whitespace-nowrap transition-colors border',
                aliveFilter === 'green'
                  ? 'bg-accent text-on-accent border-accent'
                  : 'bg-chip text-muted border-line hover:text-content hover:bg-hover'
              )}
              onClick={() => setAliveFilter((v) => (v === 'green' ? 'off' : 'green'))}
              title={t('只看分片级验证通过的频道')}
            >
              {t('绿点')} {aliveCounts.green}
            </button>
            <button
              className={cn(
                'shrink-0 px-2 py-0.5 rounded-full text-[10px] whitespace-nowrap transition-colors border',
                aliveFilter === 'ok'
                  ? 'bg-accent text-on-accent border-accent'
                  : 'bg-chip text-muted border-line hover:text-content hover:bg-hover'
              )}
              onClick={() => setAliveFilter((v) => (v === 'ok' ? 'off' : 'ok'))}
              title={t('看所有验证通过（含直链/清单级弱验证）的频道')}
            >
              {t('可播')} {aliveCounts.ok}
            </button>
          </>
        )}
      </div>

      {/* 分组标签条（横向可滑动） */}
      {view === 'all' && groups.length > 0 && (
        <div className="px-3 pb-2 shrink-0">
          <div className="flex gap-1.5 overflow-x-auto scrollbar-thin pb-1">
            <GroupChip active={!group} label={t('全部分组')} onClick={() => setGroup('')} />
            {groups.map((g) => (
              <GroupChip key={g} active={group === g} label={g} onClick={() => setGroup(g === group ? '' : g)} />
            ))}
          </div>
        </div>
      )}

      {/* 频道列表（容器可聚焦，↑↓/Enter 光标导航） */}
      <div
        ref={listRef}
        data-channel-list
        tabIndex={0}
        onKeyDown={onListKeyDown}
        className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-2 pb-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
      >
        {filtered.length === 0 ? (
          <EmptyState
            variant="plain"
            className="!py-10"
            title={
              view === 'fav'
                ? t('暂无收藏频道，点击频道右侧星标即可收藏')
                : view === 'recent'
                  ? t('暂无观看记录')
                  : channels.length === 0
                    ? t('暂无频道，请先在设置中添加直播源')
                    : aliveFilter !== 'off' && probeResults.size > 0
                      ? t('没有匹配该可用性的频道，可放宽或清除筛选')
                      : t('没有匹配的频道')
            }
          />
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((vi) => (
              <div
                key={vi.key}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${vi.start}px)`,
                  // 原 space-y-1 的 4px 行距；padding 计入 measureElement 量得的高度
                  paddingBottom: 4,
                }}
              >
                <ChannelRow
                  channel={filtered[vi.index]}
                  active={filtered[vi.index].url === currentUrl}
                  cursor={cursor === vi.index}
                  isFav={favSet.has(filtered[vi.index].url)}
                  probe={probeResults.get(filtered[vi.index].url)}
                  logo={filtered[vi.index].logo}
                  imageProxyMode={imageProxyMode}
                  customProxy={customImageProxy}
                  onSelect={onSelect}
                  onRemoveRecent={view === 'recent' ? removeRecent : undefined}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function GroupChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      className={cn(
        'shrink-0 px-2.5 py-1 rounded-full text-xs whitespace-nowrap transition-colors border',
        active
          ? 'bg-accent text-on-accent border-accent'
          : 'bg-chip text-muted border-line hover:text-content hover:bg-hover'
      )}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

const ChannelRow = memo(function ChannelRow({
  channel,
  active,
  cursor,
  isFav,
  probe,
  logo,
  imageProxyMode,
  customProxy,
  onSelect,
  onRemoveRecent,
}: {
  channel: LiveChannelItem;
  active: boolean;
  cursor: boolean;
  isFav: boolean;
  probe?: ProbeResult;
  logo?: string;
  imageProxyMode: 'direct' | 'proxy' | 'custom';
  customProxy: string;
  onSelect: (channel: LiveChannelItem) => void;
  /** 仅最近视图传入：删除该条观看记录 */
  onRemoveRecent?: (url: string) => void;
}) {
  const t = useT();
  const [logoFailed, setLogoFailed] = useState(false);
  // 虚拟列表会复用行实例：换台（logo 变化）时重置失败态，避免下一个频道误显首字母
  useEffect(() => setLogoFailed(false), [logo]);
  // H.265/HEVC：国内 IPTV 常见，测活通过但 Chromium 内核通常无法软解
  const isHevc = Boolean(probe?.codec && /hvc1|hev1|hevc/i.test(probe.codec));
  // 源限速：分片可达但吞吐不足，绿点却播不了的主因
  const slow = isSlowSource(probe);
  // 状态点语义：绿=分片级验证且吞吐达标；琥珀=限速/弱验证（直链/清单级）或超时；红=不可达
  const weakLevel = probe?.ok && probe.level !== 'segment';
  const amber = Boolean(probe && (weakLevel || (!probe.ok && probe.timedOut) || slow));
  const dotClass = amber ? 'bg-warning' : probe?.ok ? 'bg-success' : 'bg-danger';
  const levelText =
    probe?.level === 'segment'
      ? t('分片可用')
      : probe?.level === 'head'
        ? t('直链可达（未验证可播性）')
        : t('播放列表可达（无分片，未验证可播）');
  const speedText =
    probe?.kbps != null && probe.level === 'segment'
      ? ` · ≈${probe.kbps >= 1000 ? `${(probe.kbps / 1000).toFixed(1)}Mbps` : `${probe.kbps}kbps`}`
      : '';
  const probeTitle = probe
    ? probe.ok
      ? slow
        ? t('源限速{speed}，缓冲跟不上，可能无法流畅播放', { speed: speedText.replace(' · ', ' ') })
        : `${levelText}${speedText}${probe.ms != null && probe.level === 'segment' ? ` · ${t('延迟 {ms}ms', { ms: probe.ms })}` : ''}${isHevc ? ` · ${t('H.265 编码，需 Edge/Safari')}` : ''}`
      : probe.timedOut
        ? `${t(probe.error || '探测超时')} · ${t('源可能只是慢，可直接试播确认')}`
        : t(probe.error || '不可用')
    : undefined;

  return (
    <div data-url={channel.url}>
      {/* 不用 role="button"：行内含收藏/删除等真实按钮，嵌套 button 角色语义非法；
          键盘操作由外层列表容器的 ↑↓ 导航提供 */}
      <div
        className={cn(
          'group flex items-center gap-2.5 px-2 py-2 rounded-md cursor-pointer transition-colors relative',
          active ? 'bg-accent/10' : 'hover:bg-hover',
          cursor && 'ring-1 ring-accent/70'
        )}
        onClick={() => onSelect(channel)}
      >
        {/* 当前播放高亮竖条 */}
        <span
          className={cn(
            'absolute left-0 top-1/2 -translate-y-1/2 w-[3px] rounded-full bg-accent transition-all duration-200',
            active ? 'h-5 opacity-100' : 'h-0 opacity-0'
          )}
        />
        {/* 台标 */}
        <div className="w-7 h-7 shrink-0 rounded bg-chip flex items-center justify-center overflow-hidden">
          {logo && !logoFailed ? (
            <SmartImage
              url={logo}
              mode={imageProxyMode}
              customProxy={customProxy}
              alt=""
              className="w-full h-full object-contain"
              onExhausted={() => setLogoFailed(true)}
            />
          ) : (
            <span className="text-[10px] text-faint">{channel.name.slice(0, 1)}</span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            {probe && (
              <span
                className={cn('w-1.5 h-1.5 rounded-full shrink-0', dotClass)}
                title={probeTitle}
              />
            )}
            <span className={cn('text-xs truncate', active ? 'text-accent font-medium' : 'text-content')}>
              {channel.name}
            </span>
            {isHevc && (
              <span
                className="shrink-0 rounded-full bg-warning/15 px-1.5 text-[10px] font-medium text-warning"
                title={t('H.265 编码：测活通过但 Chromium 内核通常无法解码，建议用 Edge/Safari')}
              >
                H.265
              </span>
            )}
          </div>
          {channel.group && (
            <div className="text-[10px] text-faint truncate">{channel.group}</div>
          )}
        </div>
        {/* 最近观看单条删除（仅最近视图；移动端常显） */}
        {onRemoveRecent && (
          <button
            className={cn(
              'shrink-0 p-1 rounded transition-colors',
              'text-faint/60 opacity-60 lg:opacity-0 lg:group-hover:opacity-100 hover:text-danger'
            )}
            aria-label={t('删除该观看记录')}
            title={t('删除该观看记录')}
            onClick={(e) => {
              e.stopPropagation();
              onRemoveRecent(channel.url);
            }}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
        {/* 收藏星标（移动端常显，桌面 hover 出现） */}
        <button
          className={cn(
            'shrink-0 p-1 rounded transition-transform active:scale-125',
            isFav
              ? 'text-warning'
              : 'text-faint/60 opacity-60 lg:opacity-0 lg:group-hover:opacity-100 hover:text-warning'
          )}
          aria-label={isFav ? t('取消收藏') : t('收藏')}
          title={isFav ? t('取消收藏') : t('收藏')}
          onClick={(e) => {
            e.stopPropagation();
            // 点击时读取最新状态：行组件不订阅 store，保证探测期间的重渲染隔离
            useAppStore.getState().toggleLiveFavorite(channel.url);
          }}
        >
          <svg className="w-3.5 h-3.5" fill={isFav ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.196-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.783-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"
            />
          </svg>
        </button>
      </div>
    </div>
  );
});
