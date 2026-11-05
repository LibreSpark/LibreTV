/**
 * 音量放大（默认关闭，用户在「播放与过滤」设置里开启）：把播放器输出再放大约 1.8 倍。
 *
 * 原理：ArtPlayer 的 volume 就是 HTMLVideoElement.volume，硬上限 1（100%），
 * 参数层面无法突破。这里用 Web Audio API 在 video 元素之后串一个 GainNode：
 *
 *   <video> → MediaElementAudioSourceNode → GainNode(1.8) → DynamicsCompressor(透明软限幅) → destination
 *
 * video.volume（滑块/快捷键/静音）与音频图是相乘关系，因此原有音量控件、静音、
 * 记忆音量全部照常工作，无需改动 ArtPlayer 或任何播放器代码路径。
 *
 * 保守设计（对应「别把框架弄坏」）：
 * - 默认不接入：设置项 `volumeBoost` 关闭时完全不碰音频链路，全站响度与旧版一致。
 *   放大对**所有音量档位**都是相乘的（10% 也会变 18%），所以必须由用户显式开启。
 * - 纯附加模块，不修改播放器本身；任何异常都回退到「原样播放」。
 * - 只在资源 CORS 安全时接入。跨域且未开 CORS 的资源接入后浏览器会强制静音
 *   （Web Audio 规范 §1.22.4），此时直接跳过，不碰音频链路。
 * - 只在 AudioContext 处于 running 时才改道。自动播放策略下 ctx 可能是 suspended，
 *   在 suspended 状态下把音频改道会造成「无声」——这比不放大更糟，故先登记、
 *   等用户交互 resume 后再补挂。
 * - 关闭放大用「单位增益直通」而不是拆链：`createMediaElementSource` 之后元素的
 *   输出只走音频图，单纯 disconnect 会永久静音且无法恢复直连，所以 setBoost(false)
 *   把 source 直连 destination，保留音频通路。
 * - 全 App 复用一个 AudioContext（不是每次换台新建一个），避免上下文数量上限/泄漏。
 * - 手势监听只在「有待补挂项」时存在，补挂完成即解绑，不常驻 document。
 * - 透明软限幅：threshold=0dB、knee=0、ratio=20，只压超过 0dBFS 的峰值。实测（见下方
 *   createDynamicsCompressor 处的数据）：未顶满的片源全额拿到 +5.11 dB（=1.8 倍），
 *   已经贴近 0dBFS 且滑块拉满的片源被压回约 +1.25 dB，稳态峰值仍略超满量程（1.041）——
 *   它是防破音的软限幅，不是硬保证。
 * - createMediaElementSource 对同一元素只能调用一次，用 WeakMap 保证幂等。
 */
'use client';

/** 放大倍数。想调整音量上限只改这一个常量即可（建议 1.5 ~ 2）。 */
export const VOLUME_BOOST_GAIN = 1.8;

/**
 * 判断当前媒体源能否安全接入 Web Audio。
 *
 * - blob: / data:：hls.js、mpegts.js 的 MediaSource 产物，或本地数据 → 安全
 * - 同源（含 /api/proxy、/api/live/stream 等本地代理路径）→ 安全
 * - 跨域：仅当 <video crossOrigin="anonymous"> 已启用时才安全
 *   （点播 player-shell 已设 crossOrigin；直播直连跨域流未设，跳过）
 */
export function isWebAudioSafeForVideo(video: HTMLVideoElement): boolean {
  let src: string;
  try {
    src = video.currentSrc || video.src || '';
  } catch {
    return false;
  }
  if (!src) return false;
  if (/^(blob|data):/i.test(src)) return true;
  try {
    const url = new URL(src, typeof window !== 'undefined' ? window.location.href : undefined);
    const origin = typeof window !== 'undefined' ? window.location.origin : undefined;
    // 相对/无协议 URL（如 /api/proxy?url=…）解析后同源，安全
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      if (origin && url.origin === origin) return true;
    }
    return video.crossOrigin === 'anonymous' || video.crossOrigin === 'use-credentials';
  } catch {
    return false;
  }
}

export interface VolumeBoostHandle {
  /**
   * 运行中切换放大：开=走增益+限幅链，关=单位增益直通。
   * 关闭不能拆链（见文件头说明），否则该元素会永久静音。
   */
  setBoost(enabled: boolean): void;
  /** 卸载播放器时调用：断开本元素的音频链，取消尚未完成的补挂 */
  dispose(): void;
}

interface BoostNodes {
  ctx: AudioContext;
  source: MediaElementAudioSourceNode;
  gainNode: GainNode;
  compressor: DynamicsCompressorNode;
}

/** 内部句柄：即使在 suspended 待补挂状态下也先返回，保证调用方 dispose 一定有效 */
class Handle implements VolumeBoostHandle {
  disposed = false;
  /** 用户当前是否要放大；pending 里的句柄靠它决定要不要补挂 */
  wantBoost = true;
  private nodes: BoostNodes | null = null;
  constructor(
    readonly video: HTMLVideoElement,
    readonly gain: number
  ) {}
  setNodes(nodes: BoostNodes) {
    this.nodes = nodes;
    this.wire();
  }
  setBoost(enabled: boolean) {
    if (this.disposed) return;
    this.wantBoost = enabled;
    if (this.nodes) {
      this.wire();
      return;
    }
    // 还没建链（suspended 待补挂）：开=回到待办并尝试 resume，关=从待办撤掉
    if (enabled) {
      pending.add(this);
      bindGestures();
      resumeShared();
    } else {
      pending.delete(this);
      releaseGesturesIfIdle();
    }
  }
  /** 按 wantBoost 重新接线：增益+限幅链，或 source 直连 destination */
  private wire() {
    const nodes = this.nodes;
    if (!nodes) return;
    try {
      nodes.source.disconnect();
      nodes.gainNode.disconnect();
      nodes.compressor.disconnect();
      if (this.wantBoost) {
        nodes.source.connect(nodes.gainNode);
        nodes.gainNode.connect(nodes.compressor);
        nodes.compressor.connect(nodes.ctx.destination);
      } else {
        nodes.source.connect(nodes.ctx.destination);
      }
    } catch { /* 忽略：接线失败保持现状，不影响播放 */ }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    pending.delete(this);
    releaseGesturesIfIdle();
    if (attached.get(this.video) === this) attached.delete(this.video);
    const nodes = this.nodes;
    this.nodes = null;
    if (nodes) {
      try {
        nodes.source.disconnect();
        nodes.gainNode.disconnect();
        nodes.compressor.disconnect();
      } catch { /* 忽略 */ }
    }
  }
}

