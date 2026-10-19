import { isProxiedUri, PROXY_BASE } from './m3u8';
import { parseM3u8Playlist, type ParsedPlaylist } from './m3u8-parse';
import { StreamingTransmuxer } from './mp4-transmuxer';
import { tr } from '@/lib/i18n-core';

/**
 * 整集离线下载：
 * - 分片并发下载（默认 8），单分片 3 次重试，已下载分片写入 Cache Storage
 *   （`libretv-dl-v1` 桶）实现网络层断点——中断后续传不再耗流量；
 * - AES-128 解密用 WebCrypto AES-CBC（HLS 标准），不引入 CryptoJS；
 * - 输出：TS 直接顺序拼接；MP4 经 mux.js 流式转封装（边下边写，不聚整集）；
 * - 保存目标（FS Access / 内存）由调用方在用户手势内选好传入，本模块只管写。
 *
 * 文件层断点的现实约束：FS Access 句柄与内存 Blob 都活不过页面刷新，
 * 因此「断点续传」指网络层——刷新后重试同一任务会跳过已下载的分片，
 * 但需要用户重新选择保存位置。
 */

const DL_CACHE_NAME = 'libretv-dl-v1';
const SEGMENT_TIMEOUT_MS = 20_000;
const MAX_SEGMENT_RETRIES = 3;

export class PauseResumeController {
  private paused = false;
  private waiters: Array<() => void> = [];

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    const waiters = this.waiters.splice(0);
    for (const w of waiters) w();
  }

  getPaused(): boolean {
    return this.paused;
  }

  async waitIfPaused(): Promise<void> {
    if (!this.paused) return;
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  destroy(): void {
    this.resume();
  }
}

export interface DownloadProgress {
  current: number;
  total: number;
  percentage: number;
  status: 'downloading' | 'processing' | 'done' | 'error';
  message?: string;
}

/**
 * 分片缓存 key。Cache Storage 的 put/match 只接受 http(s) scheme——
 * 自定义字符串（如 `libretv-dl-v1:dl:...`）会被 URL 解析成同名自定义协议，
 * put 直接抛 "Request scheme ... is unsupported"。因此用一段不会被真实
 * 请求的保留域名构造合法 URL，仅作缓存 key 使用；taskId 经编码避免歧义。
 */
const DL_CHUNK_ORIGIN = 'https://dl.libretv.local';

function dlChunkKey(taskId: string, index: number): string {
  return `${DL_CHUNK_ORIGIN}/${encodeURIComponent(taskId)}/${index}`;
}

/**
 * 是否具备断点缓存能力。Cache Storage 只在安全上下文（HTTPS / localhost）存在，
 * HTTP 部署、部分 WebView 与旧浏览器都没有它。下载链路依赖它暂存分片，
 * 缺了只能提前告知，而不是等 caches.open 抛出裸的 ReferenceError。
 */
export function supportsChunkCache(): boolean {
  return typeof caches !== 'undefined';
}

export async function clearDownloadChunks(taskId: string): Promise<void> {
  try {
    if (typeof caches === 'undefined') return;
    const cache = await caches.open(DL_CACHE_NAME);
    const keys = await cache.keys();
    const prefix = `${DL_CHUNK_ORIGIN}/${encodeURIComponent(taskId)}/`;
    await Promise.all(keys.filter((r) => r.url.startsWith(prefix)).map((r) => cache.delete(r)));
  } catch { /* 忽略 */ }
}

/**
 * 分片取回失败。retryable=false 表示确定性失败——源站根本没有这个分片（404/410）。
 * 这类缺失在采集站很常见：m3u8 完整列出了整集，但服务器上的分片是转码/上传
 * 不完整的产物。对它重试只会白等（3 次退避共 6 秒），而且最终必然失败——
 * 播放侧 hls.js 会直接跳过这类分片，所以表现为「能播、下不了」。
 */
class SegmentFetchError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
  }
}

async function fetchSegment(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const res = await fetch(url, { signal: AbortSignal.any([AbortSignal.timeout(SEGMENT_TIMEOUT_MS), signal]), headers: { Accept: '*/*' } });
  if (!res.ok) {
    // 5xx / 408 / 429 多为源站抖动或限流，值得退避重试；其余 4xx 视为确定性缺失
    const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
    throw new SegmentFetchError(`HTTP ${res.status}`, retryable);
  }
  return res.arrayBuffer();
}

