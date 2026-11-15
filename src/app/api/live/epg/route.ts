import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import { checkLiveUrlAllowed } from '@/lib/ssrf';
import { fetchLiveUpstream } from '@/lib/fetch-utils';
import { getLiveCache, setLiveCache } from '@/lib/live-cache';
import { currentAndNext, parseXmltv } from '@/lib/xmltv';
import type { EpgProgram } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** XMLTV 文件较大，放宽抓取超时 */
const FETCH_TIMEOUT_MS = 30_000;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_XMLTV_BYTES = 32 * 1024 * 1024;

async function readBodyLimited(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('XMLTV 文件超过 32MB 限制');
  if (!res.body) return Buffer.alloc(0);
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
        throw new Error('XMLTV 文件超过 32MB 限制');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

/**
 * 拉取并解析 XMLTV 节目单（支持 gzip）。
 * GET /api/live/epg?url=<xmltv>&channel=<tvgId>&force=1
 * 解析结果（按频道索引、24h 时间窗裁剪）整体缓存 6 小时；单频道按需查询。
 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const sp = new URL(req.url).searchParams;
  const url = sp.get('url')?.trim();
  const channel = sp.get('channel')?.trim();
  if (!url || !channel) return jsonError('缺少 url 或 channel 参数', 400);
  const force = sp.get('force') === '1';

  // 直播专用校验：LIVE_ALLOW_PRIVATE=1 时才允许内网自建 IPTV 的 XMLTV 节目单。
  const verdict = await checkLiveUrlAllowed(url);
  if (!verdict.ok) return jsonError(verdict.reason, 403);

  const key = `live:epg:${url}`;
  let programMap: Map<string, EpgProgram[]> | undefined = force ? undefined : getLiveCache(key);
  if (!programMap) {
    try {
      const res = await fetchLiveUpstream(url, { timeoutMs: FETCH_TIMEOUT_MS, retries: 0, signal: req.signal });
      if (!res.ok) {
        return jsonError(`节目单地址请求失败: ${res.status}`, 502);
      }
      // gzip 由 parseXmltv 内识别（fetch 对 .gz 不会自动解压）
      const buf = await readBodyLimited(res, MAX_XMLTV_BYTES);
      programMap = parseXmltv(buf, WINDOW_MS);
      setLiveCache(key, programMap, CACHE_TTL_MS, buf.byteLength * 2);
    } catch (err) {
      return jsonError(`节目单地址请求失败: ${err instanceof Error ? err.message : '未知错误'}`, 502);
    }
  }

  const programs = programMap.get(channel) ?? [];
  const { current, next } = currentAndNext(programs);

  return NextResponse.json(
    { channelId: channel, current, next, programs },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
