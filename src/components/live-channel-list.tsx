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

/**
 * 直播频道侧栏：全部/收藏/最近三个视图 + 分组折叠菜单 + 关键字搜索 + 排序。
 * - 全部视图下是纵向分组列表：点分组行展开其下频道（手风琴，同时只展开一个）；
 *   搜索时改为跨分组扁平结果，收藏/最近视图保持按收藏或最近顺序的扁平列表；
 * - 搜索对分隔符归一化（cctv1 命中 CCTV-1），并匹配分组名；输入防抖后过滤；
 * - 可用性两档筛选（绿点=分片级验证 / 可播=含弱验证）；
 * - 支持批量测活：频道名前显示可达性状态点；
 * - 虚拟列表（@tanstack/react-virtual）：分组行与频道行同一行模型参与虚拟化，
 *   数千频道下 DOM 恒定，电视盒子 / 低端设备滑动不掉帧；行高动态测量；
 * - 键盘：容器聚焦后 ↑↓ 移动行光标、Enter 展开分组或播放频道；
 * - 性能：本组件与 ChannelRow 均精确订阅 store，探测节流写回不会全列表重渲染。
 */

const SEARCH_DEBOUNCE_MS = 200;

/** 测活进度文案：按已完成均速估算剩余时间（长尾在途期间由每秒 tick 重渲染保持走动） */
function formatProbeProgress(p: { done: number; total: number; startedAt: number }): string {
  const base = `${p.done}/${p.total}`;
  const remaining = p.total - p.done;
  if (remaining <= 0) return base;
  if (p.done <= 0) return `${base} · 估算中…`;
  const remainMin = Math.ceil(((Date.now() - p.startedAt) / p.done) * remaining / 60000);
  return `${base} · 预计剩余 ${Math.max(1, remainMin)} 分钟`;
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

/** 列表行模型：分组行（可展开）与频道行共用同一虚拟列表 */
type ListRow =
  | { kind: 'group'; key: string; group: string; label: string; count: number; expanded: boolean }
  | { kind: 'channel'; key: string; channel: LiveChannelItem };

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function LiveChannelList({ channels, groups, currentUrl, onSelect, onFilteredChange }: ChannelListProps) {
  // 精确订阅：避免任何 store 字段变化（尤其测活节流写回）引发本组件重渲染
  const liveFavorites = useAppStore((s) => s.liveFavorites);
  const liveRecent = useAppStore((s) => s.liveRecent);
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);

  const [view, setView] = useState<View>('all');
  /** 当前展开的分组名；null = 全部折叠。同时只展开一个（手风琴） */
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  const debouncedKeyword = useDebouncedValue(keyword, SEARCH_DEBOUNCE_MS);
  const [sortMode, setSortMode] = useState<LiveSortMode>('default');
  const [aliveFilter, setAliveFilter] = useState<AliveFilter>('off');
  /** 键盘光标（rows 的下标，分组行与频道行共用），与"正在播放"高亮独立 */
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

  // 先做视图/搜索/排序（不含可用性筛选）：可用性计数必须基于这份列表，
  // 否则点击筛选后 filtered 收缩，两个计数会跟着变小、与实际展示对不上。
  // 分组筛选不在这里做：分组是折叠菜单的一层结构，由 rows 决定哪些分组展开。
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
    if (normalizedKeyword) {
      list = list.filter((c) => matchesKeyword(c, normalizedKeyword));
    }
    return sortChannels(list, sortMode, { recentOrder, probeOf: (url) => probeResults.get(url) });
  }, [channels, favSet, liveRecent, view, normalizedKeyword, sortMode, recentOrder, probeResults]);

  const filtered = useMemo(
    () =>
      aliveFilter === 'off'
        ? matched
        : matched.filter((c) => matchesAlive(probeResults.get(c.url), aliveFilter)),
    [matched, aliveFilter, probeResults]
  );

  // 上报筛选排序结果给页面（键盘换台用）；列表存父组件 ref，不触发父组件重渲染。
  // 上报的是"全部命中频道"而非仅展开分组内的：页面级 ↑↓ 换台要能跨分组走
  useEffect(() => {
    onFilteredChange?.(filtered);
  }, [filtered, onFilteredChange]);

  /** 全部视图且无关键字时按分组折叠展示；收藏/最近/搜索结果保持扁平列表 */
  const accordion = view === 'all' && !normalizedKeyword;

  const rows = useMemo<ListRow[]>(() => {
    if (!accordion) {
      return filtered.map((c) => ({ kind: 'channel' as const, key: c.url, channel: c }));
    }
    // filtered 已按 sortMode 排序：组内保持其相对顺序，组间沿用 groups 的原始顺序
    const byGroup = new Map<string, LiveChannelItem[]>();
    for (const c of filtered) {
      const k = c.group || '';
      const bucket = byGroup.get(k);
      if (bucket) bucket.push(c);
      else byGroup.set(k, [c]);
    }
    // 空分组名（上游没写 group-title）排在最后
    const order = groups.filter((g) => byGroup.has(g));
    if (byGroup.has('')) order.push('');
    // 兜底：filtered 里出现但 groups 未列出的分组，按首次出现顺序补在后面
    for (const k of byGroup.keys()) if (!order.includes(k)) order.push(k);

    const out: ListRow[] = [];
    for (const g of order) {
      const list = byGroup.get(g) ?? [];
      out.push({
        kind: 'group',
        key: `g:${g || '__ungrouped__'}`,
        group: g,
        label: g || '未分组',
        count: list.length,
        expanded: expandedGroup === g,
      });
      if (expandedGroup === g) {
        for (const c of list) out.push({ kind: 'channel', key: c.url, channel: c });
      }
    }
    return out;
  }, [accordion, filtered, groups, expandedGroup]);


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

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => listRef.current,
    // 分组行单行；频道行两档：带分组名的双行 / 无分组名单行（均含 4px 行距），measureElement 会修正
    estimateSize: (i) => {
      const row = rows[i];
      if (!row) return 47;
      return row.kind === 'group' ? 44 : row.channel.group ? 51 : 47;
    },
    overscan: 10,
    getItemKey: (i) => rows[i]?.key ?? i,
  });

  const expandedRef = useRef(expandedGroup);
  expandedRef.current = expandedGroup;

  /**
   * 待滚动目标：只在行模型变化后消费。
   * 展开分组 / 切台都会先改变 expandedGroup，目标行要在下一次渲染才存在，
   * 所以不能当场滚——否则滚的是一份还没有子频道的旧列表。
   */
  const pendingScroll = useRef<{ kind: 'group'; group: string } | { kind: 'channel'; url: string } | null>(null);

  const toggleGroup = useCallback((g: string) => {
    // 展开时把该分组滚到列表顶部（收起不滚，避免列表跳动）；
    // 真正的滚动交给 pendingScroll 消费，此时子频道行还不存在
    const willExpand = expandedRef.current !== g;
    setExpandedGroup(willExpand ? g : null);
    pendingScroll.current = willExpand ? { kind: 'group', group: g } : null;
  }, []);

  // 切换视图/排序/搜索/可用性筛选：回顶部并清光标
  useEffect(() => {
    setCursor(-1);
    pendingScroll.current = null;
    virtualizer.scrollToOffset(0);
  }, [view, sortMode, debouncedKeyword, aliveFilter, virtualizer]);

  // 切台：展开该频道所在分组（否则折叠态下看不到正在播放的行），并把它滚进视野。
  // 只跟随 currentUrl：channels 每次拉取都是新引用，跟着它会覆盖用户手动折叠
  const channelsRef = useRef(channels);
  channelsRef.current = channels;
  useEffect(() => {
    setCursor(-1);
    if (!currentUrl) return;
    const target = channelsRef.current.find((c) => c.url === currentUrl);
    if (target) setExpandedGroup(target.group || '');
    pendingScroll.current = { kind: 'channel', url: currentUrl };
  }, [currentUrl]);

  // 行模型变化后消费待滚动目标：分组滚到列表顶部，频道滚进视野
  useEffect(() => {
    const pending = pendingScroll.current;
    if (!pending) return;
    const idx = rows.findIndex((r) =>
      pending.kind === 'group'
        ? r.kind === 'group' && r.group === pending.group
        : r.kind === 'channel' && r.channel.url === pending.url
    );
    // 目标行还没出现（如分组尚未展开）：保留目标，等下一次 rows 变化
    if (idx < 0) return;
    pendingScroll.current = null;
    virtualizer.scrollToIndex(idx, { align: pending.kind === 'group' ? 'start' : 'auto' });
  }, [rows, virtualizer]);

  const scrollToRow = useCallback(
    (index: number) => {
      if (index >= 0) virtualizer.scrollToIndex(index, { align: 'auto' });
    },
    [virtualizer]
  );

  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (rows.length === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      const base = cursor === -1 ? (delta === 1 ? -1 : 0) : cursor;
      const next = Math.min(Math.max(base + delta, 0), rows.length - 1);
      setCursor(next);
      scrollToRow(next);
      return;
    }
    if (e.key === 'Enter' && cursor >= 0 && cursor < rows.length) {
      // 焦点在行内按钮（收藏/删除）上时，Enter 交给按钮自身
      if ((e.target as HTMLElement).closest('button')) return;
      const row = rows[cursor];
      if (!row) return;
      e.preventDefault();
      if (row.kind === 'group') toggleGroup(row.group);
      else onSelect(row.channel);
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
            ['all', `全部${channels.length ? ` ${channels.length}` : ''}`],
            ['fav', `收藏${liveFavorites.length ? ` ${liveFavorites.length}` : ''}`],
            ['recent', '最近'],
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
          placeholder="搜索频道 / tvg-id / 分组..."
          value={keyword}
          maxLength={60}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => {
            // 搜索框内按 ↓ 进入列表光标导航；落点取第一个频道行
            // （分组行也在 rows 里，第 0 行不一定是频道）
            if (e.key === 'ArrowDown' && rows.length > 0) {
              e.preventDefault();
              const first = rows.findIndex((r) => r.kind === 'channel');
              const target = first >= 0 ? first : 0;
              setCursor(target);
              scrollToRow(target);
              listRef.current?.focus();
            }
          }}
        />
        <Dropdown
          className="shrink-0 [&>button]:!py-1.5 [&>button]:!px-2 [&>button]:text-xs"
          value={sortMode}
          ariaLabel="排序方式"
          onChange={(v) => setSortMode(v as LiveSortMode)}
          options={[
            { value: 'default', label: '默认' },
            { value: 'name', label: '名称' },
            { value: 'group', label: '分组' },
            { value: 'probe', label: '可用优先' },
            { value: 'recent', label: '最近看' },
          ]}
        />
      </div>

      {/* 测活 + 可用性筛选工具条 */}
      <div className="flex items-center gap-1.5 px-3 pb-2 shrink-0 flex-wrap">
        <button
          className="btn-ghost btn-sm"
          disabled={isProbing || filtered.length === 0}
          onClick={() => void probe(filtered)}
          title="探测当前列表频道是否可播（分片级校验；量大时自动分批排队跑完，结果 6 小时内有效）"
        >
          测活
        </button>
        {/* 同一操作位按时机切换：测活中=取消（保留已完成结果）；空闲且有结果=清除全部 */}
        {isProbing ? (
          <button
            className="btn-ghost btn-sm"
            onClick={cancelProbe}
            title="中止本次测活，已完成的结果会保留"
          >
            取消
          </button>
        ) : (
          probeResults.size > 0 && (
            <button
              className="btn-ghost btn-sm"
              onClick={() => {
                clearProbe();
                setAliveFilter('off');
              }}
              title="清除全部测活结果，并取消可用性筛选"
            >
              清除
            </button>
          )
        )}
        {isProbing && probeProgress && (
          <span className="text-[10px] text-faint whitespace-nowrap">
            探测中 {formatProbeProgress(probeProgress)}
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
              title="只看分片级验证通过的频道"
            >
              绿点 {aliveCounts.green}
            </button>
            <button
              className={cn(
                'shrink-0 px-2 py-0.5 rounded-full text-[10px] whitespace-nowrap transition-colors border',
                aliveFilter === 'ok'
                  ? 'bg-accent text-on-accent border-accent'
                  : 'bg-chip text-muted border-line hover:text-content hover:bg-hover'
              )}
              onClick={() => setAliveFilter((v) => (v === 'ok' ? 'off' : 'ok'))}
              title="看所有验证通过（含直链/清单级弱验证）的频道"
            >
              可播 {aliveCounts.ok}
            </button>
          </>
        )}
      </div>

      {/* 频道/分组列表（容器可聚焦，↑↓/Enter 光标导航） */}
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
                ? '暂无收藏频道，点击频道右侧星标即可收藏'
                : view === 'recent'
                  ? '暂无观看记录'
                  : channels.length === 0
                    ? '暂无频道，请先在设置中添加直播源'
                    : aliveFilter !== 'off' && probeResults.size > 0
                      ? '没有匹配该可用性的频道，可放宽或清除筛选'
                      : '没有匹配的频道'
            }
          />
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const row = rows[vi.index];
              if (!row) return null;
              return (
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
                  {row.kind === 'group' ? (
                    <GroupRow
                      label={row.label}
                      count={row.count}
                      expanded={row.expanded}
                      cursor={cursor === vi.index}
                      onClick={() => toggleGroup(row.group)}
                    />
                  ) : (
                    <ChannelRow
                      channel={row.channel}
                      active={row.channel.url === currentUrl}
                      cursor={cursor === vi.index}
                      isFav={favSet.has(row.channel.url)}
                      probe={probeResults.get(row.channel.url)}
                      logo={row.channel.logo}
                      imageProxyMode={imageProxyMode}
                      customProxy={customImageProxy}
                      onSelect={onSelect}
                      onRemoveRecent={view === 'recent' ? removeRecent : undefined}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** 分组行：纵向分组菜单的一行，点击展开/折叠其下的频道 */
function GroupRow({
  label,
  count,
  expanded,
  cursor,
  onClick,
}: {
  label: string;
  count: number;
  expanded: boolean;
  cursor: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      className={cn(
        'w-full flex items-center gap-2 px-2 py-2 rounded-md text-left transition-colors',
        expanded ? 'bg-accent/10' : 'hover:bg-hover',
        cursor && 'ring-1 ring-accent/70'
      )}
      onClick={onClick}
    >
      <svg
        className={cn('w-3.5 h-3.5 shrink-0 text-muted transition-transform', expanded && 'rotate-90')}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        aria-hidden="true"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
      </svg>
      <span className="flex-1 min-w-0 truncate text-xs font-medium text-content">{label}</span>
      <span className="shrink-0 text-[10px] text-faint tabular-nums">{count}</span>
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
      ? '分片可用'
      : probe?.level === 'head'
        ? '直链可达（未验证可播性）'
        : '播放列表可达（无分片，未验证可播）';
  const speedText =
    probe?.kbps != null && probe.level === 'segment'
      ? ` · ≈${probe.kbps >= 1000 ? `${(probe.kbps / 1000).toFixed(1)}Mbps` : `${probe.kbps}kbps`}`
      : '';
  const probeTitle = probe
    ? probe.ok
      ? slow
        ? `源限速${speedText.replace(' · ', ' ')}，缓冲跟不上，可能无法流畅播放`
        : `${levelText}${speedText}${probe.ms != null && probe.level === 'segment' ? ` · 延迟 ${probe.ms}ms` : ''}${isHevc ? ' · H.265 编码，需 Edge/Safari' : ''}`
      : probe.timedOut
        ? `${probe.error || '探测超时'} · 源可能只是慢，可直接试播确认`
        : probe.error || '不可用'
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
                title="H.265 编码：测活通过但 Chromium 内核通常无法解码，建议用 Edge/Safari"
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
            aria-label="删除该观看记录"
            title="删除该观看记录"
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
          aria-label={isFav ? '取消收藏' : '收藏'}
          title={isFav ? '取消收藏' : '收藏'}
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