/**
 * 取回单个分片（含退避重试）。返回 undefined 表示任务已中止，调用方应直接 return。
 * 4xx 视为源站确定性缺失：立刻抛错并提示换源，不做无谓的退避重试。
 */
async function fetchSegmentWithRetry(
  url: string,
  index: number,
  signal: AbortSignal
): Promise<ArrayBuffer | undefined> {
  for (let retry = 0; retry < MAX_SEGMENT_RETRIES; retry++) {
    if (signal.aborted) return undefined;
    try {
      return await fetchSegment(url, signal);
    } catch (err) {
      if (signal.aborted) return undefined;
      if (err instanceof SegmentFetchError && !err.retryable) {
        throw new Error(tr('分片 {n} 源站缺失（{message}），该来源无法完整下载，建议更换来源', { n: index, message: err.message }));
      }
      await new Promise((r) => setTimeout(r, 1000 * (retry + 1)));
    }
  }
  throw new Error(tr('分片 {n} 下载失败（已重试 {retries} 次）', { n: index, retries: MAX_SEGMENT_RETRIES }));
}

/**
 * HLS AES-128 分片解密（AES-CBC / PKCS7）。
 * IV 规则（RFC 8216 §4.3.2.4）：KEY 带IV 属性时全部分片共用；**无 IV 属性时
 * IV = 分片的媒体序列号（16 字节大端）**，逐分片递增——恒用零向量会导致
 * 首片恰好正确、后续全部解密失败。
 */
function ivForSegment(mediaSequence: number, segmentIndexZeroBased: number): Uint8Array {
  const seq = BigInt(mediaSequence + segmentIndexZeroBased);
  const iv = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    iv[15 - i] = Number((seq >> BigInt(8 * i)) & 0xffn);
  }
  return iv;
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.padStart(32, '0').slice(0, 32).match(/.{2}/g)!.map((h) => parseInt(h, 16)));
}

export async function decryptSegment(
  data: ArrayBuffer,
  key: BufferSource,
  ivHex: string | undefined,
  mediaSequence: number,
  segmentIndexZeroBased: number
): Promise<ArrayBuffer> {
  const iv = ivHex ? hexToBytes(ivHex) : ivForSegment(mediaSequence, segmentIndexZeroBased);
  const cryptoKey = await crypto.subtle.importKey('raw', key, 'AES-CBC', false, ['decrypt']);
  return crypto.subtle.decrypt({ name: 'AES-CBC', iv: iv as BufferSource }, cryptoKey, data);
}

export interface DownloadJobOptions {
  taskId: string;
  url: string;
  title: string;
  format: 'TS' | 'MP4';
  concurrency?: number;
  signal: AbortSignal;
  pause: PauseResumeController;
  onProgress: (p: DownloadProgress) => void;
  /** 在用户手势内选好的保存目标 */
  target: import('./download-saver').SaveTarget;
  /**
   * 经服务器中转下载：m3u8 改由 /api/proxy 拉取，返回内容里的分片/key 已按代理
   * 地址重写，于是整集流量同源经过服务器——源站跨域 / 防盗链 / 混合内容导致
   * 直连失败时的兜底。默认关闭（服务器带宽成本由部署者承担）。
   */
  proxy?: boolean;
}

/** 无 Cache Storage 的降级：串行下载并立即写出，不落缓存（无断点、并发 1） */
async function runStreamingJob(ctx: {
  parsed: ParsedPlaylist;
  format: 'TS' | 'MP4';
  aesKey?: ArrayBuffer;
  target: DownloadJobOptions['target'];
  pause: PauseResumeController;
  signal: AbortSignal;
  total: number;
  report: (current: number, total: number, status: DownloadProgress['status']) => void;
}): Promise<void> {
  const { parsed, format, aesKey, target, pause, signal, total, report } = ctx;
  // MP4 转封装同样是流式的：push 一片立刻产出 fMP4 片段写出，无需聚合整集
  const transmuxer =
    format === 'MP4' ? new StreamingTransmuxer(target, { durationSeconds: parsed.totalDuration }) : undefined;
  for (let i = 1; i <= total; i++) {
    if (signal.aborted) return;
    await pause.waitIfPaused();
    const buffer = await fetchSegmentWithRetry(parsed.segments[i - 1].url, i, signal);
    if (!buffer) return;
    let data: ArrayBuffer = buffer;
    if (aesKey && parsed.aesConf) {
      data = await decryptSegment(buffer, aesKey, parsed.aesConf.iv, parsed.mediaSequence, i - 1);
    }
    if (transmuxer) await transmuxer.pushAndTransmux(new Uint8Array(data));
    else await target.write(new Uint8Array(data));
    report(i, total, 'downloading');
  }
  if (transmuxer) await transmuxer.finish();
  else await target.close();
}

