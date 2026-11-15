import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import { fetchLiveUpstreamWithMeta } from '@/lib/fetch-utils';
import { withHostLimit } from '@/lib/host-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 直播频道批量测活（分片级）。
 * POST /api/live/probe  body: { urls: string[] }
 *
 * 单级「manifest 可访问」不足以判断可播：大量 IPTV 源 manifest 正常但
 * 分片请求被拒（token/Referer 校验、源瞬断）。因此探测追到真实分片：
 *
 *   m3u8 → [master playlist → 第一个 variant] → media playlist → 初始化段/最新分片
 *   分片以 Range: bytes=0-1 请求，收到响应头即 cancel body，不下载媒体数据。
 *   manifest 请求**不带 Range**（部分源会严格按 Range 截断，只回 2 字节）。
 *
 * 非 m3u8（FLV 等）维持单级探测。结果 level 标识探测深度：
 *   segment=分片级（最可信）/ manifest=仅 manifest 级 / head=单级直探
 * 200/206 响应头视为可达；仍不保证编码可解码（H.265 等）。
 *
 * 性能与准确性要点：
 * - 每个频道有整体时间预算（URL_BUDGET_MS），三级探测共享，避免逐级 5s 叠加成长尾；
 * - 结果带短 TTL 缓存（成功 30min / 失败 2min），多用户重复测活不再重复打上游；
 * - 全局按 host 限并发（单 host 在途 ≤3）：同一运营商的频道常共用 host，
 *   批量测活不限流会以 16×N 的并发冲击同一弱源，被打挂甚至封服务器 IP（越测越红）；
 * - 请求带源站 Referer，消除「源校验 Referer 导致的可播却测不通」假阴性；
 * - 校验 m3u8 的 #EXTM3U 前缀与直链的 content-type，剔除 200 的 HTML/JSON 错误页；
 * - master playlist 解析 CODECS 一并返回，前端据此提示 H.265 等浏览器无法解码的情况；
 * - 分片级通过后额外采样 128KB 实际吞吐（kbps），识别「可达但限速」的源；
 * - 走直播侧 SSRF 口径（allowPrivate）：LIVE_ALLOW_PRIVATE=1 时自建内网 IPTV 同样能测通；
 * - `?stream=1` 以 NDJSON 逐条推送结果（命中缓存的立即返回），前端状态点可边测边亮；
 *   不带该参数时仍返回整批 JSON，保持向后兼容。
 */

const MAX_URLS = 50;
const MAX_PROBE_BODY_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;

/** 流式读取客户端请求体，超限时立即取消，不把任意大的 body 先读入内存。 */
async function readRequestTextLimited(req: Request, maxBytes: number): Promise<string> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('REQUEST_BODY_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function readTextLimited(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('播放列表超过 1MB 限制');
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('播放列表超过 1MB 限制');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(merged);
}
const CONCURRENCY = 16;
/**
 * 单个频道三级探测的总预算（含各级请求）。
 * 6s 对跨网慢 CDN 不够用：实测存在 TCP 0.4s + TLS 1.5s 的源，
 * 单是 variant 就要 3~4s，会导致"能播却超时判红"。放宽到 10s。
 */
const URL_BUDGET_MS = 10_000;
/** 单级请求上限（入口/variant），避免某一级吃光总预算 */
const LEVEL_TIMEOUT_MS = 5000;
/** 分片级最长等待：分片只需响应头；部分服务器忽略 Range 会整段返回，留足余量 */
const SEGMENT_TIMEOUT_MS = 4000;
/**
 * 分片吞吐采样：Range 拉 128KB（或 2.5s 截止）估算实际带宽。
 * Range: bytes=0-1 只能验证「分片可达」，覆盖不了「限速源」——
 * 实测存在 206 秒回但整段下载仅 ~58kbps 的源，永远缓冲不起来（绿点却播不了）。
 */
const THROUGHPUT_BYTES = 128 * 1024;
const THROUGHPUT_BUDGET_MS = 2500;
/** 吞吐采样所需的最低剩余预算：预算不足时跳过采样，避免拖长探测长尾 */
const THROUGHPUT_MIN_REMAINING_MS = 1500;
/**
 * 结果缓存：成功结果稳定，失败可能是瞬断，分开设置。
 * 成功 30min：客户端结果本身有 6h TTL，这里覆盖多用户/多轮补测场景，避免重复打上游；
 * 容量需 ≥ 典型全量频道数：几千频道的列表一轮测完若把缓存挤爆（逐出最旧），重测时会全部穿透。
 */