let sharedCtx: AudioContext | null = null;
const attached = new WeakMap<HTMLVideoElement, Handle>();
const pending = new Set<Handle>();

/** 手势监听只在 pending 非空期间存在，避免常驻 document */
const GESTURE_EVENTS = ['pointerdown', 'keydown', 'touchstart'] as const;
let gestureHandler: (() => void) | null = null;

function bindGestures() {
  if (gestureHandler || typeof document === 'undefined') return;
  gestureHandler = () => resumeShared();
  GESTURE_EVENTS.forEach((name) => document.addEventListener(name, gestureHandler!, true));
}

function unbindGestures() {
  if (!gestureHandler || typeof document === 'undefined') return;
  GESTURE_EVENTS.forEach((name) => document.removeEventListener(name, gestureHandler!, true));
  gestureHandler = null;
}

/** pending 清空后解绑，防止监听器永久挂在 document 上 */
function releaseGesturesIfIdle() {
  if (pending.size === 0) unbindGestures();
}

function getAudioContext(): AudioContext | null {
  if (sharedCtx && sharedCtx.state !== 'closed') return sharedCtx;
  if (typeof window === 'undefined') return null;
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    sharedCtx = new Ctor();
  } catch {
    return null;
  }
  return sharedCtx;
}

function flushPending() {
  const ctx = sharedCtx;
  if (!ctx || ctx.state !== 'running') return;
  for (const handle of Array.from(pending)) {
    pending.delete(handle);
    if (handle.disposed || !handle.wantBoost) continue;
    // 等待期间 currentSrc 可能变成不安全（如切到跨域直连），撤销以允许后续重试
    if (!isWebAudioSafeForVideo(handle.video) || !doAttach(handle, ctx)) {
      attached.delete(handle.video);
      handle.dispose();
    }
  }
  releaseGesturesIfIdle();
}

function resumeShared() {
  const ctx = sharedCtx;
  if (!ctx) return;
  if (ctx.state === 'running') {
    flushPending();
    return;
  }
  void ctx
    .resume()
    .then(() => {
      if (ctx.state === 'running') flushPending();
    })
    .catch(() => {});
}

function doAttach(handle: Handle, ctx: AudioContext): boolean {
  let source: MediaElementAudioSourceNode;
  try {
    // 每个 <video> 只能调用一次；重复调用会抛 InvalidStateError
    source = ctx.createMediaElementSource(handle.video);
  } catch {
    return false;
  }
  const gainNode = ctx.createGain();
  gainNode.gain.value = handle.gain;

  // 透明软限幅：只削掉放大后超过 0dBFS 的峰值。
  // 参数是实测选的（Chromium OfflineAudioContext，440Hz 正弦，跳过前 0.8s 待限幅器收敛）：
  //   · 输入未顶满时，1.8 倍全额兑现（+5.11 dB = 20·log10(1.8)），峰值与 RMS 同步；
  //   · 只有「源本身已接近 0dBFS 且滑块拉满」会被压回，实测约 +1.25 dB；
  //   · 稳态峰值仍会到 1.041（略超满量程）。试过更"保守"的 threshold=−1/knee=3
  //     与 threshold=−1.5/knee=6/ratio=12，结果过冲反而更大（1.055 / 1.153），
  //     所以不要靠降 threshold 去治过冲；若一定要压到 1.0 以内，代价是在限幅后
  //     串一级 0.95 的固定衰减（安静源的提升会从 5.11 dB 降到 4.66 dB）。
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = 0;
  compressor.knee.value = 0;
  compressor.ratio.value = 20;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.25;

  handle.setNodes({ ctx, source, gainNode, compressor });
  return true;
}

/**
 * 给一个 video 元素挂上音量放大图。
 * 返回句柄（调用方在卸载时 dispose）；跳过或失败时返回 null，播放器照常工作。
 * 可重复调用（幂等）：已挂则返回同一句柄，跳过时后续 src 变安全可重试。
 */
export function attachVolumeBoost(
  video: HTMLVideoElement | null | undefined,
  gain = VOLUME_BOOST_GAIN
): VolumeBoostHandle | null {
  if (!video || typeof window === 'undefined') return null;
  const existing = attached.get(video);
  if (existing && !existing.disposed) return existing;
  // CORS 不安全时绝不创建节点：接入即静音，比不放大更糟（且允许后续重试）
  if (!isWebAudioSafeForVideo(video)) return null;
  const ctx = getAudioContext();
  if (!ctx) return null;

  const handle = new Handle(video, gain);
  attached.set(video, handle);

  if (ctx.state !== 'running') {
    // 不改道，避免 suspended 状态下无声；等用户交互后 flushPending 补挂
    pending.add(handle);
    bindGestures();
    resumeShared();
    return handle;
  }
  if (!doAttach(handle, ctx)) {
    handle.dispose();
    return null;
  }
  return handle;
}