/**
 * 把解析阶段的失败翻译成可操作的原因。浏览器直连被 CORS / 混合内容 / DNS 拦下时，
 * fetch 只会给出 `TypeError: Failed to fetch`——对用户没有任何信息量。而下载链路
 * 没有播放器那样的代理回退（player-shell 遇直连致命错误会改走 /api/proxy），
 * 所以「能播不能下」多半卡在这里，必须把下一步该做什么讲清楚。
 */
function describeParseFailure(url: string, err: unknown): string {
  const reason = err instanceof Error ? err.message : tr('未知错误');
  const base = tr('播放列表解析失败：{reason}', { reason });
  if (!/failed to fetch|networkerror|load failed/i.test(reason)) return base;
  if (isMixedContentBlocked(url)) {
    return `${base}${tr('——该来源是 HTTP 地址，HTTPS 页面无法直连下载（混合内容被拦截），建议更换来源')}`;
  }
  return `${base}${tr('——无法直连该来源（跨域限制或域名不可达），建议更换来源')}`;
}

/** 页面是 HTTPS 而目标是 http:// 时，浏览器按混合内容策略直接拦截 */
function isMixedContentBlocked(target: string): boolean {
  if (typeof location === 'undefined' || location.protocol !== 'https:') return false;
  return /^http:\/\//i.test(target);
}

/**
 * 执行一次整集下载。调用方（DownloadManager）负责：
 * 在用户手势内 pickSaveTarget、构造 AbortSignal/PauseResumeController、
 * 更新 Dexie 任务状态；本函数只负责解析 → 并发下载 → 顺序写出。
 */