const CACHE_TTL_OK_MS = 30 * 60 * 1000;
const CACHE_TTL_FAIL_MS = 2 * 60 * 1000;
const CACHE_MAX_ENTRIES = 20_000;
const UA =
  process.env.USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

interface ProbeOutcome {
  url: string;
  ok: boolean;
  status?: number;
  ms?: number;
  level?: 'segment' | 'manifest' | 'head';
  error?: string;
  /** master playlist 的 CODECS 属性（如 hvc1.1.6.L93.B0,mp4a.40.2），用于前端提示编码兼容性 */
  codec?: string;
  /** 因超出时间预算而失败（源可能只是慢，不代表不可播），前端据此区分展示 */
  timedOut?: boolean;
  /** 分片吞吐估算（kbps）：低于阈值的源前端标记为「源限速」琥珀色 */
  kbps?: number;
}

interface FetchHeadResult {
  ok: boolean;
  status: number;
  text?: string;
  finalUrl: string;
  contentType: string;
  isM3u8: boolean;
}

/**
 * 错误占位资源：不少 IPTV 服务在令牌失效/账号异常时 302 到一段错误提示视频或图片
 * （如 `https://static.xxx/status/error_account_pirated.mp4`）。
 * 响应是 200 的合法媒体，单看可达性会误判为可用，这里按最终 URL 路径特征识别。
 * 仅在发生重定向时判定，避免误伤正常路径。
 */
const ERROR_PLACEHOLDER_RE =
  /(^|\/)(error|errors|status|denied|forbidden|expired|invalid|pirated|unauthorized)([_\-./]|$)/i;

/** 明显的网页/接口响应（200 的 HTML/JSON 错误页不能当成流） */
function isWebPageType(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return (
    ct.includes('text/html') ||
    ct.includes('application/xhtml') ||
    ct.includes('application/json') ||
    ct.includes('text/xml') ||
    ct.includes('application/xml')
  );
}

/** 源站 Referer：部分 IPTV 源校验 Referer 才放行列表/分片，缺失会误判为不可用 */
function refererOf(url: string): string | undefined {
  try {
    return `${new URL(url).origin}/`;
  } catch {
    return undefined;
  }
}

/**
 * 请求一个资源，拿到响应头即断开 body（m3u8 额外读取文本以供解析）。
 *
 * range 仅用于分片级探测：部分源（openresty 等）对 Range 请求严格截断，
 * 若给 manifest 也带 `Range: bytes=0-1` 会只拿到 2 字节（如 `#E`），
 * 导致 m3u8 解析与 #EXTM3U 校验失败而被误判为不可用。
 */
async function fetchHeadersOnly(
  url: string,
  timeoutMs: number,
  referer?: string,
  range = false,
  requestSignal?: AbortSignal
): Promise<FetchHeadResult> {
  const headers: Record<string, string> = {
    'User-Agent': UA,
    Accept: '*/*',
  };
  if (range) headers.Range = 'bytes=0-1';
  if (referer) headers.Referer = referer;

  // allowPrivate：与直播流代理同一把尺子，LIVE_ALLOW_PRIVATE=1 时自建内网 IPTV 才能测通；
  // fetchUpstreamWithMeta 内部逐跳做 SSRF 校验，此处不再重复预检（省一次 DNS 解析）
  const { res, finalUrl } = await fetchLiveUpstreamWithMeta(url, {
    timeoutMs,
    retries: 0,
    headers,
    signal: requestSignal,
  });
  const contentType = res.headers.get('content-type') || '';
  const isM3u8 =
    contentType.includes('mpegurl') || contentType.includes('x-mpegurl') ||
    url.toLowerCase().split('?')[0].endsWith('.m3u8');

  let text: string | undefined;
  if (isM3u8) {
    // m3u8 是小文本，读取以供解析；分片则不读取
    text = await readTextLimited(res, MAX_MANIFEST_BYTES);
  } else if (res.body) {
    try { await res.body.cancel(); } catch { /* 忽略 */ }
  }
  return { ok: res.ok, status: res.status, text, finalUrl, contentType, isM3u8 };
}

/**
 * 从 media playlist 中选一个用于探测的分片：优先初始化段（EXT-X-MAP），
 * 否则取**窗口内最后一个**（最新）分片。
 *
 * 不取第一个：直播是滑动窗口，列表首个分片最接近过期，
 * manifest 解析与分片请求之间的几十毫秒延迟就可能让它 404 而在测活中误判为不可用。
 */
