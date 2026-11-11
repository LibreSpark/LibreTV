'use client';

import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/lib/store';
import {
  SEGMENT_COLORS,
  SEGMENT_LABELS,
  endingTailSeconds,
  nudgeSegment,
  resolveSegment,
  validateSegment,
  withEndingTail,
  type ResolvedSegment,
  type SkipSegment,
  type SkipSegmentType,
} from '@/lib/skip-marks';
import { cn, formatTime } from '@/lib/utils';
import { useToast } from './toast';
import { Drawer } from './drawer';
import { Icon } from './icon';

/**
 * 播放页的「跳过标记」抽屉。
 *
 * 采集站不提供片头片尾元数据，边界只能由用户在看的时候标记一次，
 * 之后同剧各集与同名资源自动套用。片段按位置归类：opening（片头）、
 * middle（中段）、ending（片尾）。抽屉负责「记录/试跳/微调/删除」，
 * 真正的跳过判定在 player-shell.tsx，存储与校验在 lib/skip-marks.ts。
 *
 * 交互约定：
 * - 抽屉是非模态的：不遮光、不锁滚动、不挡点击。标记的前提是"看着画面记边界"，
 *   模态遮罩会把正在播的视频压暗并吃掉点击，反而没法边看边标；
 * - 手机上（<lg）退化成底部半屏抽屉，并把记录按钮放在 footer 常驻，避免盖住画面、
 *   也避免列表变长后要滚到底才能记一笔；
 * - 记录/试跳前先暂停：点击到读取之间视频还在走，容易偏 1–2 秒；
 * - 片尾记的是「距结尾多长」，列表区间、试跳与高亮都按当前时长倒算起点，
 *   各集时长不一致时也不会出现「短集整条失效 / 长集一路跳到结尾」；
 * - 顶部常驻「当前 12:34 / 45:00」，试跳与微调都有参照；
 * - 中段两步态的起点由播放页持有（pendingStart），与 Shift+S/E 共用同一份状态；
 * - 全局「自动跳过片段」在这里只读展示（层级不同，避免和「本剧跳过」并排成两个 checkbox）。
 */

interface PlayerClock {
  currentTime: number;
  duration: number;
  seek(seconds: number): void;
  pause(): void;
  isPaused(): boolean;
}

const SEGMENT_TYPES: SkipSegmentType[] = ['opening', 'middle', 'ending'];

const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * 列表里一条片段的区间文案。
 * 片尾是「距结尾的长度」，起点每集都不同，只报记录那集的绝对秒数反而误导，
 * 所以报「最后 00:30 · 本集 25:30 起」；历史绝对起点片尾仍报「26:30 → 结尾」。
 * range 为该段在当前这集解析出的区间（时长还没报出来时为 null，退回记录值）。
 */
function describeRange(seg: SkipSegment, range: ResolvedSegment | null): string {
  if (seg.type === 'ending') {
    const tail = endingTailSeconds(seg);
    if (tail !== null) {
      return range ? `最后 ${formatTime(tail)} · 本集 ${formatTime(range.start)} 起` : `最后 ${formatTime(tail)}`;
    }
    return `${formatTime(range?.start ?? seg.start)} → 结尾`;
  }
  const start = range?.start ?? seg.start;
  const end = range?.end ?? seg.end;
  return `${formatTime(start)} → ${formatTime(end)}`;
}