export async function runDownloadJob(opts: DownloadJobOptions): Promise<void> {
  const { taskId, url, format, signal, pause, onProgress, target } = opts;
  const concurrency = Math.min(Math.max(opts.concurrency ?? 8, 1), 16);

  // 内部硬停控制器：任一 worker 判失败就掐掉其余 worker。否则 Promise.all 已经
  // reject、任务早已标记失败，后台 worker 还在继续请求分片耗流量。与外部 signal
  // 组合后，用户取消（外部 abort）的语义保持不变。
  const hardStop = new AbortController();
  const jobSignal = AbortSignal.any([signal, hardStop.signal]);

  const report = (current: number, total: number, status: DownloadProgress['status'], message?: string) => {
    onProgress({
      current,
      total,
      percentage: total > 0 ? Math.round((current / total) * 100) : 0,
      status,
      message,
    });
  };

  // —— 解析（重试 2 次） ——
  // 代理模式：m3u8 经 /api/proxy 拉取，代理会把内容里的分片/key 一并重写为代理
  // 地址，因此后续分片请求自动同源——这是直连被 CORS / 混合内容拦下时的兜底
  // （与播放器一致：player-shell 遇致命直连错误也会改走代理）。
  const playlistUrl = opts.proxy && !isProxiedUri(url) ? `${PROXY_BASE}${encodeURIComponent(url)}` : url;
  let parsed: ParsedPlaylist;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      parsed = await parseM3u8Playlist(playlistUrl, 0, undefined, { stripLeadAd: true });
      lastErr = undefined;
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr || !parsed!) {
    throw new Error(describeParseFailure(url, lastErr));
  }
  if (parsed.byterange) throw new Error(tr('该集使用 BYTERANGE 分片，暂不支持下载'));

  const total = parsed.segments.length;
  report(0, total, 'downloading');

  // —— AES key 预取 ——
  let aesKey: ArrayBuffer | undefined;
  if (parsed.aesConf) {
    const res = await fetch(parsed.aesConf.uri, { signal: jobSignal });
    if (!res.ok) throw new Error(tr('解密密钥加载失败：HTTP {status}', { status: res.status }));
    aesKey = await res.arrayBuffer();
  }

  // —— 无 Cache Storage（HTTP 页面 / 老浏览器）：退化为串行「边下边写」 ——
  // 没有断点、并发为 1，但功能可用；原先这条路径是直接失败的
  if (!supportsChunkCache()) {
    await runStreamingJob({ parsed, format, aesKey, target, pause, signal: jobSignal, total, report });
    if (!jobSignal.aborted) report(total, total, 'done');
    return;
  }

  // —— 并发下载分片（Cache Storage 断点） ——
  const cache = await caches.open(DL_CACHE_NAME);
  const chunkKey = (index: number) => dlChunkKey(taskId, index);
  let cursor = 0;
  // 恢复：统计已有分片数作为起点
  let current = 0;
  for (let i = 1; i <= total; i++) {
    if (await cache.match(new Request(chunkKey(i)))) current += 1;
  }
  report(current, total, 'downloading');

  const worker = async (): Promise<void> => {
    while (cursor < total) {
      if (jobSignal.aborted) return;
      await pause.waitIfPaused();
      const index = ++cursor; // 1 基
      if (jobSignal.aborted) return;
      await pause.waitIfPaused();
      const cached = await cache.match(new Request(chunkKey(index)));
      if (cached) {
        // 已在恢复预统计里计入，不再累加——否则续传时进度重复计数超过 100%
        continue;
      }
      const buffer = await fetchSegmentWithRetry(parsed.segments[index - 1].url, index, jobSignal);
      if (!buffer) return;
      try {
        await cache.put(
          new Request(chunkKey(index)),
          new Response(buffer.slice(0), { headers: { 'Content-Type': 'video/mp2t' } })
        );
      } catch (err) {
        // 配额不足等存储层错误：浏览器原文（QuotaExceededError）用户看不懂
        throw new Error(
          tr('分片缓存写入失败（浏览器存储空间可能不足）：{message}', { message: err instanceof Error ? err.message : String(err) })
        );
      }
      current += 1;
      report(current, total, 'downloading');
    }
  };
  try {
    await Promise.all(Array.from({ length: concurrency }, worker));
  } catch (err) {
    // 先把在途的其它 worker 掐掉再向上抛：任务已判失败，不该继续耗流量
    hardStop.abort();
    throw err;
  }
  if (jobSignal.aborted) return;

  // —— 顺序写出（转封装 / 拼接） ——
  report(total, total, 'processing');
  if (format === 'MP4') {
    // 传入整集时长：mux.js 恒把 moov 时长写成 0xFFFFFFFF（timescale 90000
    // → 播放器显示 13:15:21），必须在写出 initSegment 前回填真实值
    const transmuxer = new StreamingTransmuxer(target, { durationSeconds: parsed.totalDuration });
    for (let i = 1; i <= total; i++) {
      if (jobSignal.aborted) return;
      await pause.waitIfPaused();
      const resp = await cache.match(new Request(chunkKey(i)));
      if (!resp) throw new Error(tr('分片 {n} 缓存丢失，请重试', { n: i }));
      let data = await resp.arrayBuffer();
      if (aesKey && parsed.aesConf) {
        data = await decryptSegment(data, aesKey, parsed.aesConf.iv, parsed.mediaSequence, i - 1);
      }
      await transmuxer.pushAndTransmux(new Uint8Array(data));
    }
    await transmuxer.finish();
  } else {
    for (let i = 1; i <= total; i++) {
      if (jobSignal.aborted) return;
      await pause.waitIfPaused();
      const resp = await cache.match(new Request(chunkKey(i)));
      if (!resp) throw new Error(tr('分片 {n} 缓存丢失，请重试', { n: i }));
      let data = await resp.arrayBuffer();
      if (aesKey && parsed.aesConf) {
        data = await decryptSegment(data, aesKey, parsed.aesConf.iv, parsed.mediaSequence, i - 1);
      }
      await target.write(new Uint8Array(data));
    }
    await target.close();
  }
  report(total, total, 'done');
}