function lastSegmentUrl(content: string, baseUrl: string): string | undefined {
  let last: string | undefined;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-MAP')) {
      const m = line.match(/URI="([^"]+)"/);
      if (m) return new URL(m[1], baseUrl).href;
      continue;
    }
    if (line.startsWith('#')) continue;
    last = new URL(line, baseUrl).href;
  }
  return last;
}

/** 从 master playlist 中取第一个 variant 的地址（无 STREAM-INF 则视为 media playlist 返回 null） */
function firstVariantUrl(content: string, baseUrl: string): string | undefined | null {
  if (!content.includes('#EXT-X-STREAM-INF')) return null;
  const lines = content.split(/\r?\n/).map((l) => l.trim());
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j];
        if (!next) continue;
        if (next.startsWith('#')) continue;
        return new URL(next, baseUrl).href;
      }
    }
  }
  return undefined;
}

/** 提取 master playlist 的 CODECS 属性 */
function extractCodecs(content: string): string | undefined {
  const m = content.match(/CODECS="([^"]+)"/i);
  return m?.[1]?.trim() || undefined;
}

const HEADER_OK = /^#EXTM3U/;

function elapsed(start: number): number {
  return Math.round(performance.now() - start);
}

/**
 * 分片吞吐采样：Range 拉 128KB（或 2.5s 截止），按实际收到的字节数估算 kbps。
 * 与分片可达性检查是两次独立请求（前者只取响应头即 cancel）。
 * 服务器忽略 Range 时按整段返回，读到 THROUGHPUT_BYTES 即停，不影响估算。
 */
async function measureThroughput(segmentUrl: string, referer?: string, requestSignal?: AbortSignal): Promise<number | undefined> {
  const start = performance.now();
  try {
    const { res } = await fetchLiveUpstreamWithMeta(segmentUrl, {
      timeoutMs: 3000,
      retries: 0,
      headers: {
        'User-Agent': UA,
        Accept: '*/*',
        Range: `bytes=0-${THROUGHPUT_BYTES - 1}`,
        ...(referer ? { Referer: referer } : {}),
      },
      signal: requestSignal,
    });
    if (!res.ok || !res.body) return undefined;
    const reader = res.body.getReader();
    let bytes = 0;
    for (;;) {
      const remaining = THROUGHPUT_BUDGET_MS - (performance.now() - start);
      if (remaining <= 0) break;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining)),
      ]);
      if (!chunk || chunk.done) break;
      bytes += chunk.value?.length ?? 0;
      if (bytes >= THROUGHPUT_BYTES) break;
    }
    try { await reader.cancel(); } catch { /* 忽略 */ }
    try { await res.body.cancel(); } catch { /* 忽略 */ }
    const secs = (performance.now() - start) / 1000;
    if (bytes <= 0 || secs < 0.05) return undefined;
    return Math.round((bytes * 8) / secs / 1000);
  } catch {
    return undefined;
  }
}

