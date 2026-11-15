'use client';

import { useEffect, useRef, useState } from 'react';
import Artplayer from 'artplayer';
import Hls, { type HlsConfig } from 'hls.js';
import type { PlaybackSample } from '@/lib/playback-telemetry';
import { getAdvertised4kStatus, resolveQualitySelection, type QualityPreference } from '@/lib/player-quality';
import { getMediaPlaybackKind } from '@/lib/media-playback';
import { hasSustainedPlaybackProgress } from '@/lib/playback-verification';

import { PlaybackRecovery, describeHlsError } from '@/lib/playback-recovery';
import { createHlsLoader } from '@/lib/hls-loader';
import { getVideoPrefetcher } from '@/lib/video-prefetcher';
import { loadCacheSettings } from '@/lib/video-cache';
import { formatTime } from '@/lib/utils';
import { executeFridayPlayerCommand, parseFridayPlayerCommand } from '@/lib/friday/player-control';
import { prefersTouchPointer } from '@/lib/touch-pointer';
import { requestNativeFullscreenWithFallback, type NativeFullscreenVideo } from '@/lib/player-fullscreen';
import { bindPlaybackUiEvents } from '@/lib/player-playback-ui';
import {
  findActiveSegment,
  findCrossedEnding,
  resolveSegments,
  SEGMENT_COLORS,
  SEGMENT_LABELS,
  type ResolvedSegment,
  type SkipMark,
  type SkipSegment,
} from '@/lib/skip-marks';
import {
  ART_DEFAULT_CONTROL_HIDE_MS,
  DESKTOP_CONTROL_HIDE_MS,
  TOUCH_CONTROL_HIDE_MS,
} from '@/lib/control-hide';

/** 片段时间统一保留 1 位小数：与面板展示保持一致，避免浮点尾巴 */
const round1 = (v: number) => Math.round(v * 10) / 10;

const QUALITY_PREFERENCE_KEY = 'libretv-quality-preference';
function readQualityPreference(): QualityPreference {
  try {
    const saved = window.localStorage.getItem(QUALITY_PREFERENCE_KEY);
    if (saved === '1080' || saved === '2160') return saved === '2160' ? '4k' : '1080';
    if (saved === '4k') return '4k';
  } catch {
    // Storage unavailable: default to adaptive playback.
  }
  return 'auto';
}

function applyHlsQualityPreference(
  hls: Hls,
  preference: QualityPreference,
  video: HTMLVideoElement,
): { heights: number[]; selectedHeight?: number; notice?: string } {
  const selection = resolveQualitySelection(
    hls.levels.map((level, index) => ({ index, height: level.height, bitrate: level.bitrate })),
    preference,
  );

  if (preference === 'auto') {
    hls.autoLevelCapping = -1;
    hls.currentLevel = -1;
    hls.startLoad();
    return { heights: selection.heights };
  }

  if (selection.selectedIndex === undefined && preference === '4k' && !selection.shouldPause) {
    // 4K is a preference, not a hard ceiling. If the playlist omits rendition
    // metadata, keep adaptive playback but clearly state that 4K cannot be verified.
    hls.autoLevelCapping = -1;
    hls.currentLevel = -1;
    hls.startLoad();
    return { heights: selection.heights, notice: selection.notice };
  }

  if (selection.shouldPause || selection.selectedIndex === undefined) {
    hls.stopLoad();
    video.pause();
    return { heights: selection.heights, notice: selection.notice };
  }

  // currentLevel pins the selected rendition. ABR cannot silently step down
  // when bandwidth fluctuates; the UI warns instead and leaves the choice intact.
  hls.autoLevelCapping = selection.selectedIndex;
  hls.currentLevel = selection.selectedIndex;
  hls.startLoad();
  return {
    heights: selection.heights,
    selectedHeight: selection.selectedHeight,
    notice: selection.notice,
  };
}

/**
 * 播放器外壳：ArtPlayer + hls.js（旧版 player.js 的 React 化）。
 * 保留：广告分片过滤、自动连播回调、进度回调、快捷键、移动端长按倍速、错误恢复。
 * 移除：DOM 手工操作、watch.html 跳转链、localStorage 状态总线。
 *
 * 关键设计：ArtPlayer 实例只在挂载时创建一次，换集（url 变化）只「切换 HLS 源」
 * 而不销毁重建。否则在「网页全屏（页面全屏）」下整实例重建会丢失全屏上下文、
 * 重建 <video> 元素，触发「黑屏有声」的渲染竞态。
 */

/** 暴露给播放页的读取接口：「记录当前」需要比 5s 节流进度回调更精确的位置 */
export interface PlayerSkipApi {
  getCurrentTime(): number;
  getDuration(): number;
  /** 跳转到指定位置（「试跳」/标记片段起点用） */
  seek(seconds: number): void;
  /** 暂停播放：记录标记前先定格，避免点击到读取之间视频继续走 */
  pause(): void;
  /** 当前是否处于暂停状态 */
  isPaused(): boolean;
  getPlaybackRate(): number;
  setPlaybackRate(rate: number): void;
}

interface PlayerShellProps {
  url: string;
  title: string;
  /** Validated format hint for extensionless direct-media URLs. */
  mediaType?: 'hls' | 'mp4' | 'webm';
  /** Called once per episode, only after the video element advances during a sustained playing window. */
  onPlaybackConfirmed?: (evidence: {
    mediaType: string; observedSeconds: number; progressedSeconds: number;
    decodedWidth: number; decodedHeight: number;
    selectedRenditionHeight: number; selectedRenditionBitrateKbps: number;
  }) => void;
  adFilter: boolean;
  autoplayNext: boolean;
  /** 当前剧的跳过片段标记（父级按归一化剧名查好后传入，换集/换源不变） */
  skipMark?: SkipMark;
  /**
   * 自动跳过标记的片段：片头/中段跳到片段末尾，片尾（连续播放越过起点）结束本集。
   * 是否连播下一集仍由 autoplayNext 决定。
   */
  autoSkipSegments: boolean;
  /** 中段两步态的起点：由页面层持有，面板与快捷键共用同一份状态 */
  pendingStart: number | null;
  /** 更新中段起点；null 表示取消或已消费 */
  onPendingStart: (start: number | null) => void;
  /** 播放器创建/销毁时回调，供播放页读取精确播放位置 */
  onPlayerApi?: (api: PlayerSkipApi | null) => void;
  /** 快捷键（Shift+I/O/S/E）记录片段时回调，由父级做校验与写入 */
  onRecordSegment?: (segment: SkipSegment) => void;
  /** 剧集标识 `${source}:${vodId}:${episodeIndex}`（片段缓存按集淘汰的分组键） */
  episodeKey?: string;
  /** 下一集 m3u8 地址：当前集预取完成后预热下一集前 7 分钟 */
  nextUrl?: string;
  nextEpisodeKey?: string;
  /** 进度恢复：优先 URL position，其次查询该回调（返回 0 表示无记录） */
  getRestorePosition?: () => number | Promise<number>;
  onTimeUpdate?: (position: number, duration: number) => void;
  onEnded?: () => void;
  onPause?: (position: number, duration: number) => void;
  /**
   * 实测画质（视频高度，像素）。
   * 单码率 m3u8 / 直链的分辨率只能等解码后才知道，播放一次后回写缓存，
   * 下次搜索同一部剧就能直接显示画质，不必再探测。
   */
  sourceKey?: string;
  resourceKey?: string;
  onPlaybackSample?: (sample: PlaybackSample) => void;
  onQuality?: (height: number) => void;
  /** 恢复策略判源不可用（重试耗尽/格式硬失败）时回调：父级弹出换源面板 */
  onRequestSwitchSource?: (reason: string) => void;
  /** 控制条上的上一集 / 下一集：不在播放器里也能切集，省得回到页面按钮 */
  onPrevEpisode?: () => void;
  onNextEpisode?: () => void;
  hasPrevEpisode?: boolean;
  hasNextEpisode?: boolean;
}

