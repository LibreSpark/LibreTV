import { gunzipSync } from 'node:zlib';
import type { EpgProgram } from './types';

/**
 * XMLTV 节目单解析。
 *
 * XMLTV 文件常达数十 MB，这里不做完整 DOM 解析，而是单趟正则扫描
 * `<programme ...>` 节点，解析后按频道索引、按时间窗裁剪并丢弃原始文本，
 * 避免内存中同时持有原始 XML 与解析结果。
 *
 * 时间格式：`20240101120000 +0800`（秒可带毫秒小数，时区可省略或为 Z / ±hhmm）。
 */

const PROGRAMME_RE = /<programme\s+([^>]*?)\/>|<programme\s+([^>]*?)>([\s\S]*?)<\/programme>/g;
const ATTR_RE = /([a-zA-Z0-9_-]+)="([^"]*)"/g;
const TITLE_RE = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i;
const DESC_RE = /<desc(?:\s[^>]*)?>([\s\S]*?)<\/desc>/i;

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_GZIP_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_PROGRAMME_NODES = 150_000;
const MAX_PROGRAMMES_PER_CHANNEL = 5_000;
const MAX_CHANNEL_ID_CHARS = 256;
const MAX_TITLE_CHARS = 500;
const MAX_DESCRIPTION_CHARS = 4_000;

/** 安全解码码点：畸形实体（越界/NaN）返回空串而非抛 RangeError，避免单条脏数据毁掉整份 EPG */
function safeCodePoint(n: number): string {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}

/** 解析 XMLTV 实体（含 CDATA 与数字实体） */
function decodeXmlText(raw: string): string {
  let text = raw.trim();
  const cdata = text.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  if (cdata) text = cdata[1];
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** 解析 `YYYYMMDDHHmmss(.fff)?( +hhmm | Z)?` 为 epoch ms；无法解析返回 NaN */
export function parseXmltvTime(raw: string): number {
  const m = raw
    .trim()
    .match(/^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?(?:\.(\d{1,3}))?(?:\s*([+-])(\d{2})(\d{2})|Z)?$/);
  if (!m) return NaN;
  const [, y, mo, d, h, mi, s, frac, sign, tzh, tzm] = m;
  const utcMs = Date.UTC(
    +y,
    +mo - 1,
    +d,
    +(h || 0),
    +(mi || 0),
    +(s || 0),
    frac ? +(frac.padEnd(3, '0')) : 0
  );
  if (!sign) return utcMs; // 无时区按 UTC 处理
  const offsetMin = (+tzh) * 60 + (+tzm);
  const offsetMs = offsetMin * 60 * 1000 * (sign === '-' ? -1 : 1);
  return utcMs - offsetMs;
}

function extractAttrs(attrText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(attrText))) attrs[m[1].toLowerCase()] = m[2];
  return attrs;
}

/**
 * 解析 XMLTV 内容。string 直接入扫描；Buffer 自动识别 gzip（1f 8b 魔数）解压。
 * 只保留 `[now, now + windowMs]` 窗口内的节目，按频道分组并按开播时间排序。
 */
export function parseXmltv(
  content: string | Buffer,
  windowMs: number = DEFAULT_WINDOW_MS,
  now: number = Date.now()
): Map<string, EpgProgram[]> {
  let text: string;
  if (Buffer.isBuffer(content)) {
    text =
      content.length >= 2 && content[0] === 0x1f && content[1] === 0x8b
        ? gunzipSync(content, { maxOutputLength: MAX_GZIP_OUTPUT_BYTES }).toString('utf8')
        : content.toString('utf8');
  } else {
    text = content;
  }

  const result = new Map<string, EpgProgram[]>();
  const windowEnd = now + windowMs;

  PROGRAMME_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let programmeNodes = 0;
  while ((m = PROGRAMME_RE.exec(text))) {
    programmeNodes += 1;
    if (programmeNodes > MAX_PROGRAMME_NODES) {
      throw new Error('XMLTV 节目条目超过 150000 条限制');
    }
    const attrText = m[1] ?? m[2] ?? '';
    const inner = m[3] ?? '';
    const attrs = extractAttrs(attrText);
    const channelId = attrs['channel']?.trim();
    if (!channelId || channelId.length > MAX_CHANNEL_ID_CHARS) continue;
    const start = parseXmltvTime(attrs['start'] || '');
    const stop = parseXmltvTime(attrs['stop'] || '');
    if (!Number.isFinite(start) || !Number.isFinite(stop)) continue;
    // 窗口裁剪：节目已完全播完或完全在未来窗口之外则丢弃
    if (stop <= now || start >= windowEnd) continue;

    const titleMatch = inner.match(TITLE_RE);
    const descMatch = inner.match(DESC_RE);
    const program: EpgProgram = {
      channelId,
      start,
      stop,
      title: titleMatch ? decodeXmlText(titleMatch[1]).slice(0, MAX_TITLE_CHARS) : '',
    };
    if (descMatch) program.desc = decodeXmlText(descMatch[1]).slice(0, MAX_DESCRIPTION_CHARS);
    if (!program.title) continue;

    const list = result.get(channelId);
    if (list) {
      if (list.length < MAX_PROGRAMMES_PER_CHANNEL) list.push(program);
    } else {
      result.set(channelId, [program]);
    }
  }

  // 按开播时间排序（XMLTV 不保证顺序）
  for (const list of result.values()) list.sort((a, b) => a.start - b.start);
  return result;
}

/** 取某频道当前正在播出的节目与下一个节目 */
export function currentAndNext(
  programs: EpgProgram[],
  at: number = Date.now()
): { current?: EpgProgram; next?: EpgProgram } {
  let current: EpgProgram | undefined;
  let next: EpgProgram | undefined;
  for (const p of programs) {
    if (p.start <= at && p.stop > at) {
      current = p;
      continue; // 同一时刻可能有重叠节目，取最后一个命中者
    }
    if (p.start > at) {
      next = p;
      break;
    }
  }
  return { current, next };
}