/** 两级探测：manifest →（master 时穿透 variant）→ 分片 */
async function probeOne(url: string, requestSignal?: AbortSignal): Promise<ProbeOutcome> {
  const start = performance.now();
  const deadline = start + URL_BUDGET_MS;
  const remaining = () => deadline - performance.now();

  const referer = refererOf(url);
  const timeout = () => Math.min(LEVEL_TIMEOUT_MS, Math.max(500, Math.round(remaining())));

  try {
    // 第一级：入口地址
    const entry = await fetchHeadersOnly(url, timeout(), referer, false, requestSignal);
    if (!entry.ok) {
      return { url, ok: false, status: entry.status, ms: elapsed(start), error: `入口响应 ${entry.status}` };
    }

    // 令牌失效/账号异常时，源常重定向到错误提示资源：本质不可用，但 HTTP 层是 200。
    // 仍以 m3u8 结尾的重定向视为正常播放列表（如 /status/live.m3u8），不按占位资源处理。
    if (entry.finalUrl !== url) {
      try {
        const pathname = new URL(entry.finalUrl).pathname;
        if (!/\.m3u8?$/i.test(pathname) && ERROR_PLACEHOLDER_RE.test(pathname)) {
          return {
            url,
            ok: false,
            status: entry.status,
            ms: elapsed(start),
            error: '源返回错误占位内容（令牌失效 / 账号异常）',
          };
        }
      } catch { /* 忽略 URL 解析失败 */ }
    }

    // 非 m3u8（FLV/TS 直链）：拒绝明显的网页/接口响应，其余仅标记"可达"（level=head，未验证可播性）
    if (!entry.isM3u8) {
      if (isWebPageType(entry.contentType)) {
        return {
          url,
          ok: false,
          status: entry.status,
          ms: elapsed(start),
          error: `返回内容不是流媒体（${entry.contentType.split(';')[0]}）`,
        };
      }
      return { url, ok: true, status: entry.status, ms: elapsed(start), level: 'head' };
    }

    // m3u8 必须含 #EXTM3U 头，否则是伪装的 HTML/错误页
    const entryText = (entry.text || '').replace(/^\uFEFF/, '').trimStart();
    if (!HEADER_OK.test(entryText)) {
      return { url, ok: false, status: entry.status, ms: elapsed(start), error: '返回内容不是有效的 m3u8' };
    }

    // 第二级：media playlist（master 则先穿透 variant）。
    // 相对地址一律以重定向后的最终 URL 为 base（gslb 调度源 302 后路径会变）
    let mediaUrl = entry.finalUrl;
    let mediaText = entryText;
    let codec = extractCodecs(entryText);
    const variant = firstVariantUrl(entryText, entry.finalUrl);
    if (variant === undefined) {
      return { url, ok: false, ms: elapsed(start), error: 'playlist 中没有可用的流地址' };
    }
    if (variant !== null) {
      const variantRes = await fetchHeadersOnly(variant, timeout(), referer, false, requestSignal);
      const variantText = (variantRes.text || '').replace(/^\uFEFF/, '').trimStart();
      if (!variantRes.ok || !HEADER_OK.test(variantText)) {
        return {
          url,
          ok: false,
          status: variantRes.status,
          ms: elapsed(start),
          error: `子播放列表响应 ${variantRes.status}`,
        };
      }
      mediaUrl = variantRes.finalUrl;
      mediaText = variantText;
      codec = codec ?? extractCodecs(variantText);
    }

    // 第三级：分片
    const segmentUrl = lastSegmentUrl(mediaText, mediaUrl);
    if (!segmentUrl) {
      // 空 media playlist（直播源刚启动/无分片）视为 manifest 级通过
      return { url, ok: true, status: entry.status, ms: elapsed(start), level: 'manifest', codec };
    }
    const segmentStart = performance.now();
    const segment = await fetchHeadersOnly(
      segmentUrl,
      Math.min(timeout(), SEGMENT_TIMEOUT_MS),
      referer,
      true,
      requestSignal
    );
    // ms 只统计分片往返：三级累计耗时当作「延迟」对用户没有参考意义
    const segmentMs = elapsed(segmentStart);
    if (!segment.ok) {
      return {
        url,
        ok: false,
        status: segment.status,
        ms: segmentMs,
        level: 'segment',
        codec,
        error: `分片响应 ${segment.status}`,
      };
    }
    // 分片可达：采样实际吞吐，识别「可达但限速」的源（绿点却播不了的主因）
    const kbps =
      remaining() > THROUGHPUT_MIN_REMAINING_MS
        ? await measureThroughput(segmentUrl, referer, requestSignal)
        : undefined;
    return {
      url,
      ok: true,
      status: segment.status,
      ms: segmentMs,
      level: 'segment',
      codec,
      kbps,
    };
  } catch (err) {
    const timedOut = performance.now() >= deadline;
    return {
      url,
      ok: false,
      ms: elapsed(start),
      timedOut: timedOut || undefined,
      error: timedOut ? `探测超时（${URL_BUDGET_MS}ms）` : err instanceof Error ? err.message : '探测失败',
    };
  }
}

const NDJSON_HEADERS = {
  'Content-Type': 'application/x-ndjson; charset=utf-8',
  'Cache-Control': 'no-store, no-transform',
  // 禁用反代缓冲，保证每条结果立即到达客户端
  'X-Accel-Buffering': 'no',
};

/**
 * 流式测活：命中缓存的结果立即推送，其余探测完成一条推一条（NDJSON）。
 * 相比整批等待最慢的一条，前端状态点可以边测边亮。
 * 客户端断开（切筛选/关页）时 req.signal 触发，worker 停止且不再写入。
 */