export function PlayerShell({
  url,
  title,
  mediaType,
  onPlaybackConfirmed,
  adFilter,
  autoplayNext,
  skipMark,
  autoSkipSegments,
  pendingStart,
  onPendingStart,
  onPlayerApi,
  onRecordSegment,
  episodeKey,
  nextUrl,
  nextEpisodeKey,
  getRestorePosition,
  onTimeUpdate,
  onEnded,
  onPause,
  onQuality,
  sourceKey,
  resourceKey,
  onPlaybackSample,
  onRequestSwitchSource,
  onPrevEpisode,
  onNextEpisode,
  hasPrevEpisode,
  hasNextEpisode,
}: PlayerShellProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const artRef = useRef<any>(null);
  const nativeFullscreenCleanupRef = useRef<(() => void) | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const qualityPreferenceHandlerRef = useRef<(() => void) | null>(null);
  const [error, setError] = useState('');
  const [hint, setHint] = useState('');
  // 起播前的品牌占位图（沿用旧版 nomedia 素材），实际开始播放后隐藏
  const [showPoster, setShowPoster] = useState(true);
  const [qualityPreference, setQualityPreference] = useState<QualityPreference>('auto');
  const [qualityPanelOpen, setQualityPanelOpen] = useState(false);
  const [availableQualityHeights, setAvailableQualityHeights] = useState<number[]>([]);
  const [availableQualityLevelCount, setAvailableQualityLevelCount] = useState(0);
  const [qualityMetadataComplete, setQualityMetadataComplete] = useState(false);
  const [actualQualityHeight, setActualQualityHeight] = useState(0);
  const [actualQualityWidth, setActualQualityWidth] = useState(0);
  const [selectedHlsRendition, setSelectedHlsRendition] = useState<{ index: number; height: number; bitrate: number } | null>(null);
  const [observedMediaBitrateKbps, setObservedMediaBitrateKbps] = useState(0);
  const [observedThroughputKbps, setObservedThroughputKbps] = useState(0);
  const [qualityNotice, setQualityNotice] = useState('');
  const [networkQualityWarning, setNetworkQualityWarning] = useState('');
  const [qualityControlMode, setQualityControlMode] = useState<'hls' | 'native' | 'single'>('single');
  const unsustainableFragmentsRef = useRef(0);
  const sustainableFragmentsRef = useRef(0);
  const [showPlayFallback, setShowPlayFallback] = useState(false);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setQualityPreference(readQualityPreference());
  }, []);

  useEffect(() => {
    const handleFridayPlayerCommand = (event: Event) => {
      const command = parseFridayPlayerCommand((event as CustomEvent<unknown>).detail);
      if (!command) return;
      const art = artRef.current;
      const video = art?.video;
      const target = art ? {
        play: () => art.play(),
        pause: () => art.pause(),
        toggle: () => video?.paused ? art.play() : art.pause(),
        get currentTime() { return art.currentTime ?? video?.currentTime ?? 0; },
        set currentTime(value: number) { art.currentTime = value; },
        get duration() { return art.duration ?? video?.duration ?? 0; },
        get volume() { return video?.volume ?? art.volume ?? 1; },
        set volume(value: number) { if (video) video.volume = value; else art.volume = value; },
        get muted() { return video?.muted ?? false; },
        set muted(value: boolean) { if (video) video.muted = value; },
        get fullscreen() { return Boolean(art.fullscreen); },
        set fullscreen(value: boolean) { art.fullscreen = value; },
      } : null;
      const ok = executeFridayPlayerCommand(target, command);
      window.dispatchEvent(new CustomEvent('friday-player-control-result', { detail: { commandId: command.commandId, ok } }));
      if (ok) showHint('Friday 控制指令已发送');
    };
    window.addEventListener('friday-player-control', handleFridayPlayerCommand);
    return () => window.removeEventListener('friday-player-control', handleFridayPlayerCommand);
  }, []);

  // 始终持有最新 props/回调，避免重建播放器
  const propsRef = useRef({
    url, title, mediaType, onPlaybackConfirmed, adFilter, autoplayNext, skipMark, autoSkipSegments,
    pendingStart, onPendingStart, onPlayerApi, onRecordSegment,
    episodeKey, nextUrl, nextEpisodeKey,
    getRestorePosition, onTimeUpdate, onEnded, onPause, onQuality, sourceKey, resourceKey, onPlaybackSample, onRequestSwitchSource,
    onPrevEpisode, onNextEpisode, hasPrevEpisode, hasNextEpisode,
  });
  propsRef.current = {
    url, title, mediaType, onPlaybackConfirmed, adFilter, autoplayNext, skipMark, autoSkipSegments,
    pendingStart, onPendingStart, onPlayerApi, onRecordSegment,
    episodeKey, nextUrl, nextEpisodeKey,
    getRestorePosition, onTimeUpdate, onEnded, onPause, onQuality, sourceKey, resourceKey, onPlaybackSample, onRequestSwitchSource,
    onPrevEpisode, onNextEpisode, hasPrevEpisode, hasNextEpisode,
  };

  /** 上报实测画质：多次上报取大值由调用方决定，这里只管把拿到的高度传出去 */
  const reportQuality = (height: number) => {
    if (height > 0) propsRef.current.onQuality?.(height);
  };

  const playbackIdentityRef = useRef({ sourceKey, resourceKey, onPlaybackSample });
  const playbackMetricsRef = useRef({
    startedAt: Date.now(), firstFragmentMs: undefined as number | undefined,
    totalBytes: 0, totalDownloadMs: 0, totalMediaSeconds: 0,
    videoBytes: 0, videoDownloadMs: 0, videoMediaSeconds: 0,
    selectedRenditionIndex: undefined as number | undefined,
    selectedRenditionHeight: undefined as number | undefined,
    selectedRenditionBitrateKbps: undefined as number | undefined,
    stalls: 0, fatalErrors: 0, recoveries: 0, playedSeconds: 0,
    lastPosition: 0, lastTickAt: 0, height: 0, waiting: false, flushed: false,
  });
  const resetPlaybackMetrics = () => {
    setSelectedHlsRendition(null);
    setObservedMediaBitrateKbps(0);
    setObservedThroughputKbps(0);
    playbackIdentityRef.current = { sourceKey: propsRef.current.sourceKey, resourceKey: propsRef.current.resourceKey, onPlaybackSample: propsRef.current.onPlaybackSample };
    playbackMetricsRef.current = {
      startedAt: Date.now(), firstFragmentMs: undefined, totalBytes: 0,
      totalDownloadMs: 0, totalMediaSeconds: 0, videoBytes: 0,
      videoDownloadMs: 0, videoMediaSeconds: 0,
      selectedRenditionIndex: undefined, selectedRenditionHeight: undefined,
      selectedRenditionBitrateKbps: undefined, stalls: 0, fatalErrors: 0,
      recoveries: 0, playedSeconds: 0, lastPosition: 0, lastTickAt: 0,
      height: 0, waiting: false, flushed: false,
    };
  };
  const flushPlaybackMetrics = () => {
    const metrics = playbackMetricsRef.current;
    if (metrics.flushed || (!metrics.playedSeconds && !metrics.totalBytes && !metrics.fatalErrors)) return;
    metrics.flushed = true;
    const identity = playbackIdentityRef.current;
    if (!identity.sourceKey || !identity.resourceKey) return;
    identity.onPlaybackSample?.({
      sourceKey: identity.sourceKey,
      resourceKey: identity.resourceKey,
      timestamp: Date.now(),
      startupMs: metrics.firstFragmentMs,
      throughputKbps: metrics.videoDownloadMs > 0 ? metrics.videoBytes * 8 / metrics.videoDownloadMs : undefined,
      mediaBitrateKbps: metrics.videoMediaSeconds > 0 ? metrics.videoBytes * 8 / metrics.videoMediaSeconds / 1000 : undefined,
      selectedRenditionIndex: metrics.selectedRenditionIndex,
      selectedRenditionHeight: metrics.selectedRenditionHeight,
      selectedRenditionBitrateKbps: metrics.selectedRenditionBitrateKbps,
      height: metrics.height || undefined,
      stalls: metrics.stalls,
      fatalErrors: metrics.fatalErrors,
      recoveries: metrics.recoveries,
      playedSeconds: metrics.playedSeconds,
    });
  };

  // 跨集共享、每次换集重置的播放链路状态
  // 媒体健康度：音频轨可播不代表视频轨正常（「黑屏但有声」的假死态）。
  // 仅当有分片真正进入 MSE buffer 后才视为恢复，错误遮罩才能被清除。
  const mediaHealthyRef = useRef(true);
  const playbackStartedRef = useRef(false);
  const playbackConfirmedRef = useRef(false);
  const playbackConfirmationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 起播阶段的 video 元素级错误允许自愈重试一次（重建 hls/MSE）
  const videoErrorRetryUsedRef = useRef(false);
  // 进度恢复每集只执行一次（MANIFEST_PARSED 可能因代理回退再次触发）
  const restoredRef = useRef(false);
  // 某些 HLS 源在 MANIFEST_PARSED 时 duration 仍未就绪，延迟到媒体元数据可用后恢复
  const restoreCleanupRef = useRef<(() => void) | null>(null);
  const metadataWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearMetadataWatchdog = () => {
    if (metadataWatchdogRef.current) clearTimeout(metadataWatchdogRef.current);
    metadataWatchdogRef.current = null;
  };
  const armMetadataWatchdog = (video: HTMLVideoElement, mediaUrl: string) => {
    clearMetadataWatchdog();
    metadataWatchdogRef.current = setTimeout(() => {
      metadataWatchdogRef.current = null;
      if (video.readyState >= 1) return;
      const mediaError = video.error;
      const errorMessage = mediaError?.code === 2
        ? '视频地址或媒体分片请求失败，请更换播放源'
        : mediaError?.code === 3
          ? '媒体解码失败，请尝试其他播放源或格式'
          : mediaError?.code === 4
            ? '播放源无效或格式不受支持，请更换播放源'
            : video.networkState === 3
              ? '没有取得有效媒体地址，请更换播放源'
              : '媒体元数据加载超时，请检查播放源或网络后重试';
      setError(errorMessage);
      if (process.env.NODE_ENV !== 'production') {
        console.warn('[LibreTV player] metadata timeout', {
          mediaUrl,
          readyState: video.readyState,
          networkState: video.networkState,
          errorCode: mediaError?.code ?? null,
        });
      }
    }, 30_000);
  };
  // setupHls 可能改走代理形式，video:error 重试要用最近一次的地址
  const currentMediaUrlRef = useRef(url);
  // 本集的恢复策略实例：跨直连/代理两级重建共享计数
  const recoveryRef = useRef<PlaybackRecovery | null>(null);
  // 自然播完标记，卸载时不回写进度（避免覆盖「已看完」记录）
  const endedRef = useRef(false);
  // 跳过片段：每集已处理的片段（按 type:start 去重），换集时重置（见 loadEpisode）
  const handledSegmentsRef = useRef<Set<string>>(new Set());
  // 被「撤销」过的片段：本集不再自动跳（否则撤回到片段内会被立刻再跳走），但仍保留提示按钮
  const suppressedAutoRef = useRef<Set<string>>(new Set());
  // 上一次 timeupdate 的位置：用于区分「连续播放越过片尾」与「拖动进度条」
  const lastSampleRef = useRef(0);
  // 跳过按钮提示；用 ref 比较，避免 timeupdate 每 250ms 触发重渲染
  const [skipPrompt, setSkipPrompt] = useState<ResolvedSegment | null>(null);
  const skipPromptRef = useRef<ResolvedSegment | null>(null);
  // 刚跳过的片段：给一个撤销窗口，误标导致跳掉正片时不必手动拖回去
  const [undoSkip, setUndoSkip] = useState<{ from: number; segment: ResolvedSegment } | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showHint = (text: string) => {
    setHint(text);
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    hintTimerRef.current = setTimeout(() => setHint(''), 2500);
  };

  // 流式播放：hls.js 按播放头顺序请求分片，不因缓存开关扩大到整集级内存缓冲。
  // 30s 常规缓冲、60s 上限；网络抖动由 HLS 自身重试与 ABR 处理。
  const buildHlsConfig = (): Partial<HlsConfig> => {
    const p = propsRef.current;
    return {
      debug: false,
      enableWorker: true,
      backBufferLength: 30,
      maxBufferLength: 30,
      maxMaxBufferLength: 60,
      maxBufferSize: 60 * 1000 * 1000,
      maxBufferHole: 0.5,
      fragLoadingMaxRetry: 6,
      fragLoadingRetryDelay: 1000,
      manifestLoadingMaxRetry: 3,
      manifestLoadingRetryDelay: 1000,
      startLevel: -1,
      abrEwmaDefaultEstimate: 500_000,
      appendErrorMaxRetry: 5,
      loader: createHlsLoader(Hls, { blockAd: p.adFilter }) as unknown as HlsConfig['loader'],
    };
  };

  /** 切换提示状态；值相同直接返回，避免 timeupdate 高频 setState */
  const updateSkipPrompt = (next: ResolvedSegment | null) => {
    const prev = skipPromptRef.current;
    const same =
      prev === next ||
      (prev !== null &&
        next !== null &&
        prev.type === next.type &&
        prev.start === next.start &&
        prev.end === next.end);
    if (same) return;
    skipPromptRef.current = next;
    setSkipPrompt(next);
  };

  /** 片段去重键：按类型 + 起点，同一集内每段只处理一次 */
  const segmentKey = (s: ResolvedSegment) => `${s.type}:${s.start}`;

  /** 进度条区间可视化：在进度条轨道叠加半透明色带（颜色与面板图例共用 SEGMENT_COLORS） */
  const renderSkipMarks = () => {
    const art = artRef.current;
    const progress = art?.template.$progress;
    if (!progress) return;
    progress.querySelectorAll('[data-skip-segment]').forEach((el: Element) => el.remove());
    const duration = art.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    const segments = resolveSegments(propsRef.current.skipMark, duration);
    for (const seg of segments) {
      const el = document.createElement('div');
      el.dataset.skipSegment = '1';
      el.title = `跳过${SEGMENT_LABELS[seg.type]}`;
      const left = (seg.start / duration) * 100;
      const width = Math.max(0.4, ((seg.end - seg.start) / duration) * 100);
      el.style.cssText = `position:absolute;left:${left}%;width:${width}%;top:0;bottom:0;background:${SEGMENT_COLORS[seg.type]};pointer-events:none;`;
      progress.appendChild(el);
    }
  };

  /**
   * 跳到片段末尾并续跑预取；同步 lastSampleRef，避免下一拍被误判为「连续越过片尾」。
   * 返回是否成功：媒体未就绪导致赋值失败时返回 false，调用方不置已处理标记，
   * 下一次 timeupdate 会重新判定（保证「可重试」）。
   */
  const skipTo = (seconds: number): boolean => {
    const art = artRef.current;
    if (!art || !Number.isFinite(seconds) || seconds < 0) return false;
    try {
      art.currentTime = seconds;
    } catch {
      return false;
    }
    lastSampleRef.current = seconds;
    return true;
  };

  /** 记录一次跳过（跳转前的位置）：给 12s 撤销窗口，误标导致跳掉正片时不用手动拖回去 */
  const rememberSkip = (from: number, segment: ResolvedSegment) => {
    setUndoSkip({ from, segment });
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    undoTimerRef.current = setTimeout(() => setUndoSkip(null), 12_000);
  };

  const undoLastSkip = () => {
    const last = undoSkip;
    if (!last) return;
    if (undoTimerRef.current) {
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    // 撤销后把片段从「已处理」移除（按钮会重新出现），同时本集不再自动跳它：
    // 否则回到片段内会被下一次 timeupdate 立刻再跳走，形成"撤销→又被跳过"的死循环
    handledSegmentsRef.current.delete(segmentKey(last.segment));
    suppressedAutoRef.current.add(segmentKey(last.segment));
    skipTo(last.from);
    setUndoSkip(null);
    showHint('已撤回跳过');
  };

  /**
   * 跳过片尾：与自然播完共用 onEnded 链路（清进度 + 依 autoplayNext 连播下一集）。
   * endedRef 置 true 同时阻止 video:ended 重复回调，也避免卸载时把片尾进度回写。
   */
  const finishBySkip = (ending?: ResolvedSegment) => {
    const art = artRef.current;
    if (ending) handledSegmentsRef.current.add(segmentKey(ending));
    endedRef.current = true;
    updateSkipPrompt(null);
    setUndoSkip(null);
    try {
      art?.pause();
    } catch {
      /* 忽略 */
    }
    showHint('已跳过片尾');
    propsRef.current.onEnded?.();
  };

  /** Native progressive media path for formats the existing HTMLVideoElement can play. */
  const setupDirectMedia = (video: HTMLVideoElement, mediaUrl: string) => {
    clearMetadataWatchdog();
    restoreCleanupRef.current?.();
    restoreCleanupRef.current = null;
    if (qualityPreferenceHandlerRef.current) {
      window.removeEventListener('libretv-quality-preference-change', qualityPreferenceHandlerRef.current);
      qualityPreferenceHandlerRef.current = null;
    }
    hlsRef.current?.destroy();
    hlsRef.current = null;
    const mediaKind = getMediaPlaybackKind(mediaUrl, propsRef.current.mediaType);
    if (mediaKind !== 'mp4' && mediaKind !== 'webm') {
      setError('当前直链格式无效，请选择 HLS、MP4 或 WebM 资源');
      return;
    }
    currentMediaUrlRef.current = mediaUrl;
    armMetadataWatchdog(video, mediaUrl);
    // Native progressive playback does not need fetch CORS; forcing crossorigin=anonymous
    // can make otherwise public media fail when the host omits Access-Control-Allow-Origin.
    video.removeAttribute('crossorigin');

    let restoreInFlight = false;
    const restoreAndStart = async () => {
      if (restoredRef.current || restoreInFlight) return;
      const duration = video.duration;
      if (!Number.isFinite(duration) || duration <= 0) return;
      restoreInFlight = true;
      try {
        const saved = (await propsRef.current.getRestorePosition?.()) ?? 0;
        if (saved > 10 && saved < duration - 2) {
          video.currentTime = saved;
          showHint(`已从 ${formatTime(saved)} 继续播放`);
        }
        restoredRef.current = true;
        restoreCleanupRef.current?.();
        restoreCleanupRef.current = null;
        video.play().catch(() => setShowPlayFallback(true));
      } catch {
        // A failed progress lookup must never prevent direct media playback.
        restoredRef.current = true;
        video.play().catch(() => setShowPlayFallback(true));
      } finally {
        restoreInFlight = false;
      }
    };
    const events = ['loadedmetadata', 'durationchange', 'canplay'] as const;
    const onReady = () => { void restoreAndStart(); };
    events.forEach((event) => video.addEventListener(event, onReady));
    restoreCleanupRef.current = () => {
      events.forEach((event) => video.removeEventListener(event, onReady));
    };
    video.src = mediaUrl;
    video.load();
  };

  /**
   * 初始化/切换 HLS。allowProxyFallback：直连致命网络错误（CORS/防盗链/分片被拒）时，
   * 自动改走同源 cookie 鉴权的 /api/proxy 重试一次。
   * 注意：不销毁 ArtPlayer，只销毁并重建 hls，从而保留网页全屏等播放器状态。
   */
  const setupHls = (video: HTMLVideoElement, mediaUrl: string, allowProxyFallback: boolean) => {
    clearMetadataWatchdog();
    restoreCleanupRef.current?.();
    restoreCleanupRef.current = null;
    if (qualityPreferenceHandlerRef.current) {
      window.removeEventListener('libretv-quality-preference-change', qualityPreferenceHandlerRef.current);
      qualityPreferenceHandlerRef.current = null;
    }
    hlsRef.current?.destroy();
    hlsRef.current = null;
    currentMediaUrlRef.current = mediaUrl;
    const mediaKind = getMediaPlaybackKind(mediaUrl, propsRef.current.mediaType);
    if (mediaKind === 'mp4' || mediaKind === 'webm') {
      setupDirectMedia(video, mediaUrl);
      return;
    }
    if (mediaKind === 'unsupported') {
      setError('当前媒体格式尚未接入播放器，请选择 HLS、MP4 或 WebM 资源');
      return;
    }
    if (!Hls.isSupported()) {
      if (!video.canPlayType('application/vnd.apple.mpegurl') && !video.canPlayType('application/x-mpegURL')) {
        hlsRef.current = null;
        setError('当前浏览器不支持 HLS 播放，请尝试其他视频源或浏览器');
        return;
      }
      hlsRef.current = null;
      armMetadataWatchdog(video, mediaUrl);
      // Safari's native HLS pipeline does not need CORS-readable media bytes.
      // Keeping crossorigin="anonymous" here can make otherwise playable
      // cross-origin HLS streams fail when the source omits ACAO headers.
      video.removeAttribute('crossorigin');
      setAvailableQualityHeights([]);
      setQualityControlMode('native');
      setQualityNotice('当前使用浏览器原生 HLS，Safari 会自行选择档位，网页无法强制锁定 1080P 或 4K。实际解码分辨率仍会显示。');
      let nativeRestoreInFlight = false;
      const restoreNativePosition = async () => {
        if (restoredRef.current || nativeRestoreInFlight) return;
        const duration = video.duration || 0;
        if (!Number.isFinite(duration) || duration <= 0) return;
        nativeRestoreInFlight = true;
        try {
          const saved = (await propsRef.current.getRestorePosition?.()) ?? 0;
          if (saved > 10 && saved < duration - 2) {
            video.currentTime = saved;
            showHint(`已从 ${formatTime(saved)} 继续播放`);
          }
          restoredRef.current = true;
          restoreCleanupRef.current?.();
          restoreCleanupRef.current = null;
          if (readQualityPreference() === '1080') {
            video.pause();
            setQualityNotice('当前使用原生 HLS，无法验证或强制限制 1080P；已暂停以避免超过所选上限，请选择自动继续播放。');
            return;
          }
          video.play().catch(() => setShowPlayFallback(true));
        } catch {
          // A failed progress lookup must never block native-HLS playback.
          restoredRef.current = true;
          restoreCleanupRef.current?.();
          restoreCleanupRef.current = null;
          video.play().catch(() => setShowPlayFallback(true));
        } finally {
          nativeRestoreInFlight = false;
        }
      };
      const nativeRestoreEvents = ['loadedmetadata', 'durationchange', 'canplay'] as const;
      const onNativeRestoreEvent = () => { void restoreNativePosition(); };
      nativeRestoreEvents.forEach((event) => video.addEventListener(event, onNativeRestoreEvent));
      restoreCleanupRef.current = () => {
        nativeRestoreEvents.forEach((event) => video.removeEventListener(event, onNativeRestoreEvent));
      };
      video.src = mediaUrl;
      video.load();
      return;
    }
    armMetadataWatchdog(video, mediaUrl);
    const hls = new Hls(buildHlsConfig());
    hlsRef.current = hls;
    setQualityControlMode('hls');
    const handleQualityPreferenceChange = () => {
      const preference = readQualityPreference();
      setQualityPreference(preference);
      unsustainableFragmentsRef.current = 0;
      sustainableFragmentsRef.current = 0;
      setNetworkQualityWarning('');
      const result = hls
        ? applyHlsQualityPreference(hls!, preference, video)
        : { heights: [], notice: '当前使用浏览器原生 HLS，无法读取或锁定播放清晰度档位。' };
      setAvailableQualityHeights(result.heights);
      setQualityNotice(result.notice ?? '');
    };

    let restoreInFlight = false;
    const restoreAndStart = async () => {
      if (restoredRef.current || restoreInFlight) return;

      // MANIFEST_PARSED 早于 loadedmetadata 的 HLS 源很常见；没有有效时长时
      // 先不消费 restoredRef，等 loadedmetadata/durationchange 后再重试。
      const duration = artRef.current?.duration || video.duration || 0;
      if (!Number.isFinite(duration) || duration <= 0) return;

      restoreInFlight = true;
      try {
        const saved = (await propsRef.current.getRestorePosition?.()) ?? 0;
        const currentDuration = artRef.current?.duration || video.duration || duration;
        let prefetchAnchor = video.currentTime;
        if (saved > 10 && Number.isFinite(currentDuration) && saved < currentDuration - 2) {
          if (artRef.current) artRef.current.currentTime = saved;
          prefetchAnchor = saved;
          showHint(`已从 ${formatTime(saved)} 继续播放`);
        }
        restoredRef.current = true;
        restoreCleanupRef.current?.();
        restoreCleanupRef.current = null;
        video.play().catch(() => {
          // iOS Safari may reject autoplay after async detail/source loading.
          // Keep the player inline and offer a user-activated retry instead of a silent poster.
          setShowPlayFallback(true);
        });
      } catch {
        // IndexedDB 读取失败时不阻塞播放，后续事件仍可再次尝试恢复。
      } finally {
        restoreInFlight = false;
      }
    };

    const restoreEvents = ['loadedmetadata', 'durationchange', 'canplay'] as const;
    const onRestoreEvent = () => { void restoreAndStart(); };
    restoreEvents.forEach((event) => video.addEventListener(event, onRestoreEvent));
    restoreCleanupRef.current = () => {
      restoreEvents.forEach((event) => video.removeEventListener(event, onRestoreEvent));
    };

    if (!hls) {
      // Safari/iOS native HLS path: hls.js is not MSE-supported on these devices.
      // Let the browser's native media pipeline decide CORS for playback.
      video.removeAttribute('crossorigin');
      video.src = mediaUrl;
      video.load();
      return;
    }
    hls.loadSource(mediaUrl);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      const qualityResult = applyHlsQualityPreference(hls!, readQualityPreference(), video);
      setAvailableQualityHeights(qualityResult.heights);
      setAvailableQualityLevelCount(hls.levels.length);
      setQualityMetadataComplete(hls.levels.length > 0 && hls.levels.every((level) => Number.isFinite(level.height) && level.height > 0));
      setQualityNotice(qualityResult.notice ?? '');
      recoveryRef.current?.markHealthy();
      // 清单只描述“可提供的最高档”，不代表当前正在解码该画质。
      // 实测画质只允许由 video.videoHeight 上报，避免把 4K 标称值误记成实际播放 4K。
      // 进度恢复改由 restoreAndStart 处理：duration 未就绪时不消费标记，挂事件重试
      void restoreAndStart();
    });
    // 播放链路恢复（FRAG_LOADED / MANIFEST_PARSED）：静默窗外清零连续失败计数
    hls.on(Hls.Events.FRAG_LOADED, (_event, data) => {
      recoveryRef.current?.markHealthy();
      const metrics = playbackMetricsRef.current;
      const stats = data.frag?.stats;
      const bytes = typeof stats?.loaded === 'number' && stats.loaded > 0 ? stats.loaded : stats?.total;
      const loadStart = stats?.loading?.start;
      const loadEnd = stats?.loading?.end;
      const loadMs = typeof loadStart === 'number' && typeof loadEnd === 'number' && loadEnd > loadStart ? loadEnd - loadStart : 0;
      const mediaSeconds = data.frag?.duration;
      if (typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0 && loadMs > 0) {
        if (metrics.firstFragmentMs === undefined) metrics.firstFragmentMs = Date.now() - metrics.startedAt;
        metrics.totalBytes += bytes;
        metrics.totalDownloadMs += loadMs;
        if (typeof mediaSeconds === 'number' && mediaSeconds > 0) {
          metrics.totalMediaSeconds += mediaSeconds;
          if (data.frag?.type === 'main') {
            metrics.videoBytes += bytes;
            metrics.videoDownloadMs += loadMs;
            metrics.videoMediaSeconds += mediaSeconds;
            setObservedMediaBitrateKbps(bytes * 8 / (mediaSeconds * 1000));
            setObservedThroughputKbps(bytes * 8 / loadMs);
          }
          const preference = readQualityPreference();
          // Only main video fragments represent the selected picture rendition; audio/subtitle
          // fragments must not trigger a false warning about the chosen video bitrate.
          if (data.frag?.type === 'main') {
            const throughputKbps = bytes * 8 / loadMs;
            const mediaBitrateKbps = bytes * 8 / (mediaSeconds * 1000);
            if (mediaBitrateKbps > 0 && throughputKbps < mediaBitrateKbps * 1.25) {
              unsustainableFragmentsRef.current += 1;
              sustainableFragmentsRef.current = 0;
            } else {
              unsustainableFragmentsRef.current = 0;
              sustainableFragmentsRef.current += 1;
            }
            if (unsustainableFragmentsRef.current >= 2) {
              setNetworkQualityWarning(preference === 'auto'
                ? `网络吞吐持续低于当前视频码率（本片段约 ${Math.round(throughputKbps)} Kbps），可能出现缓冲；自动模式将由 HLS 自适应调整档位。`
                : `网络带宽不足以稳定维持手动选择的画质（本片段吞吐约 ${Math.round(throughputKbps)} Kbps）。已保留所选档位，不会自动降档，可能出现缓冲。`);
            } else if (sustainableFragmentsRef.current >= 3) {
              setNetworkQualityWarning('');
            }
          }
        }
      }
    });
    // LEVEL_LOADED / levelInfo 仍是播放列表声明值，不是当前视频解码分辨率。
    // 实际分辨率统一由 video.videoHeight 的 loadedmetadata/canplay/playing/resize 事件记录。
    hls.on(Hls.Events.LEVELS_UPDATED, () => {
      // 部分动态清单会在初次解析后补齐档位；重新应用用户的最高画质限制。
      const qualityResult = applyHlsQualityPreference(hls!, readQualityPreference(), video);
      setAvailableQualityHeights(qualityResult.heights);
      setAvailableQualityLevelCount(hls.levels.length);
      setQualityMetadataComplete(hls.levels.length > 0 && hls.levels.every((level) => Number.isFinite(level.height) && level.height > 0));
      setQualityNotice(qualityResult.notice ?? '');
    });
    hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
      // The selected playlist rendition and decoded video dimensions are different observations.
      // Track the HLS level in Auto as well as manual modes; never present it as decoded quality.
      const level = hls.levels[data.level];
      if (level) {
        const selected = {
          index: data.level,
          height: level.height || 0,
          bitrate: level.bitrate || 0,
        };
        setSelectedHlsRendition(selected);
        playbackMetricsRef.current.selectedRenditionIndex = selected.index;
        playbackMetricsRef.current.selectedRenditionHeight = selected.height || undefined;
        playbackMetricsRef.current.selectedRenditionBitrateKbps = selected.bitrate > 0 ? selected.bitrate / 1000 : undefined;
      }
      const decodedHeight = video.videoHeight;
      if (decodedHeight > 0) setActualQualityHeight(decodedHeight);
    });
    // 分片真正进入 MSE buffer 才算媒体恢复：此时视频轨可渲染，错误态可解除
    hls.on(Hls.Events.FRAG_BUFFERED, () => {
      mediaHealthyRef.current = true;
    });

    hls.on(Hls.Events.ERROR, (_evt, data) => {
      if (!data.fatal) return;
      const recovery = recoveryRef.current;
      if (!recovery) return;
      const decision = recovery.onFatal(data.type, data.details);
      playbackMetricsRef.current.fatalErrors += 1;
      if (decision.action === 'retry' || decision.action === 'recover-media') playbackMetricsRef.current.recoveries += 1;
      switch (decision.action) {
        case 'ignore':
          break;
        case 'retry': {
          // 前两次重试保留直连；达到退避阈值或清单级错误时升级为代理形式
          // （同源 cookie 鉴权，规避 CORS/防盗链/分片被拒）
          if (
            allowProxyFallback &&
            !mediaUrl.startsWith('/api/proxy') &&
            (decision.attempt >= 2 || data.details === 'manifestLoadError')
          ) {
            showHint('直连失败，改用代理重试...');
            setupHls(video, `/api/proxy?url=${encodeURIComponent(mediaUrl)}`, false);
            return;
          }
          showHint(`${decision.reason}（第 ${decision.attempt} 次）...`);
          recovery.schedule(decision.delayMs, () => hls.startLoad());
          break;
        }
        case 'recover-media': {
          showHint(`${decision.reason}（第 ${decision.attempt} 次）...`);
          if (decision.swapAudio) hls.swapAudioCodec?.();
          hls.recoverMediaError();
          break;
        }
        case 'switch-source': {
          // 覆盖播放开始后的场景：起播失败走 setError 遮罩；
          // 播放中失败走回调弹换源面板（父级未提供回调时同样 setError）
          const message = `${describeHlsError(data.type, data.details)}：${decision.reason}`;
          if (playbackStartedRef.current) {
            showHint(message);
            propsRef.current.onRequestSwitchSource?.(decision.reason);
          } else {
            setError(`视频加载失败，${message}，请尝试其他视频源`);
          }
          break;
        }
      }
    });
  };

  /** 换集：重置每集状态并切换到新 HLS 源（不重建 ArtPlayer）。 */
  const loadEpisode = (targetUrl: string) => {
    if (!targetUrl) return;
    flushPlaybackMetrics();
    resetPlaybackMetrics();
    mediaHealthyRef.current = true;
    playbackStartedRef.current = false;
    playbackConfirmedRef.current = false;
    if (playbackConfirmationTimerRef.current) {
      clearTimeout(playbackConfirmationTimerRef.current);
      playbackConfirmationTimerRef.current = null;
    }
    videoErrorRetryUsedRef.current = false;
    restoredRef.current = false;
    // 跳过片段按集重置：上一集已处理过不意味新一集也处理过
    handledSegmentsRef.current.clear();
    suppressedAutoRef.current.clear();
    lastSampleRef.current = 0;
    endedRef.current = false;
    updateSkipPrompt(null);
    setUndoSkip(null);
    recoveryRef.current = new PlaybackRecovery();
    // 换集时清掉上一集的预取窗口，避免带宽被旧集占用
    getVideoPrefetcher().stop();
    setError('');
    setShowPoster(true);
    setActualQualityHeight(0);
    setActualQualityWidth(0);
    setAvailableQualityHeights([]);
    setAvailableQualityLevelCount(0);
    setQualityMetadataComplete(false);
    setQualityNotice('');
    setNetworkQualityWarning('');
    unsustainableFragmentsRef.current = 0;
    sustainableFragmentsRef.current = 0;
    setShowPlayFallback(false);
    const art = artRef.current;
    if (!art) return;
    setupHls(art.video, targetUrl, true);
  };

  // —— 创建播放器（仅一次，挂载即创建） ——
  useEffect(() => {
    if (!containerRef.current || !propsRef.current.url) return;
    const initialUrl = propsRef.current.url;
    // ArtPlayer 默认 3 秒才隐藏控制栏；桌面失去鼠标悬停后缩短为 0.8 秒。
    // 触屏没有 hover，自动隐藏会让按钮来不及点（issue #937）：改为常驻，
    // 由「点按视频 toggle」收起。CONTROL_HIDE_TIME 是 static，创建后修改立即生效。
    const touchPointer = prefersTouchPointer();
    Artplayer.CONTROL_HIDE_TIME = touchPointer ? TOUCH_CONTROL_HIDE_MS : DESKTOP_CONTROL_HIDE_MS;

    // 初始化每集状态
    resetPlaybackMetrics();
    mediaHealthyRef.current = true;
    playbackStartedRef.current = false;
    videoErrorRetryUsedRef.current = false;
    restoredRef.current = false;
    recoveryRef.current = new PlaybackRecovery();
    endedRef.current = false;
    handledSegmentsRef.current.clear();
    suppressedAutoRef.current.clear();
    lastSampleRef.current = 0;

    let lastSave = 0;

    const art = new Artplayer({
      container: containerRef.current,
      url: initialUrl,
      type: getMediaPlaybackKind(initialUrl, mediaType) === 'mp4' ? 'mp4' : getMediaPlaybackKind(initialUrl, mediaType) === 'webm' ? 'webm' : 'm3u8',
      volume: 0.8,
      autoplay: true,
      // PR84 mobile watch: never spawn floating PiP/mini-player windows over the page.
      pip: false,
      autoMini: false,
      screenshot: true,
      setting: true,
      playbackRate: true,
      aspectRatio: true,
      // Touch devices use native iOS video fullscreen first, with a web fullscreen fallback.
      fullscreen: !touchPointer,
      fullscreenWeb: !touchPointer,
      miniProgressBar: false,
      mutex: true,
      // Keep iOS Safari's video compositing stable without a frosted backdrop.
      backdrop: false,
      playsInline: true,
      // ArtPlayer rotates its web-fullscreen surface to match video orientation on
      // touch devices. iOS native fullscreen remains controlled by WebKit/system rotation.
      autoOrientation: touchPointer,
      airplay: true,
      hotkey: false,
      theme: '#ffffff',
      lang: navigator.language.toLowerCase().startsWith('zh') ? 'zh-cn' : 'en',
      moreVideoAttr: { crossOrigin: 'anonymous', playsInline: true, disablePictureInPicture: true },
      // 上/下集放在播放键右侧：换集是看剧最高频的动作，不该让用户滚回页面下方找按钮
      controls: [
        {
          name: 'prev-episode',
          index: 11,
          position: 'left',
          html: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"><path fill="currentColor" d="M6 6h2v12H6V6zm3.5 6l8.5 6V6l-8.5 6z"/></svg>',
          tooltip: '上一集 (Alt+←)',
          click: () => {
            if (propsRef.current.hasPrevEpisode) propsRef.current.onPrevEpisode?.();
          },
        },
        {
          name: 'next-episode',
          index: 12,
          position: 'left',
          html: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"><path fill="currentColor" d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>',
          tooltip: '下一集 (Alt+→)',
          click: () => {
            if (propsRef.current.hasNextEpisode) propsRef.current.onNextEpisode?.();
          },
        },
        ...(touchPointer ? [{
          name: 'native-fullscreen',
          index: 13,
          position: 'right' as const,
          html: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"><path fill="currentColor" d="M4 9V4h5v2H6v3H4zm10-5h6v6h-2V6h-4V4zM4 15h2v3h3v2H4v-5zm14 3v-3h2v5h-6v-2h4z"/></svg>',
          tooltip: '全屏播放',
          click: () => {
            const nativeVideo = art.video as NativeFullscreenVideo;
            nativeFullscreenCleanupRef.current?.();
            nativeFullscreenCleanupRef.current = requestNativeFullscreenWithFallback(
              nativeVideo,
              () => {
                if (!art.fullscreenWeb) art.fullscreenWeb = true;
              },
            );
          },
        }] : []),
      ],
      customType: {
        m3u8: (video: HTMLVideoElement, mediaUrl: string) => {
          setupHls(video, mediaUrl, true);
        },
        mp4: (video: HTMLVideoElement, mediaUrl: string) => {
          setupDirectMedia(video, mediaUrl);
        },
        webm: (video: HTMLVideoElement, mediaUrl: string) => {
          setupDirectMedia(video, mediaUrl);
        },
      },
    });
    artRef.current = art;
    // Native media events are the source of truth. Bridge them into ArtPlayer's
    // public play/pause event bus so its center and bottom controls stay in sync,
    // including pauses initiated by iOS media controls or external callers.
    const cleanupPlaybackUi = bindPlaybackUiEvents(art.video, (event) => art.emit(event));
    window.dispatchEvent(new CustomEvent('friday-player-state', { detail: { active: true } }));

    // 进度条区间可视化：初始渲染一次，换集 duration 变化时重绘
    renderSkipMarks();
    art.on('video:durationchange', renderSkipMarks);
    // 全屏切换 / 播放器尺寸变化会重建控件，色带随之被清掉，这里补一次重绘
    art.on('fullscreen', renderSkipMarks);
    art.on('fullscreenWeb', renderSkipMarks);
    art.on('resize', renderSkipMarks);

    /**
     * 倍速跨集保持（issue #955）。
     *
     * 换源会让媒体元素重新走一遍 load 算法，而该算法只动一个播放属性：
     * `playbackRate = defaultPlaybackRate`。所以只要让 defaultPlaybackRate 始终
     * 等于用户选的倍速，这次「归位」就变成空操作——而且一次覆盖全部重载路径：
     * 换集、直连失败转代理、video:error 重建，以及 hls.js 内部
     * recoverMediaError 的 detach/attach（那条路径不经过 setupHls，只在
     * loadEpisode 里补写 playbackRate 是够不着的）。
     *
     * 判断依据：归位时新值必然等于 defaultPlaybackRate，跳过即可。必须跳过——
     * 归位确实会派发 ratechange，无差别同步会把默认值自己写成 1，机制当场失效。
     */
    art.on('video:ratechange', () => {
      const video = art.video;
      if (video && video.playbackRate !== video.defaultPlaybackRate) {
        video.defaultPlaybackRate = video.playbackRate;
      }
    });

    // 播放页「记录当前」需要精确时间：不能依赖 5s 节流的 onTimeUpdate
    propsRef.current.onPlayerApi?.({
      getCurrentTime: () => {
        const current = artRef.current?.currentTime;
        return typeof current === 'number' && Number.isFinite(current) ? current : 0;
      },
      getDuration: () => {
        const duration = artRef.current?.duration;
        return typeof duration === 'number' && Number.isFinite(duration) ? duration : 0;
      },
      seek: (seconds) => {
        if (!Number.isFinite(seconds) || seconds < 0) return;
        try {
          artRef.current.currentTime = seconds;
        } catch {
          /* 忽略 */
        }
      },
      pause: () => {
        try {
          artRef.current?.pause();
        } catch {
          /* 忽略 */
        }
      },
      isPaused: () => artRef.current?.video?.paused ?? true,
      getPlaybackRate: () => {
        const rate = artRef.current?.video?.playbackRate;
        return typeof rate === 'number' && Number.isFinite(rate) ? rate : 1;
      },
      setPlaybackRate: (rate) => {
        if (!Number.isFinite(rate) || rate < 0.25 || rate > 4) return;
        const video = artRef.current?.video;
        if (!video) return;
        video.playbackRate = rate;
        video.defaultPlaybackRate = rate;
      },
    });

    /**
     * 读解码后的真实分辨率。
     * 单码率 m3u8 / mp4 直链的清单里没有画质字段，服务端无论如何探测不到，
     * 只有 video 元素的 videoHeight 是真的——这是「播放一次即记住画质」链路的唯一数据源。
     * loadedmetadata 在部分浏览器上 videoHeight 仍为 0，因此 resize / canplay / playing
     * 各补一次机会，不能只赌单一事件时机。
     */
    const reportVideoHeight = () => {
      const video = art.video;
      const height = video?.videoHeight ?? 0;
      // A single-file/native source cannot be pinned by hls.js. If a persisted
      // 1080P ceiling is active and decoded output exceeds it, stop rather than
      // silently playing above the requested ceiling.
      if (height > 1080 && !hlsRef.current && readQualityPreference() === '1080') {
        video?.pause();
        setQualityNotice('当前资源无法切换到 1080P，实际解码分辨率超过所选上限，已暂停播放。');
      }
      if (height > 0) {
        setActualQualityHeight(height);
        setActualQualityWidth(video?.videoWidth ?? 0);
        reportQuality(height);
      }
    };
    art.on('video:loadedmetadata', reportVideoHeight);
    art.on('video:canplay', reportVideoHeight);
    art.on('video:loadedmetadata', clearMetadataWatchdog);
    art.on('video:canplay', clearMetadataWatchdog);
    // resize 不在 ArtPlayer 的视频事件转发表里，直接挂原生事件
    art.video?.addEventListener('resize', reportVideoHeight);

    art.on('video:loadedmetadata', () => {
      // ArtPlayer 运行时支持 title 选项（类型定义未覆盖），用于界面标题展示
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (art as any).title = propsRef.current.title;
      } catch { /* 忽略 */ }
    });

    art.on('video:playing', () => {
      const metrics = playbackMetricsRef.current;
      if (metrics.firstFragmentMs === undefined) metrics.firstFragmentMs = Date.now() - metrics.startedAt;
      if (metrics.waiting) metrics.recoveries += 1;
      metrics.waiting = false;
      metrics.height = Math.max(metrics.height, art.video?.videoHeight ?? 0);
      playbackStartedRef.current = true;
      setShowPoster(false);
      setShowPlayFallback(false);
      // 仅在媒体真正恢复（有分片进入 buffer）后清错误遮罩：
      // 否则「视频轨挂了、音频轨先播出来」时会清掉遮罩，留下黑屏假死态
      if (mediaHealthyRef.current) setError('');
      reportVideoHeight();

      // A "playing" event alone is not proof: require currentTime to advance
      // while the element remains unpaused for a bounded observation window.
      if (!playbackConfirmedRef.current && !playbackConfirmationTimerRef.current) {
        const startTime = Number(art.currentTime) || 0;
        const startedAt = Date.now();
        playbackConfirmationTimerRef.current = setTimeout(() => {
          playbackConfirmationTimerRef.current = null;
          const video = art.video;
          const progressedSeconds = video ? (Number(video.currentTime) - startTime) : 0;
          if (video && hasSustainedPlaybackProgress({
            paused: video.paused,
            readyState: video.readyState,
            startTime,
            currentTime: Number(video.currentTime),
          })) {
            playbackConfirmedRef.current = true;
            propsRef.current.onPlaybackConfirmed?.({
              mediaType: getMediaPlaybackKind(currentMediaUrlRef.current, propsRef.current.mediaType),
              observedSeconds: Math.max(1, Math.round((Date.now() - startedAt) / 1000)),
              progressedSeconds,
              decodedWidth: video.videoWidth || 0,
              decodedHeight: video.videoHeight || 0,
              selectedRenditionHeight: hlsRef.current && hlsRef.current.currentLevel >= 0
                ? hlsRef.current.levels[hlsRef.current.currentLevel]?.height || 0
                : 0,
              selectedRenditionBitrateKbps: hlsRef.current && hlsRef.current.currentLevel >= 0
                ? (hlsRef.current.levels[hlsRef.current.currentLevel]?.bitrate || 0) / 1000
                : 0,
            });
          }
        }, 5_000);
      }
    });
    art.on('video:error', () => {
      playbackMetricsRef.current.fatalErrors += 1;
      mediaHealthyRef.current = false;
      // 起播阶段的 video 元素级错误（MSE/解码偶发失败）：重建一次播放链路自愈，
      // 而不是直接钉死错误遮罩——重建后视频轨重新 append，黑屏有声即可解除
      if (!playbackStartedRef.current && !videoErrorRetryUsedRef.current) {
        videoErrorRetryUsedRef.current = true;
        playbackMetricsRef.current.recoveries += 1;
        showHint('播放异常，正在重试...');
        setupHls(art.video, currentMediaUrlRef.current, true);
        return;
      }
      const mediaError = art.video?.error;
      const errorMessage = mediaError?.code === 1
        ? '播放请求已取消，请重新点击播放'
        : mediaError?.code === 2
          ? '视频地址或媒体分片请求失败，请更换播放源'
          : mediaError?.code === 3
            ? '媒体解码失败，请尝试其他播放源或格式'
            : mediaError?.code === 4
              ? '播放源无效或格式不受支持，请更换播放源'
              : '视频播放失败，请尝试其他视频源';
      clearMetadataWatchdog();
      setError(errorMessage);
    });
    art.on('video:timeupdate', () => {
      const metrics = playbackMetricsRef.current;
      const position = art.currentTime;
      if (metrics.lastTickAt > 0 && position > metrics.lastPosition && position - metrics.lastPosition <= 2.5) metrics.playedSeconds += position - metrics.lastPosition;
      metrics.lastPosition = position;
      metrics.lastTickAt = Date.now();
      metrics.height = Math.max(metrics.height, art.video?.videoHeight ?? 0);
      const now = Date.now();
      if (now - lastSave > 5000) {
        lastSave = now;
        propsRef.current.onTimeUpdate?.(art.currentTime, art.duration);
      }
      // —— 跳过片段判定 ——
      const p = propsRef.current;
      const current = art.currentTime;
      const duration = art.duration;
      const previous = lastSampleRef.current;
      lastSampleRef.current = current;
      const segments = resolveSegments(p.skipMark, duration);

      // 结尾片段：只认连续播放越过起点；拖动进度条、刚写入标记、进度恢复造成的大跳变
      // 都不自动结束，只显示按钮由用户决定。是否结束由合并后的 autoSkipSegments 控制
      // （片头/中段跳段，片尾结束本集，是否连播下一集仍看 autoplayNext）。
      if (
        p.autoSkipSegments &&
        restoredRef.current &&
        playbackStartedRef.current &&
        findCrossedEnding(segments, previous, current)
      ) {
        const ending = segments.find(
          (s) => s.type === 'ending' && previous < s.start && current >= s.start
        );
        finishBySkip(ending);
        return;
      }

      // 片头/中段片段：命中则自动跳到末尾（同一类操作，共用 autoSkipSegments 开关）；
      // 已处理过的片段本集不再反复拉扯。
      const active = findActiveSegment(segments, current);
      if (
        active &&
        active.type !== 'ending' &&
        p.autoSkipSegments &&
        !handledSegmentsRef.current.has(segmentKey(active)) &&
        !suppressedAutoRef.current.has(segmentKey(active)) &&
        restoredRef.current &&
        playbackStartedRef.current
      ) {
        if (skipTo(active.end)) {
          handledSegmentsRef.current.add(segmentKey(active));
          rememberSkip(current, active);
          showHint(active.type === 'opening' ? '已跳过片头' : '已跳过中段');
        }
      }

      // 按钮提示：当前落在某个未处理片段内（结尾片段显示「跳过片尾」）
      const prompt =
        active && !handledSegmentsRef.current.has(segmentKey(active)) ? active : null;
      updateSkipPrompt(prompt);
    });
    art.on('video:seeked', () => {
      // seek 是用户主动行为：拉平采样基准，避免下一拍被误判为「连续越过片尾」。
      // 暂停中 seek 不会触发 timeupdate，这里也同步刷新按钮的显隐。
      const current = art.currentTime;
      lastSampleRef.current = current;
      const segments = resolveSegments(propsRef.current.skipMark, art.duration);
      const active = findActiveSegment(segments, current);
      const prompt =
        active && !handledSegmentsRef.current.has(segmentKey(active)) ? active : null;
      updateSkipPrompt(prompt);
    });
    art.on('video:pause', () => {
      if (playbackConfirmationTimerRef.current) {
        clearTimeout(playbackConfirmationTimerRef.current);
        playbackConfirmationTimerRef.current = null;
      }
      // 跳过片尾会主动 pause：此时已按「看完」处理，不能再把片尾位置写回进度
      if (!endedRef.current) propsRef.current.onPause?.(art.currentTime, art.duration);
    });
    art.on('video:waiting', () => {
      const metrics = playbackMetricsRef.current;
      if (!art.video?.paused && !metrics.waiting) { metrics.stalls += 1; metrics.waiting = true; }
      // 缓冲不足时彻底停止预取，释放所有并发请求给当前播放链路。
      getVideoPrefetcher().stop();
    });
    art.on('video:playing', () => {
      // 恢复播放后停止暂停期间的预取，避免后台请求持续抢占带宽。
      getVideoPrefetcher().stop();
    });
    art.on('video:ended', () => {
      flushPlaybackMetrics();
      // finishBySkip 已经手动走过结束链路：这里不能重复触发 onEnded
      if (endedRef.current) return;
      endedRef.current = true;
      updateSkipPrompt(null);
      propsRef.current.onEnded?.();
    });

    // —— 键盘快捷键（旧版 hotkey:false + 自定义逻辑的移植） ——
    const shortcuts = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      // 输入框或按钮获得焦点时不劫持按键：否则空格会吞掉按钮的默认激活
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.closest('button')) return;
      const current = artRef.current;
      if (!current) return;
      if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); return; } // 由父层处理集数切换
      if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); return; }
      switch (e.key) {
        case 'ArrowLeft':
          if (current.currentTime > 5) { current.currentTime -= 5; showHint('快退 5s'); e.preventDefault(); }
          break;
        case 'ArrowRight':
          if (current.duration - current.currentTime > 5) { current.currentTime += 5; showHint('快进 5s'); e.preventDefault(); }
          break;
        case 'ArrowUp':
          if (current.volume < 1) { current.volume = Math.min(1, current.volume + 0.1); showHint(`音量 ${Math.round(current.volume * 100)}%`); e.preventDefault(); }
          break;
        case 'ArrowDown':
          if (current.volume > 0) { current.volume = Math.max(0, current.volume - 0.1); showHint(`音量 ${Math.round(current.volume * 100)}%`); e.preventDefault(); }
          break;
        case ' ':
          current.toggle(); showHint('播放/暂停'); e.preventDefault();
          break;
        case 'f': case 'F':
          current.fullscreen = !current.fullscreen; e.preventDefault();
          break;
        // 标记类快捷键一律要求 Shift：这几键会直接写盘并影响整部剧，
        // 单键太容易误触（误记片头 = 之后每集都被跳过一大段）
        case 'i': case 'I':
          if (!e.shiftKey) break;
          propsRef.current.onRecordSegment?.({
            type: 'opening',
            start: 0,
            end: round1(current.currentTime),
          });
          e.preventDefault();
          break;
        case 'o': case 'O':
          if (!e.shiftKey) break;
          propsRef.current.onRecordSegment?.({
            type: 'ending',
            start: round1(current.currentTime),
            end: -1,
          });
          e.preventDefault();
          break;
        case 's': case 'S':
          if (!e.shiftKey) break;
          propsRef.current.onPendingStart(round1(current.currentTime));
          showHint('片段起点已记录，播放到终点后按 Shift+E');
          e.preventDefault();
          break;
        case 'e': case 'E': {
          if (!e.shiftKey) break;
          const start = propsRef.current.pendingStart;
          if (start === null) {
            showHint('请先按 Shift+S 记录片段起点');
          } else {
            const end = round1(current.currentTime);
            propsRef.current.onPendingStart(null);
            propsRef.current.onRecordSegment?.({ type: 'middle', start, end });
          }
          e.preventDefault();
          break;
        }
      }
    };
    document.addEventListener('keydown', shortcuts);

    // —— 移动端长按 3 倍速 ——
    let longPressTimer: ReturnType<typeof setTimeout> | null = null;
    let isLongPress = false;
    let originalRate = 1.0;
    const el = containerRef.current;

    // 全屏时播放器覆盖整个视口，无法依赖 mouseleave 判断“移出播放器”。
    // 改为按鼠标活动计时：停止移动后快速收起控制栏，移动时立即显示。
    let controlHideTimer: ReturnType<typeof setTimeout> | null = null;
    const showControlsOnPointerMove = () => {
      art.controls.show = true;
      if (controlHideTimer) clearTimeout(controlHideTimer);
      controlHideTimer = setTimeout(() => {
        if (!art.setting.show) art.controls.show = false;
      }, 800);
    };
    const hideControlsOnMouseLeave = () => {
      if (controlHideTimer) clearTimeout(controlHideTimer);
      controlHideTimer = null;
      art.controls.show = false;
    };
    // 触屏不监听 mousemove/mouseleave，也跳过初始显示：iOS 点按视频的合成事件
    // 序列是 mousemove → click，若 mousemove 先把 show 置 true，紧跟的 ArtPlayer
    // click toggle 会把它翻回 false——控制栏「闪一下即隐」，正是 issue #937 的病灶
    if (!touchPointer) {
      el?.addEventListener('mousemove', showControlsOnPointerMove);
      el?.addEventListener('mouseleave', hideControlsOnMouseLeave);
      showControlsOnPointerMove();
    }

    const onTouchStart = (e: TouchEvent) => {
      if (art.video?.paused) return;
      // 已有触控在处理时忽略新手指：否则第二指会把 originalRate 捕获成 3.0，
      // 松手后倍速永久卡在 3x；旧定时器句柄也会被覆盖成无法清除的幽灵触发
      if (isLongPress || longPressTimer) return;
      // 控制栏 / 设置面板上的长按不触发倍速（按住进度条拖动、长按倍速菜单项会误触）
      if ((e.target as HTMLElement).closest?.('.art-controls, .art-settings')) return;
      originalRate = art.video.playbackRate;
      longPressTimer = setTimeout(() => {
        if (art.video?.paused) return;
        art.video.playbackRate = 3.0;
        isLongPress = true;
        showHint('3 倍速');
      }, 500);
    };
    const onTouchEnd = () => {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      if (isLongPress) {
        art.video.playbackRate = originalRate;
        isLongPress = false;
        showHint(`${originalRate} 倍速`);
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (isLongPress) e.preventDefault();
    };
    // ArtPlayer 的 contextmenu 组件只在桌面端初始化（移动端构造函数里跳过 init），
    // 长按倍速因而会连带呼出系统原生菜单/气泡。播放器表面没有可用的原生菜单，统一抑制
    const onContextMenu = (e: Event) => e.preventDefault();
    el?.addEventListener('touchstart', onTouchStart, { passive: false });
    el?.addEventListener('touchend', onTouchEnd);
    el?.addEventListener('touchcancel', onTouchEnd);
    el?.addEventListener('touchmove', onTouchMove, { passive: false });
    el?.addEventListener('contextmenu', onContextMenu);

    // 卸载与页面隐藏时保存进度
    const saveOnHide = () => {
      if (document.visibilityState === 'hidden' && !endedRef.current) {
        propsRef.current.onPause?.(art.currentTime, art.duration);
      }
    };
    document.addEventListener('visibilitychange', saveOnHide);

    return () => {
      flushPlaybackMetrics();
      // 卸载前刷一次最终进度，避免丢失最后几秒。
      // 已自然播完的集数不回写，避免覆盖 onEnded 里清除的「已看完」记录
      if (!endedRef.current) {
        try {
          propsRef.current.onPause?.(art.currentTime, art.duration);
        } catch { /* 忽略 */ }
      }
      document.removeEventListener('keydown', shortcuts);
      document.removeEventListener('visibilitychange', saveOnHide);
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
      nativeFullscreenCleanupRef.current?.();
      nativeFullscreenCleanupRef.current = null;
      cleanupPlaybackUi();
      if (playbackConfirmationTimerRef.current) clearTimeout(playbackConfirmationTimerRef.current);
      clearMetadataWatchdog();
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
      el?.removeEventListener('touchstart', onTouchStart);
      el?.removeEventListener('touchend', onTouchEnd);
      el?.removeEventListener('touchcancel', onTouchEnd);
      el?.removeEventListener('touchmove', onTouchMove);
      el?.removeEventListener('contextmenu', onContextMenu);
      art.video?.removeEventListener('resize', reportVideoHeight);
      el?.removeEventListener('mousemove', showControlsOnPointerMove);
      el?.removeEventListener('mouseleave', hideControlsOnMouseLeave);
      if (controlHideTimer) clearTimeout(controlHideTimer);
      restoreCleanupRef.current?.();
      restoreCleanupRef.current = null;
      Artplayer.CONTROL_HIDE_TIME = ART_DEFAULT_CONTROL_HIDE_MS;
      if (qualityPreferenceHandlerRef.current) {
        window.removeEventListener('libretv-quality-preference-change', qualityPreferenceHandlerRef.current);
        qualityPreferenceHandlerRef.current = null;
      }
      hlsRef.current?.destroy();
      hlsRef.current = null;
      recoveryRef.current?.dispose();
      getVideoPrefetcher().stop();
      // 播放页可能仍持有读取接口：销毁前显式置空，避免「记录当前」读到已销毁实例
      propsRef.current.onPlayerApi?.(null);
      art.destroy();
      artRef.current = null;
      window.dispatchEvent(new CustomEvent('friday-player-state', { detail: { active: false } }));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // —— 上/下集禁用态：走 ArtPlayer 的 controls API 更新样式，不直接改 DOM ——
  // 直接 querySelector 改 style 在控件重建（切全屏/播放器重绘）后不会恢复，且依赖内部 class 名。
  useEffect(() => {
    const controls = artRef.current?.controls;
    if (!controls) return;
    controls.update({
      name: 'prev-episode',
      style: { opacity: hasPrevEpisode ? '1' : '0.4', pointerEvents: hasPrevEpisode ? 'auto' : 'none' },
    });
    controls.update({
      name: 'next-episode',
      style: { opacity: hasNextEpisode ? '1' : '0.4', pointerEvents: hasNextEpisode ? 'auto' : 'none' },
    });
  }, [hasPrevEpisode, hasNextEpisode, url]);

  // —— 标记变化：重置采样基准并立即刷新提示 ——
  // 刚写入片段时当前时间可能恰好等于新边界，若沿用上一拍采样会被判成
  // 「连续越过」而当场触发；把基准拉平后本集只保留手动按钮，下一集才自动。
  // 顺带覆盖暂停中修改标记的场景（没有 timeupdate 也要让按钮即时出现/消失）。
  useEffect(() => {
    const art = artRef.current;
    if (!art) return;
    const current = art.currentTime;
    lastSampleRef.current = Number.isFinite(current) ? current : 0;
    const segments = resolveSegments(skipMark, art.duration);
    const active = findActiveSegment(segments, current);
    const prompt =
      active && !handledSegmentsRef.current.has(segmentKey(active)) ? active : null;
    updateSkipPrompt(prompt);
    renderSkipMarks();
  }, [skipMark]);

  // —— 换集：仅切换 HLS 源，不重建播放器（保留网页全屏等状态） ——
  const firstUrlRef = useRef(true);
  useEffect(() => {
    // 挂载时的首次由创建 effect 的 customType 触发，跳过避免重复加载
    if (firstUrlRef.current) { firstUrlRef.current = false; return; }
    loadEpisode(url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // —— 广告过滤开关变化：重建 HLS loader（无需重建整个播放器） ——
  const firstAdFilterRef = useRef(true);
  useEffect(() => {
    if (firstAdFilterRef.current) { firstAdFilterRef.current = false; return; }
    if (artRef.current && hlsRef.current) {
      // 用当前实际媒体地址：代理回退生效时切广告过滤不应跳回直连形式
      loadEpisode(currentMediaUrlRef.current || propsRef.current.url);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adFilter]);

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="w-full h-full" style={{ WebkitTouchCallout: 'none' }} />
      <div className="player-quality-controls absolute right-3 top-3 z-20 flex flex-col items-end gap-2">
        <button
          type="button"
          className="player-quality-badge"
          aria-expanded={qualityPanelOpen}
          aria-label="画质设置"
          onClick={() => setQualityPanelOpen((open) => !open)}
        >
          画质 · {qualityPreference === 'auto' ? '自动' : qualityPreference === '1080' ? '1080P' : '4K优先'}
          <span className="ml-2 text-white/70">{actualQualityHeight > 0 ? `当前 ${actualQualityHeight}P` : '检测中'}</span>
        </button>
        {qualityPanelOpen && (
          <div className="w-64 max-w-[calc(100vw-2rem)] rounded-xl border border-white/15 bg-black/90 p-3 text-white shadow-2xl backdrop-blur-xl">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold">播放画质</span>
              <span className="text-[10px] text-white/55">{qualityControlMode === 'hls' ? 'HLS 档位控制' : qualityControlMode === 'native' ? '浏览器原生 HLS' : '单文件 / 直链'}</span>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {([
                ['auto', '自动'],
                ['1080', '1080P'],
                ['4k', '4K优先'],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={qualityPreference === value}
                  className={`rounded-lg px-2 py-2 text-xs transition ${qualityPreference === value ? 'bg-white text-black' : 'bg-white/10 text-white hover:bg-white/20'}`}
                  onClick={() => {
                    try {
                      window.localStorage.setItem(QUALITY_PREFERENCE_KEY, value === '4k' ? '2160' : value);
                    } catch { /* Keep this session's selection even if storage is unavailable. */ }
                    setQualityPreference(value);
                    setQualityNotice('');
                    unsustainableFragmentsRef.current = 0;
                    sustainableFragmentsRef.current = 0;
                    setNetworkQualityWarning('');
                    window.dispatchEvent(new Event('libretv-quality-preference-change'));
                    if (value === 'auto') {
                      void artRef.current?.play?.();
                    }
                    if (qualityControlMode === 'native' && value !== 'auto') {
                      if (value === '1080') artRef.current?.pause();
                      if (value === '4k') void artRef.current?.play?.();
                      setQualityNotice(value === '1080'
                        ? '原生 HLS 无法强制限制在 1080P，已暂停以免播放超过所选上限；请选择自动继续播放。'
                        : '原生 HLS 不支持强制锁定 4K；Safari 会自行选择档位，源站 4K 档位也无法在此路径验证。');
                    } else if (qualityControlMode === 'single' && value !== 'auto') {
                      if (value === '1080' && (actualQualityHeight === 0 || actualQualityHeight > 1080)) {
                        artRef.current?.pause();
                        setQualityNotice('当前是单文件直链，无法切换或限制分辨率；实际画质未确认在 1080P 以下，已暂停以免超过所选上限。');
                      } else {
                        void artRef.current?.play?.();
                        setQualityNotice('当前资源是单文件直链，没有可切换的多档清晰度；显示值为实际解码画质。');
                      }
                    }
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="mt-3 space-y-1 text-xs text-white/75">
              <p>源站 4K：{getAdvertised4kStatus(availableQualityHeights, availableQualityLevelCount, qualityMetadataComplete) === 'advertised' ? 'HLS 清单声明有 4K（不代表当前解码为 4K）' : getAdvertised4kStatus(availableQualityHeights, availableQualityLevelCount, qualityMetadataComplete) === 'not-advertised' ? 'HLS 清单未声明 4K' : '无法验证（档位分辨率元数据缺失）'}</p>
              <p>可用档位：{availableQualityHeights.length ? availableQualityHeights.map((height) => `${height}P`).join(' / ') : availableQualityLevelCount > 0 ? `已读取 ${availableQualityLevelCount} 个 HLS 档位，但分辨率元数据缺失` : '暂不可读取'}</p>
              <p>当前实际解码：{actualQualityHeight > 0 ? `${actualQualityWidth > 0 ? `${actualQualityWidth}×` : ''}${actualQualityHeight}（${actualQualityHeight}P）` : '等待视频解码'}</p>
              <p>当前 HLS 档位：{qualityControlMode !== 'hls' ? '当前播放路径不支持档位读取' : selectedHlsRendition ? `Level ${selectedHlsRendition.index} · ${selectedHlsRendition.height > 0 ? `${selectedHlsRendition.height}P` : '分辨率未知'} · ${selectedHlsRendition.bitrate > 0 ? `${(selectedHlsRendition.bitrate / 1_000_000).toFixed(2)} Mbps` : '码率未知'}` : '等待 HLS 选择档位'}</p>
              <p>实测视频片段码率：{observedMediaBitrateKbps > 0 ? `${(observedMediaBitrateKbps / 1000).toFixed(2)} Mbps` : '等待视频分片'}</p>
              <p>最近分片下载吞吐：{observedThroughputKbps > 0 ? `${(observedThroughputKbps / 1000).toFixed(2)} Mbps` : '等待网络采样'}</p>
              {qualityNotice && <p role="status" className="pt-1 text-amber-300">{qualityNotice}</p>}
              {networkQualityWarning && <p role="alert" className="pt-1 text-amber-300">{networkQualityWarning}</p>}
            </div>
          </div>
        )}
      </div>
      {showPoster && !error && (
        <div
          className="absolute inset-0 bg-black pointer-events-none"
          style={{
            backgroundImage: 'url(/player-poster.png)',
            backgroundSize: 'contain',
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
          }}
        />
      )}
      {showPlayFallback && showPoster && !error && (
        <button
          type="button"
          className="absolute inset-x-0 top-1/2 z-20 mx-auto min-h-11 w-fit -translate-y-1/2 rounded-full border border-white/20 bg-black/75 px-6 py-3 text-sm font-semibold text-white shadow-lg backdrop-blur-xl"
          onClick={() => {
            const art = artRef.current;
            if (!art) return;
            void art.play().then(() => setShowPlayFallback(false)).catch(() => {
              showHint('暂时无法播放，请检查视频源或轻点播放控件重试');
            });
          }}
        >
          轻点开始播放
        </button>
      )}
      {!error && skipPrompt && (
        <button
          type="button"
          className="absolute bottom-16 left-1/2 -translate-x-1/2 z-10 rounded-full bg-black/70 px-4 py-2 text-sm text-white transition-colors hover:bg-black/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          onClick={() => {
            if (skipPrompt.type === 'ending') {
              finishBySkip(skipPrompt);
              return;
            }
            const from = artRef.current?.currentTime ?? 0;
            if (skipTo(skipPrompt.end)) {
              handledSegmentsRef.current.add(segmentKey(skipPrompt));
              rememberSkip(from, skipPrompt);
              updateSkipPrompt(null);
              showHint(skipPrompt.type === 'opening' ? '已跳过片头' : '已跳过中段');
            }
          }}
        >
          {skipPrompt.type === 'ending'
            ? '跳过片尾'
            : skipPrompt.type === 'opening'
              ? '跳过片头'
              : '跳过中段'}
        </button>
      )}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/80">
          <p className="text-danger text-sm">{error}</p>
          <button className="btn-ghost text-xs" onClick={() => location.reload()}>
            重新加载
          </button>
        </div>
      )}
      {(hint || undoSkip) && (
        <div role="status" className="absolute top-3 left-3 z-30 flex max-w-[min(72%,360px)] items-center gap-1.5 rounded-full border border-white/10 bg-black/55 px-2.5 py-1 text-[10px] leading-tight text-white/90 shadow-sm backdrop-blur-xl animate-fade-in">
          {/* 撤销窗口比普通提示长：hint 已淡出时仍要让用户知道刚才跳过了什么 */}
          <span className="pointer-events-none">
            {hint || (undoSkip ? `已跳过${SEGMENT_LABELS[undoSkip.segment.type]}` : '')}
          </span>
          {undoSkip && (
            <button
              type="button"
              className="pointer-events-auto shrink-0 rounded-full bg-white/20 px-2 py-0.5 text-xs font-medium transition-colors hover:bg-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              onClick={undoLastSkip}
            >
              撤销
            </button>
          )}
        </div>
      )}

    </div>
  );
}