export function SkipMarkPanel({
  open,
  onClose,
  markKey,
  pendingStart,
  onPendingStart,
  getPlayerClock,
  mobileMaxHeight,
}: {
  open: boolean;
  onClose: () => void;
  /** 已归一化的标记键（watch 页按剧名计算） */
  markKey: string;
  /** 中段两步态起点（页面层持有） */
  pendingStart: number | null;
  onPendingStart: (start: number | null) => void;
  /** 读取播放器当前时间/时长/跳转；播放器未就绪时返回 null */
  getPlayerClock: () => PlayerClock | null;
  /**
   * 小屏抽屉的最大高度（px，由播放页按播放器底边算出）：
   * 视口矮、播放器占比大时靠它保证抽屉不压住画面；未传则用默认 60vh。
   */
  mobileMaxHeight?: number;
}) {
  const mark = useAppStore((s) => s.skipMarks[markKey]);
  const setSkipMark = useAppStore((s) => s.setSkipMark);
  const setSkipMarkEnabled = useAppStore((s) => s.setSkipMarkEnabled);
  const autoSkipSegments = useAppStore((s) => s.autoSkipSegments);
  const { toast } = useToast();

  const segments = (mark?.segments ?? []).slice().sort((a, b) => a.start - b.start);
  const enabled = mark ? mark.enabled !== false : false;

  // 当前进度：抽屉打开时每秒刷新一次；用 ref 拿最新的取数函数，避免每秒重置定时器
  const clockFnRef = useRef(getPlayerClock);
  clockFnRef.current = getPlayerClock;
  const [clock, setClock] = useState({ current: 0, duration: 0, paused: true });
  useEffect(() => {
    if (!open) return;
    const tick = () => {
      const c = clockFnRef.current();
      setClock({
        current: c?.currentTime ?? 0,
        duration: c?.duration ?? 0,
        paused: c ? c.isPaused() : true,
      });
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [open]);

  const write = (next: SkipSegment[]) => setSkipMark(markKey, next);

  // 记录/试跳前统一「先暂停再取时间」：暂停后 currentTime 才是用户看到的画面位置
  const pauseAndSnap = (): { t: number; duration: number } | null => {
    const c = getPlayerClock();
    if (!c) {
      toast('播放器尚未就绪，请稍后再试', 'warning');
      return null;
    }
    if (!c.isPaused()) c.pause();
    setClock({ current: c.currentTime, duration: c.duration, paused: true });
    return { t: round1(c.currentTime), duration: c.duration };
  };

  /** 记录一条片段；成功返回 true（失败时保留两步态，用户可以改位置重试） */
  const tryRecord = (raw: SkipSegment, label: string, duration: number): boolean => {
    // 片尾在写入时就换算成「距结尾的长度」：只记绝对起点的话，
    // 下一集时长不同会整条失效（短集）或一路跳到结尾（长集）
    const segment = withEndingTail(raw, duration);
    const error = validateSegment(segment, duration, segments);
    if (error) {
      toast(error, 'error');
      return false;
    }
    write([...segments, segment]);
    const effect = autoSkipSegments
      ? segment.type === 'ending'
        ? '，越过起点后自动结束本集'
        : '，命中时将自动跳过'
      : segment.type === 'ending'
        ? '，命中时显示「跳过片尾」按钮'
        : '，命中时显示跳过按钮';
    const recordedTail = endingTailSeconds(segment);
    const at =
      segment.type === 'ending'
        ? recordedTail !== null
          ? `最后 ${formatTime(recordedTail)}`
          : formatTime(segment.start)
        : segment.type === 'middle'
          ? `${formatTime(segment.start)} → ${formatTime(segment.end)}`
          : formatTime(segment.end);
    toast(`已记录${label} ${at}${effect}`, 'success');
    return true;
  };

  const recordAt = (type: 'opening' | 'ending') => {
    const snap = pauseAndSnap();
    if (!snap) return;
    if (snap.t <= 0) {
      toast(type === 'opening' ? '请先播放到片头结束的位置' : '请先播放到片尾开始的位置', 'warning');
      return;
    }
    if (type === 'opening') tryRecord({ type, start: 0, end: snap.t }, '片头结束', snap.duration);
    else tryRecord({ type, start: snap.t, end: -1 }, '片尾开始', snap.duration);
  };

  const markMiddleStart = () => {
    const snap = pauseAndSnap();
    if (!snap) return;
    if (snap.t <= 0) {
      toast('请先播放到片段起点', 'warning');
      return;
    }
    onPendingStart(snap.t);
    toast(`已暂停并记录起点 ${formatTime(snap.t)}，播放到终点后点「标记中段终点」`, 'info');
  };

  const markMiddleEnd = () => {
    if (pendingStart === null) return;
    const snap = pauseAndSnap();
    if (!snap) return;
    if (snap.t <= pendingStart) {
      toast('终点需晚于起点', 'warning');
      return;
    }
    if (tryRecord({ type: 'middle', start: pendingStart, end: snap.t }, '中段片段', snap.duration)) {
      onPendingStart(null);
    }
  };

  const remove = (index: number) => {
    const seg = segments[index];
    if (!seg) return;
    const wasDisabled = mark?.enabled === false;
    write(segments.filter((_, i) => i !== index));
    // 删除可撤销：误删后不必再拖回原位置重标
    toast(`已删除${SEGMENT_LABELS[seg.type]}片段`, 'info', {
      action: {
        label: '撤销',
        onClick: () => {
          setSkipMark(markKey, segments);
          if (wasDisabled) setSkipMarkEnabled(markKey, false);
        },
      },
    });
  };

  const nudge = (index: number, delta: number) => {
    const seg = segments[index];
    if (!seg) return;
    const clockNow = getPlayerClock();
    const duration = clockNow?.duration ?? 0;
    // 平移规则（含「片尾改的是距结尾长度」与历史绝对起点的顺手换算）在 lib/skip-marks.ts
    const changed = nudgeSegment(seg, delta, duration);
    const others = segments.filter((_, i) => i !== index);
    const error = validateSegment(changed, duration, others);
    if (error) {
      toast(error, 'error');
      return;
    }
    write(segments.map((s, i) => (i === index ? changed : s)));
  };

  /** 试跳：跳到后保持暂停，让用户先确认画面（终点落在片段末尾前 1s） */
  const jump = (seg: SkipSegment, to: 'start' | 'end') => {
    const c = getPlayerClock();
    if (!c) {
      toast('播放器尚未就绪，请稍后再试', 'warning');
      return;
    }
    // 先按本集时长解析区间再跳：片尾起点是倒算的，直接用记录值会跳到别的位置
    const range = resolveSegment(seg, c.duration);
    const start = range?.start ?? seg.start;
    const end = range?.end ?? (seg.type === 'ending' ? c.duration : seg.end);
    const target = to === 'start' ? start : Math.max(0, end - 1);
    c.pause();
    c.seek(target);
    setClock({ current: target, duration: c.duration, paused: true });
  };

  /** 当前播放位置落在哪个片段里：列表里高亮出来，方便核对边界 */
  const currentKey = segments.find((s) => {
    const r = clock.duration > 0 ? resolveSegment(s, clock.duration) : null;
    if (clock.current < (r?.start ?? s.start)) return false;
    if (s.type === 'ending') return true;
    return clock.current < (r?.end ?? s.end);
  });

  return (
    // 桌面端宽度收窄到 320px：播放页右侧剧集栏是 300px，抽屉正好盖住它而不压到视频；
    // 记录区放进 footer 常驻底部：手机上侧栏只占下半屏，滚到列表末尾再点按钮太别扭
    <Drawer
      open={open}
      onClose={onClose}
      title="跳过标记"
      width="max-w-sm lg:max-w-[20rem]"
      modal={false}
      mobileSheet
      panelStyle={mobileMaxHeight ? { maxHeight: mobileMaxHeight } : undefined}
      footer={
        <div>
          <p className="mb-1.5 text-[11px] text-muted">记录（会先暂停在当前画面）</p>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              className="btn-ghost btn-sm"
              title="把当前画面记为片头结束位置"
              onClick={() => recordAt('opening')}
            >
              记为片头结束
            </button>
            <button
              type="button"
              className="btn-ghost btn-sm"
              title="把当前画面记为片尾开始位置（记住的是距结尾多长，各集时长不同也能套用）"
              onClick={() => recordAt('ending')}
            >
              记为片尾开始
            </button>
            {pendingStart === null ? (
              <button type="button" className="btn-ghost btn-sm" onClick={markMiddleStart}>
                标记中段起点
              </button>
            ) : (
              <>
                <button type="button" className="btn-ghost btn-sm" onClick={markMiddleEnd}>
                  标记中段终点（自 {formatTime(pendingStart)}）
                </button>
                <button type="button" className="btn-ghost btn-sm" title="放弃这个起点" onClick={() => onPendingStart(null)}>
                  取消
                </button>
              </>
            )}
          </div>
        </div>
      }
    >
      {/* 当前进度 + 本剧开关：本剧作用域放最上，全局开关在底部只读展示，避免两个层级并排 */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xs text-muted">
            当前{' '}
            <span className="font-mono text-content">{formatTime(clock.current)}</span>
            <span className="text-muted"> / {formatTime(clock.duration)}</span>
            {clock.paused && <span className="ml-1 text-muted">· 已暂停</span>}
          </p>
          <p className="mt-1 text-[11px] text-muted">
            已标记 {segments.length} 段 · 按剧名对本剧各集与同名资源生效 · 片尾记的是「距结尾多长」，
            各集时长不一样也会各自倒算起点
          </p>
        </div>
        <label
          className={cn(
            'flex shrink-0 items-center gap-1.5 text-xs',
            mark ? 'cursor-pointer text-muted hover:text-content' : 'cursor-not-allowed text-faint'
          )}
          title={mark ? '关闭后保留标记但完全不生效' : '还没有可开关的标记'}
        >
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-accent"
            checked={enabled}
            disabled={!mark}
            onChange={(e) => setSkipMarkEnabled(markKey, e.target.checked)}
          />
          本剧跳过
        </label>
      </div>

      {segments.length === 0 ? (
        <p className="mt-3 rounded-lg border border-dashed border-line px-3 py-3 text-xs leading-relaxed text-muted">
          尚未标记跳过片段。播放到目标位置后，用下方按钮记录，或使用快捷键：
          Shift+I 片头结束 / Shift+O 片尾开始 / Shift+S · Shift+E 中段区间。
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {segments.map((seg, i) => {
            const isCurrent = currentKey === seg;
            // 中段可以有多条：按时间顺序编号（中段1 / 中段2…），否则两行 [中段] 分不清
            const sameTypeCount = segments.filter((s) => s.type === seg.type).length;
            const label =
              seg.type === 'middle' && sameTypeCount > 1
                ? `${SEGMENT_LABELS.middle}${segments.slice(0, i).filter((s) => s.type === 'middle').length + 1}`
                : SEGMENT_LABELS[seg.type];
            const range = clock.duration > 0 ? resolveSegment(seg, clock.duration) : null;
            // 有时长却解析不出区间 = 这条标记对本集不适用（历史绝对起点越界、片尾长度超上限等）
            const notApplied = clock.duration > 0 && !range;
            return (
              <li
                key={`${seg.type}:${seg.start}`}
                className={cn(
                  'relative rounded-lg border px-2.5 py-2 pr-8 transition-colors',
                  isCurrent ? 'border-accent/60 bg-chip/60' : 'border-line/70'
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5 text-xs">
                    <span
                      aria-hidden
                      className="inline-block h-2 w-2 shrink-0 rounded-sm"
                      style={{ backgroundColor: SEGMENT_COLORS[seg.type] }}
                    />
                    <span className="text-muted">[{label}]</span>
                    <span className="font-mono text-muted">{describeRange(seg, range)}</span>
                    {notApplied && <span className="shrink-0 text-[10px] text-faint">本集不生效</span>}
                  </span>
                  {isCurrent && <span className="shrink-0 text-[10px] text-accent">当前</span>}
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1">
                  <button
                    type="button"
                    className="btn-ghost btn-sm"
                    title="跳到片段起点，验证起点是否准确"
                    onClick={() => jump(seg, 'start')}
                  >
                    起点
                  </button>
                  {seg.type !== 'ending' && (
                    <button
                      type="button"
                      className="btn-ghost btn-sm"
                      title="跳到终点前 1 秒，验证是否会切掉正片或漏掉一段"
                      onClick={() => jump(seg, 'end')}
                    >
                      终点
                    </button>
                  )}
                  <button type="button" className="btn-ghost btn-sm" title="边界提前 1 秒" onClick={() => nudge(i, -1)}>
                    -1s
                  </button>
                  <button type="button" className="btn-ghost btn-sm" title="边界推后 1 秒" onClick={() => nudge(i, 1)}>
                    +1s
                  </button>
                </div>
                {/* 删除放在右上角：条目多时「删」混在操作行里容易和 ±1s 混淆 */}
                <button
                  type="button"
                  className="absolute right-0.5 top-0.5 rounded-md p-1.5 text-muted transition-colors hover:bg-hover hover:text-danger"
                  title="删除（可在提示中撤销）"
                  aria-label={`删除${label}片段`}
                  onClick={() => remove(i)}
                >
                  <Icon name="close" className="h-3.5 w-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* 全局开关：只读展示（层级与本剧开关不同，改起来去设置里更不容易误解） */}
      <div className="mt-3 rounded-lg border border-line bg-surface px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted">全局 · 自动跳过片段</span>
          <span className={cn('text-xs font-medium', autoSkipSegments ? 'text-accent' : 'text-muted')}>
            {autoSkipSegments ? '已开启' : '已关闭'}
          </span>
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-muted">
          {autoSkipSegments
            ? '命中片头/中段自动跳段，片尾结束本集（是否连播看「自动连播」）。'
            : '命中片段只显示按钮，不自动跳。'}
          影响所有剧，在「设置 → 偏好设置」修改。
        </p>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
        <span>进度条色带：</span>
        {SEGMENT_TYPES.map((t) => (
          <span key={t} className="inline-flex items-center gap-1">
            <span
              aria-hidden
              className="inline-block h-2 w-2 rounded-sm"
              style={{ backgroundColor: SEGMENT_COLORS[t] }}
            />
            {SEGMENT_LABELS[t]}
          </span>
        ))}
        <span className="w-full">跳过时播放器顶部会出现「撤销」，可回退刚跳过的那一次。</span>
      </div>
    </Drawer>
  );
}