function ndjsonResponse(urls: string[], reqSignal: AbortSignal): Response {
  const encoder = new TextEncoder();
  const cachedOutcomes: ProbeOutcome[] = [];
  const pending: string[] = [];
  for (const u of urls) {
    const hit = cacheGet(u);
    if (hit) cachedOutcomes.push(hit);
    else pending.push(u);
  }

  let closed = false;
  let streamClosed = false;
  const cancelController = new AbortController();
  const probeSignal = AbortSignal.any([reqSignal, cancelController.signal]);
  const onRequestAbort = () => {
    closed = true;
    cancelController.abort(reqSignal.reason);
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (o: ProbeOutcome) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(o) + '\n'));
        } catch {
          closed = true;
        }
      };
      const finish = () => {
        if (streamClosed) return;
        streamClosed = true;
        closed = true;
        reqSignal.removeEventListener('abort', onRequestAbort);
        try { controller.close(); } catch { /* 已关闭 */ }
      };
      if (reqSignal.aborted) onRequestAbort();
      else reqSignal.addEventListener('abort', onRequestAbort, { once: true });

      for (const o of cachedOutcomes) send(o);

      let cursor = 0;
      const worker = async () => {
        while (cursor < pending.length) {
          if (closed || reqSignal.aborted) return;
          const url = pending[cursor++];
          const outcome = await withHostLimit(url, () => probeOne(url, probeSignal));
          if (closed || reqSignal.aborted) return;
          cacheSet(url, outcome);
          send(outcome);
        }
      };
      void Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker))
        .then(finish)
        .catch(finish);
    },
    cancel() {
      // 客户端主动断开时同步中止正在进行的上游探测。
      closed = true;
      streamClosed = true;
      cancelController.abort(new DOMException('客户端已断开', 'AbortError'));
      reqSignal.removeEventListener('abort', onRequestAbort);
    },
  });

  return new NextResponse(stream, { headers: NDJSON_HEADERS });
}

/** 结果短 TTL 缓存：成功 30min、失败 2min（TTL 见上方 CACHE_TTL_*_MS），避免多用户重复测活打爆上游 */
const probeCache = new Map<string, { outcome: ProbeOutcome; expiresAt: number }>();

function cacheGet(url: string): ProbeOutcome | undefined {
  const entry = probeCache.get(url);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    probeCache.delete(url);
    return undefined;
  }
  return entry.outcome;
}

function cacheSet(url: string, outcome: ProbeOutcome): void {
  if (probeCache.size >= CACHE_MAX_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of probeCache) {
      if (now > v.expiresAt) probeCache.delete(k);
    }
    if (probeCache.size >= CACHE_MAX_ENTRIES) {
      const oldest = probeCache.keys().next().value;
      if (oldest !== undefined) probeCache.delete(oldest);
    }
  }
  probeCache.set(url, {
    outcome,
    expiresAt: Date.now() + (outcome.ok ? CACHE_TTL_OK_MS : CACHE_TTL_FAIL_MS),
  });
}

export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  let body: { urls?: unknown };
  try {
    const declared = Number(req.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_PROBE_BODY_BYTES) {
      return jsonError('请求体超过 64KB 限制', 413);
    }
    const raw = await readRequestTextLimited(req, MAX_PROBE_BODY_BYTES);
    body = JSON.parse(raw) as { urls?: unknown };
  } catch (error) {
    if (error instanceof Error && error.message === 'REQUEST_BODY_TOO_LARGE') {
      return jsonError('请求体超过 64KB 限制', 413);
    }
    return jsonError('无效请求体', 400);
  }
  if (!Array.isArray(body.urls)) return jsonError('urls 必须为字符串数组', 400);

  const urls = [...new Set(
    body.urls.filter((u): u is string => {
      if (typeof u !== 'string' || u.length > 4096) return false;
      try {
        const parsed = new URL(u);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.username && !parsed.password;
      } catch { return false; }
    })
  )].slice(0, MAX_URLS);
  const stream = new URL(req.url).searchParams.get('stream') === '1';
  if (urls.length === 0) {
    return stream
      ? new NextResponse('', { headers: NDJSON_HEADERS })
      : NextResponse.json({ results: [] });
  }

  if (stream) return ndjsonResponse(urls, req.signal);

  const outcomes = new Map<string, ProbeOutcome>();
  // 先命中缓存，减少需要真实探测的目标
  const pending: string[] = [];
  for (const u of urls) {
    const hit = cacheGet(u);
    if (hit) outcomes.set(u, hit);
    else pending.push(u);
  }

  // 简单并发池：固定 worker 数从游标取任务（单线程内 cursor++ 无 await 间隙，无竞态）
  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      if (req.signal.aborted) return;
      const url = pending[cursor++];
      const outcome = await withHostLimit(url, () => probeOne(url, req.signal));
      if (req.signal.aborted) return;
      cacheSet(url, outcome);
      outcomes.set(url, outcome);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));
  if (req.signal.aborted) return jsonError('请求已取消', 499);

  return NextResponse.json(
    { results: urls.map((u) => outcomes.get(u)!) },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
