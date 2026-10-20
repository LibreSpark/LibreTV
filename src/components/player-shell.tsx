'use client';

import { useEffect, useRef, useState } from 'react';
import Artplayer from 'artplayer';
import Hls, { type HlsConfig } from 'hls.js';

import { PlaybackRecovery, describeHlsError } from '@/lib/playback-recovery';
import { createHlsLoader } from '@/lib/hls-loader';
import {
  getVideoPrefetcher,
  getNextEpisodePrefetcher,
} from '@/lib/video-prefetcher';
import { loadCacheSettings } from '@/lib/video-cache';
import { formatTime } from '@/lib/utils';
import { prefersTouchPointer } from '@/lib/touch-pointer';
import {
  hasCrossedOutro,
  isIntroActive,
  resolveSkipWindow,
  type SkipMark,
} from '@/lib/skip-marks';
import {
  ART_DEFAULT_CONTROL_HIDE_MS,
  DESKTOP_CONTROL_HIDE_MS,
  TOUCH_CONTROL_HIDE_MS,
} from '@/lib/control-hide';

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
}

interface PlayerShellProps {
  url: string;
  title: string;
  adFilter: boolean;
  autoplayNext: boolean;
  /** 当前剧的片头片尾标记（父级按归一化剧名查好后传入，换集/换源不变） */
  skipMark?: SkipMark;
  /** 命中片头标记时自动跳到片头结束 */
  autoSkipIntro: boolean;
  /** 连续播放越过片尾标记时自动结束本集 */
  autoSkipOutro: boolean;
  /** 播放器创建/销毁时回调，供播放页读取精确播放位置 */
  onPlayerApi?: (api: PlayerSkipApi | null) => void;
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
  adFilter,
  autoplayNext,
  skipMark,
  autoSkipIntro,
  autoSkipOutro,
  onPlayerApi,
  episodeKey,
  nextUrl,
  nextEpisodeKey,
  getRestorePosition,
  onTimeUpdate,
  onEnded,
  onPause,
  onQuality,
  onRequestSwitchSource,
  onPrevEpisode,
  onNextEpisode,
  hasPrevEpisode,
  hasNextEpisode,
}: PlayerShellProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const artRef = useRef<any>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [error, setError] = useState('');
  const [hint, setHint] = useState('');
  // 起播前的品牌占位图（沿用旧版 nomedia 素材），实际开始播放后隐藏
  const [showPoster, setShowPoster] = useState(true);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 始终持有最新 props/回调，避免重建播放器
  const propsRef = useRef({
    url, title, adFilter, autoplayNext, skipMark, autoSkipIntro, autoSkipOutro, onPlayerApi,
    episodeKey, nextUrl, nextEpisodeKey,
    getRestorePosition, onTimeUpdate, onEnded, onPause, onQuality, onRequestSwitchSource,
    onPrevEpisode, onNextEpisode, hasPrevEpisode, hasNextEpisode,
  });
  propsRef.current = {
    url, title, adFilter, autoplayNext, skipMark, autoSkipIntro, autoSkipOutro, onPlayerApi,
    episodeKey, nextUrl, nextEpisodeKey,
    getRestorePosition, onTimeUpdate, onEnded, onPause, onQuality, onRequestSwitchSource,
    onPrevEpisode, onNextEpisode, hasPrevEpisode, hasNextEpisode,
  };

  /** 上报实测画质：多次上报取大值由调用方决定，这里只管把拿到的高度传出去 */
  const reportQuality = (height: number) => {
    if (height > 0) propsRef.current.onQuality?.(height);
  };

  // 跨集共享、每次换集重置的播放链路状态
  // 媒体健康度：音频轨可播不代表视频轨正常（「黑屏但有声」的假死态）。
  // 仅当有分片真正进入 MSE buffer 后才视为恢复，错误遮罩才能被清除。
  const mediaHealthyRef = useRef(true);
  const playbackStartedRef = useRef(false);
  // 起播阶段的 video 元素级错误允许自愈重试一次（重建 hls/MSE）
  const videoErrorRetryUsedRef = useRef(false);
  // 进度恢复每集只执行一次（MANIFEST_PARSED 可能因代理回退再次触发）
  const restoredRef = useRef(false);
  // 某些 HLS 源在 MANIFEST_PARSED 时 duration 仍未就绪，延迟到媒体元数据可用后恢复
  const restoreCleanupRef = useRef<(() => void) | null>(null);
  // timeupdate 续跑预取的游标：必须按集清零，否则会沿用上一集的时间戳推迟首次续跑
  const lastPrefetchEnsureRef = useRef(0);
  // setupHls 可能改走代理形式，video:error 重试要用最近一次的地址
  const currentMediaUrlRef = useRef(url);
  // 本集的恢复策略实例：跨直连/代理两级重建共享计数
  const recoveryRef = useRef<PlaybackRecovery | null>(null);
  // 自然播完标记，卸载时不回写进度（避免覆盖「已看完」记录）
  const endedRef = useRef(false);
  // 片头/片尾：每集各只处理一次，换集时重置（见 loadEpisode）
  const introHandledRef = useRef(false);
  const outroHandledRef = useRef(false);
  // 上一次 timeupdate 的位置：用于区分「连续播放越过片尾」与「拖动进度条」
  const lastSampleRef = useRef(0);
  // 跳过按钮提示；用 ref 比较，避免 timeupdate 每 250ms 触发重渲染
  const [skipPrompt, setSkipPrompt] = useState<'intro' | 'outro' | null>(null);
  const skipPromptRef = useRef<'intro' | 'outro' | null>(null);

  const showHint = (text: string) => {
    setHint(text);
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    hintTimerRef.current = setTimeout(() => setHint(''), 2500);
  };

  // 片段缓存开启时调大 hls.js 自身缓冲，缓冲之外的空窗由预取器补齐
  const buildHlsConfig = (): Partial<HlsConfig> => {
    const p = propsRef.current;
    const cacheSettings = loadCacheSettings();
    const cacheEnabled = cacheSettings.enabled && !!p.episodeKey;
    return {
      debug: false,
      enableWorker: true,
      backBufferLength: 90,
      maxBufferLength: cacheEnabled ? 120 : 30,
      maxMaxBufferLength: cacheEnabled ? 600 : 60,
      maxBufferSize: (cacheEnabled ? 90 : 30) * 1000 * 1000,
      maxBufferHole: 0.5,
      fragLoadingMaxRetry: 6,
      fragLoadingRetryDelay: 1000,
      manifestLoadingMaxRetry: 3,
      manifestLoadingRetryDelay: 1000,
      startLevel: -1,
      abrEwmaDefaultEstimate: 500_000,
      appendErrorMaxRetry: 5,
      // 组合 loader：广告过滤（blockAd 随设置）+ 片段缓存命中（cacheEnabled）
      loader: createHlsLoader(Hls, { blockAd: p.adFilter }) as unknown as HlsConfig['loader'],
    };
  };

  // 当前集预取（episodeKey 缺省 = 关闭，见 ensure 内部 settings.enabled 判断）
  const ensurePrefetch = (mediaUrl: string, currentTime: number, horizonSeconds?: number) => {
    const p = propsRef.current;
    if (!p.episodeKey) return;
    getVideoPrefetcher().ensure({
      m3u8Url: mediaUrl,
      currentTime,
      episodeKey: p.episodeKey,
      horizonSeconds,
      onProgress: (stats) => {
        // 当前集预取完成且存在下一集：用独立预取器预热下一集前 7 分钟
        if (stats.state === 'done' && p.nextUrl && p.nextEpisodeKey) {
          getNextEpisodePrefetcher().ensure({
            m3u8Url: p.nextUrl,
            currentTime: 0,
            episodeKey: p.nextEpisodeKey,
            horizonSeconds: 420,
          });
        }
      },
    });
  };

  /** 切换提示状态；相同值直接返回，避免 timeupdate 高频 setState */
  const updateSkipPrompt = (next: 'intro' | 'outro' | null) => {
    if (skipPromptRef.current === next) return;
    skipPromptRef.current = next;
    setSkipPrompt(next);
  };

  /** 跳到片头结束并续跑预取；同步 lastSampleRef，避免下一拍被误判为「连续越过片尾」 */
  const skipTo = (seconds: number) => {
    const art = artRef.current;
    if (!art || !Number.isFinite(seconds) || seconds < 0) return;
    try {
      art.currentTime = seconds;
    } catch {
      /* 媒体尚未就绪时忽略，下一次 timeupdate 会再次判定 */
    }
    lastSampleRef.current = seconds;
    ensurePrefetch(currentMediaUrlRef.current, seconds);
  };

  /**
   * 跳过片尾：与自然播完共用 onEnded 链路（清进度 + 依 autoplayNext 连播下一集）。
   * endedRef 置 true 同时阻止 video:ended 重复回调，也避免卸载时把片尾进度回写。
   */
  const finishBySkip = () => {
    const art = artRef.current;
    outroHandledRef.current = true;
    endedRef.current = true;
    updateSkipPrompt(null);
    try {
      art?.pause();
    } catch {
      /* 忽略 */
    }
    showHint('已跳过片尾');
    propsRef.current.onEnded?.();
  };

  /**
   * 初始化/切换 HLS。allowProxyFallback：直连致命网络错误（CORS/防盗链/分片被拒）时，
   * 自动改走同源 cookie 鉴权的 /api/proxy 重试一次。
   * 注意：不销毁 ArtPlayer，只销毁并重建 hls，从而保留网页全屏等播放器状态。
   */
  const setupHls = (video: HTMLVideoElement, mediaUrl: string, allowProxyFallback: boolean) => {
    restoreCleanupRef.current?.();
    restoreCleanupRef.current = null;
    hlsRef.current?.destroy();
    currentMediaUrlRef.current = mediaUrl;
    const hls = new Hls(buildHlsConfig());
    hlsRef.current = hls;

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
        ensurePrefetch(mediaUrl, prefetchAnchor);
        video.play().catch(() => {});
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

    hls.loadSource(mediaUrl);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      recoveryRef.current?.markHealthy();
      // master playlist 的档位高度：多码率源在这里就能拿到上限
      const heights = hls.levels
        .map((level) => level.height)
        .filter((h): h is number => typeof h === 'number' && h > 0);
      if (heights.length > 0) reportQuality(Math.max(...heights));
      // 进度恢复改由 restoreAndStart 处理：duration 未就绪时不消费标记，挂事件重试
      void restoreAndStart();
    });
    // 播放链路恢复（FRAG_LOADED / MANIFEST_PARSED）：静默窗外清零连续失败计数
    hls.on(Hls.Events.FRAG_LOADED, () => recoveryRef.current?.markHealthy());
    // 单码率源在 MANIFEST 阶段拿不到 height（清单尚未解析），这里补一次。
    // 注意 data.level 是档位下标，分辨率在 levelInfo 上
    hls.on(Hls.Events.LEVEL_LOADED, (_evt, data) => {
      const height = data.levelInfo?.height;
      if (typeof height === 'number') reportQuality(height);
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
    mediaHealthyRef.current = true;
    playbackStartedRef.current = false;
    videoErrorRetryUsedRef.current = false;
    restoredRef.current = false;
    lastPrefetchEnsureRef.current = 0;
    // 片头/片尾按集重置：上一集已处理过不意味新一集也处理过
    introHandledRef.current = false;
    outroHandledRef.current = false;
    lastSampleRef.current = 0;
    endedRef.current = false;
    updateSkipPrompt(null);
    recoveryRef.current = new PlaybackRecovery();
    // 换集时清掉上一集的预取窗口，避免带宽被旧集占用
    getVideoPrefetcher().stop();
    setError('');
    setShowPoster(true);
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
    mediaHealthyRef.current = true;
    playbackStartedRef.current = false;
    videoErrorRetryUsedRef.current = false;
    restoredRef.current = false;
    recoveryRef.current = new PlaybackRecovery();
    endedRef.current = false;
    introHandledRef.current = false;
    outroHandledRef.current = false;
    lastSampleRef.current = 0;

    let lastSave = 0;

    const art = new Artplayer({
      container: containerRef.current,
      url: initialUrl,
      type: 'm3u8',
      volume: 0.8,
      autoplay: true,
      pip: true,
      autoMini: true,
      screenshot: true,
      setting: true,
      playbackRate: true,
      aspectRatio: true,
      fullscreen: true,
      fullscreenWeb: true,
      miniProgressBar: true,
      mutex: true,
      backdrop: true,
      playsInline: true,
      airplay: true,
      hotkey: false,
      theme: '#2563eb',
      lang: navigator.language.toLowerCase().startsWith('zh') ? 'zh-cn' : 'en',
      moreVideoAttr: { crossOrigin: 'anonymous', playsInline: true },
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
      ],
      customType: {
        m3u8: (video: HTMLVideoElement, mediaUrl: string) => {
          setupHls(video, mediaUrl, true);
        },
      },
    });
    artRef.current = art;

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
    });

    /**
     * 读解码后的真实分辨率。
     * 单码率 m3u8 / mp4 直链的清单里没有画质字段，服务端无论如何探测不到，
     * 只有 video 元素的 videoHeight 是真的——这是「播放一次即记住画质」链路的唯一数据源。
     * loadedmetadata 在部分浏览器上 videoHeight 仍为 0，因此 resize / canplay / playing
     * 各补一次机会，不能只赌单一事件时机。
     */
    const reportVideoHeight = () => {
      const height = art.video?.videoHeight;
      if (typeof height === 'number' && height > 0) reportQuality(height);
    };
    art.on('video:loadedmetadata', reportVideoHeight);
    art.on('video:canplay', reportVideoHeight);
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
      playbackStartedRef.current = true;
      setShowPoster(false);
      // 仅在媒体真正恢复（有分片进入 buffer）后清错误遮罩：
      // 否则「视频轨挂了、音频轨先播出来」时会清掉遮罩，留下黑屏假死态
      if (mediaHealthyRef.current) setError('');
      reportVideoHeight();
    });
    art.on('video:error', () => {
      mediaHealthyRef.current = false;
      // 起播阶段的 video 元素级错误（MSE/解码偶发失败）：重建一次播放链路自愈，
      // 而不是直接钉死错误遮罩——重建后视频轨重新 append，黑屏有声即可解除
      if (!playbackStartedRef.current && !videoErrorRetryUsedRef.current) {
        videoErrorRetryUsedRef.current = true;
        showHint('播放异常，正在重试...');
        setupHls(art.video, currentMediaUrlRef.current, true);
        return;
      }
      setError('视频播放失败，请尝试其他视频源');
    });
    art.on('video:timeupdate', () => {
      const now = Date.now();
      if (now - lastSave > 5000) {
        lastSave = now;
        propsRef.current.onTimeUpdate?.(art.currentTime, art.duration);
      }
      // 每 30s 续跑一次前向预取窗口（ensure 幂等，窗口未覆盖足够余量才会重建）
      if (now - lastPrefetchEnsureRef.current > 30_000) {
        lastPrefetchEnsureRef.current = now;
        // 用 currentMediaUrlRef（代理回退后的实际地址）：否则预取的 key 与
        // loader 读取的 key 不一致，缓存永不命中且直连 fetch 白耗流量
        ensurePrefetch(currentMediaUrlRef.current, art.currentTime);
      }

      // —— 片头 / 片尾跳过 ——
      const p = propsRef.current;
      const current = art.currentTime;
      const duration = art.duration;
      const previous = lastSampleRef.current;
      lastSampleRef.current = current;
      const window = resolveSkipWindow(p.skipMark, duration);

      // 片头：一旦自然越过或已自动跳转，本集不再处理；用户之后拖回片头也不会被反复拉扯。
      // 必须等进度恢复完成（restoredRef）且已真正开始播放，否则会先跳到片头结束、
      // 再被 restoreAndStart 拉回断点处。
      if (window.introEnd !== undefined && !introHandledRef.current) {
        if (current >= window.introEnd) {
          introHandledRef.current = true;
        } else if (
          p.autoSkipIntro &&
          restoredRef.current &&
          playbackStartedRef.current &&
          isIntroActive(current, window)
        ) {
          introHandledRef.current = true;
          skipTo(window.introEnd);
          showHint('已跳过片头');
        }
      }

      // 片尾：只认连续播放越过边界；拖动进度条、刚写入标记、进度恢复造成的大跳变
      // 都不自动结束，只显示按钮由用户决定。
      if (window.outroStart !== undefined && !outroHandledRef.current) {
        if (current >= duration - 0.5) {
          outroHandledRef.current = true;
        } else if (
          p.autoSkipOutro &&
          playbackStartedRef.current &&
          hasCrossedOutro(previous, current, window)
        ) {
          finishBySkip();
          return;
        }
      }

      const introActive =
        window.introEnd !== undefined && !introHandledRef.current && isIntroActive(current, window);
      const outroActive =
        window.outroStart !== undefined && !outroHandledRef.current && current >= window.outroStart;
      updateSkipPrompt(introActive ? 'intro' : outroActive ? 'outro' : null);
    });
    art.on('video:seeked', () => {
      ensurePrefetch(currentMediaUrlRef.current, art.currentTime);
      // seek 是用户主动行为：拉平采样基准，避免下一拍被误判为「连续越过片尾」。
      // 暂停中 seek 不会触发 timeupdate，这里也同步刷新按钮的显隐。
      const current = art.currentTime;
      lastSampleRef.current = current;
      const window = resolveSkipWindow(propsRef.current.skipMark, art.duration);
      const introActive =
        window.introEnd !== undefined && !introHandledRef.current && isIntroActive(current, window);
      const outroActive =
        window.outroStart !== undefined && !outroHandledRef.current && current >= window.outroStart;
      updateSkipPrompt(introActive ? 'intro' : outroActive ? 'outro' : null);
    });
    art.on('video:pause', () => {
      // 跳过片尾会主动 pause：此时已按「看完」处理，不能再把片尾位置写回进度
      if (!endedRef.current) propsRef.current.onPause?.(art.currentTime, art.duration);
      // 暂停 = 预取黄金窗口：解除限速并无限铺满整集（用户主动行为，带宽占用可接受）
      // waiting 触发的限速在此解除，否则黄金窗口会被 500ms 轮询冻结
      getVideoPrefetcher().setThrottled(false);
      ensurePrefetch(currentMediaUrlRef.current, art.currentTime, 0);
    });
    art.on('video:waiting', () => {
      // 卡顿：预取临时让出带宽给播放
      getVideoPrefetcher().setThrottled(true);
    });
    art.on('video:playing', () => {
      getVideoPrefetcher().setThrottled(false);
    });
    art.on('video:ended', () => {
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
      hlsRef.current?.destroy();
      hlsRef.current = null;
      recoveryRef.current?.dispose();
      getVideoPrefetcher().stop();
      // 播放页可能仍持有读取接口：销毁前显式置空，避免「记录当前」读到已销毁实例
      propsRef.current.onPlayerApi?.(null);
      art.destroy();
      artRef.current = null;
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

  // —— 标记变化：重置片尾采样基准并立即刷新提示 ——
  // 刚记录「片尾开始」时当前时间恰好等于新边界，若沿用上一拍采样会被判成
  // 「连续越过」而当场结束本集；把基准拉平后本集只保留手动按钮，下一集才自动跳。
  // 顺带覆盖暂停中修改标记的场景（没有 timeupdate 也要让按钮即时出现/消失）。
  useEffect(() => {
    const art = artRef.current;
    if (!art) return;
    const current = art.currentTime;
    lastSampleRef.current = Number.isFinite(current) ? current : 0;
    const window = resolveSkipWindow(skipMark, art.duration);
    const introActive =
      window.introEnd !== undefined && !introHandledRef.current && isIntroActive(current, window);
    const outroActive =
      window.outroStart !== undefined && !outroHandledRef.current && current >= window.outroStart;
    updateSkipPrompt(introActive ? 'intro' : outroActive ? 'outro' : null);
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
      {!error && skipPrompt && (
        <button
          type="button"
          className="absolute bottom-16 left-1/2 -translate-x-1/2 z-10 rounded-full bg-black/70 px-4 py-2 text-sm text-white transition-colors hover:bg-black/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          onClick={() => {
            if (skipPrompt === 'intro') {
              // 用当前这集的有效窗口取目标位置：持久化标记可能已越界/损坏
              const window = resolveSkipWindow(propsRef.current.skipMark, artRef.current?.duration ?? 0);
              if (window.introEnd === undefined) {
                updateSkipPrompt(null);
                return;
              }
              introHandledRef.current = true;
              skipTo(window.introEnd);
              updateSkipPrompt(null);
              showHint('已跳过片头');
              return;
            }
            finishBySkip();
          }}
        >
          {skipPrompt === 'intro' ? '跳过片头' : '跳过片尾'}
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
      {hint && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-black/70 text-white text-sm px-3 py-1.5 rounded-full pointer-events-none animate-fade-in">
          {hint}
        </div>
      )}
      {autoplayNext && !error && (
        <div className="absolute bottom-16 right-3 text-[10px] text-muted bg-black/50 px-2 py-0.5 rounded pointer-events-none">
          自动连播已开启
        </div>
      )}
    </div>
  );
}
