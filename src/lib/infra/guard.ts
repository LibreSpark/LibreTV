import { isSafeInternalPath, type MovieItem } from '@/types/chat';

export type GuardMode = 'mask' | 'block';
export type HitLevel = 'low' | 'high';
export type GuardAction = 'mask' | 'block' | 'log';

export interface KeywordRule { word: string; level: HitLevel; action?: GuardAction; }
export interface InputVerdict { ok: boolean; code?: 'TOO_LONG' | 'INJECTION' | 'EMPTY'; reason?: string; }

export const INPUT_LIMITS = { maxChars: 2000 } as const;

const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/u;
const COMBINING = /\p{Mn}/u;

export function normalizeWithMap(src: string): { norm: string; map: number[] } {
  const norm: string[] = []; const map: number[] = [];
  let utf16Index = 0;
  for (const ch of src) {
    if (!INVISIBLE.test(ch) && !COMBINING.test(ch)) {
      for (const c of ch.normalize('NFKC').toLowerCase()) { norm.push(c); map.push(utf16Index); }
    }
    utf16Index += ch.length;
  }
  return { norm: norm.join(''), map };
}

interface Node { next: Map<string, Node>; fail: Node; depth: number; hit: { word: string; level: HitLevel; action: GuardAction } | null; }
function makeNode(depth: number): Node { return { next: new Map(), fail: null as unknown as Node, depth, hit: null }; }

export class KeywordMatcher {
  private root: Node; private maxNormLen: number = 0;
  constructor(rules: KeywordRule[]) {
    this.root = makeNode(0); this.root.fail = this.root;
    for (const r of rules) {
      const { norm: w } = normalizeWithMap(r.word);
      if (!w) continue;
      this.maxNormLen = Math.max(this.maxNormLen, w.length);
      let cur = this.root;
      for (const ch of w) {
        let nx = cur.next.get(ch);
        if (!nx) { nx = makeNode(cur.depth + 1); cur.next.set(ch, nx); }
        cur = nx;
      }
      const action = r.action ?? (r.level === 'high' ? 'block' : 'mask');
      if (!cur.hit || cur.hit.level === 'low') cur.hit = { word: r.word, level: r.level, action };
    }
    this.buildFailLinks();
  }
  private buildFailLinks() {
    const queue: Node[] = [];
    for (const nx of this.root.next.values()) { nx.fail = this.root; queue.push(nx); }
    while (queue.length) {
      const cur = queue.shift()!;
      for (const [ch, nx] of cur.next) {
        let f = cur.fail;
        while (f !== this.root && !f.next.has(ch)) f = f.fail;
        nx.fail = f.next.get(ch) ?? this.root;
        queue.push(nx);
      }
    }
  }
  step(state: Node, ch: string): Node {
    let cur = state;
    while (cur !== this.root && !cur.next.has(ch)) cur = cur.fail;
    return cur.next.get(ch) ?? this.root;
  }
  get holdLimit(): number { return this.maxNormLen > 0 ? this.maxNormLen - 1 : 0; }
  rootOf(): Node { return this.root; }
}

const isHighSurrogate = (c: number) => c >= 0xD800 && c <= 0xDBFF;
const isLowSurrogate = (c: number) => c >= 0xDC00 && c <= 0xDFFF;

export class StreamScanner {
  private matcher: KeywordMatcher; private mode: GuardMode;
  private raw = ''; private masks: Array<[number, number]> = [];
  private norm = ''; private map: number[] = []; private state: Node;
  private hits: string[] = []; private blocked = false; private readonly MAX_HITS = 256;

  constructor(matcher: KeywordMatcher, mode: GuardMode = 'mask') {
    this.matcher = matcher; this.mode = mode; this.state = this.matcher.rootOf();
  }

  push(text: string): string {
    if (!text || this.blocked) return '';
    const offset = this.raw.length; const mapBase = this.map.length;
    const { norm: n, map: m } = normalizeWithMap(text);
    this.raw += text; this.norm += n;
    for (const x of m) this.map.push(x + offset);

    for (let i = 0; i < n.length; i++) {
      this.state = this.matcher.step(this.state, n[i]);
      let node: Node | null = this.state; let blockedHere = false;
      while (node && node !== this.matcher.rootOf()) {
        const hit = node.hit;
        if (hit) {
          if (this.hits.length < this.MAX_HITS && !this.hits.includes(hit.word)) this.hits.push(hit.word);
          if (hit.action === 'block' || (hit.action === 'mask' && this.mode === 'block')) { blockedHere = true; break; }
          if (hit.action === 'mask' || this.mode === 'mask') {
            const normWordLen = normalizeWithMap(hit.word).norm.length;
            const sIdx = mapBase + i - normWordLen + 1; const eIdx = mapBase + i;
            this.addMask(this.map[sIdx] ?? 0, (this.map[eIdx] ?? this.raw.length - 1) + 1);
          }
        }
        node = node.fail;
      }
      if (blockedHere) { this.blocked = true; this.raw = ''; this.norm = ''; this.map = []; this.masks = []; return ''; }
    }
    return this.emit();
  }

  private addMask(s: number, e: number) {
    if (s > 0 && isLowSurrogate(this.raw.charCodeAt(s))) s -= 1;
    if (e < this.raw.length && isHighSurrogate(this.raw.charCodeAt(e - 1))) e += 1;
    const last = this.masks[this.masks.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else this.masks.push([s, e]);
  }

  private emit(): string {
    const normCut = Math.max(0, this.norm.length - this.matcher.holdLimit);
    const rawCut = normCut >= this.norm.length ? 0 : (this.map[normCut] ?? this.raw.length);
    if (rawCut <= 0) return '';
    let out = ''; let cursor = 0;
    for (const [s, e] of this.masks) {
      if (s >= rawCut) break;
      const ee = Math.min(e, rawCut);
      if (cursor < s) out += this.raw.slice(cursor, s);
      out += '*'.repeat(ee - s); cursor = ee;
    }
    out += this.raw.slice(cursor, rawCut);
    this.raw = this.raw.slice(rawCut); this.norm = this.norm.slice(normCut);
    this.map = this.map.slice(normCut).map(x => x - rawCut);
    this.masks = this.masks.filter(([, e]) => e > rawCut).map(([s, e]) => [Math.max(0, s - rawCut), Math.max(0, e - rawCut)]);
    return out;
  }

  flush(): string {
    let out = ''; let cursor = 0;
    for (const [s, e] of this.masks) {
      if (cursor < s) out += this.raw.slice(cursor, s);
      out += '*'.repeat(e - s); cursor = e;
    }
    out += this.raw.slice(cursor);
    this.raw = ''; this.norm = ''; this.map = []; this.masks = []; this.state = this.matcher.rootOf();
    return out;
  }
  get blockedNow() { return this.blocked; }
  get hitWords() { return [...new Set(this.hits)]; }
}

const OUTPUT_KEYWORDS: KeywordRule[] = [
  { word: '赌博网站', level: 'high', action: 'block' },
  { word: '色情资源', level: 'high', action: 'block' },
  { word: '盗版链接', level: 'high', action: 'mask' },
  { word: '链接', level: 'low', action: 'mask' },
];

const OUTPUT_MATCHER = new KeywordMatcher(OUTPUT_KEYWORDS);
export const createStreamScanner = (mode: GuardMode = 'mask') => new StreamScanner(OUTPUT_MATCHER, mode);

const INJECTION_PATTERNS = [
  /(忽略|无视|绕过)[^。]{0,10}(以上|之前|前面)[^。]{0,10}(指令|规则|设定)/,
  /(ignore|disregard|bypass)\s+(all\s+)?(previous|above|prior)\s+(instructions?|rules?|prompts?)/i,
  /(你现在是|假装你是|扮演)[^。]{0,20}(没有限制|不受约束|越狱|dan模式)/,
  /(system\s*prompt|系统提示词|开发者模式)/i,
];

export function inspectInput(raw: string): InputVerdict {
  const text = raw ?? '';
  if (!text.trim()) return { ok: false, code: 'EMPTY', reason: '内容为空' };
  if (text.length > INPUT_LIMITS.maxChars) return { ok: false, code: 'TOO_LONG', reason: `超过 ${INPUT_LIMITS.maxChars} 字` };
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) return { ok: false, code: 'INJECTION', reason: '包含控制字符' };
  for (const re of INJECTION_PATTERNS) if (re.test(text)) return { ok: false, code: 'INJECTION', reason: '疑似注入' };
  return { ok: true };
}

const BAD_TITLE = /<script|javascript:|onerror\s*=|{{|}}/i;
export function guardMovieItems(items: MovieItem[]) {
  const out: MovieItem[] = []; let dropped = 0;
  for (const it of items ?? []) {
    const okTitle = typeof it?.title === 'string' && it.title.trim().length > 0 && !BAD_TITLE.test(it.title);
    const okPath = isSafeInternalPath(it?.path);
    const okId = typeof it?.id === 'string' && it.id.trim().length > 0;
    const okPoster = (() => {
      const p = it?.poster;
      if (typeof p !== 'string' || p.length > 2048) return false;
      if (/["'<>`\u0000-\u001F\u007F]/.test(p)) return false;
      if (/^\/(?!\/)[A-Za-z0-9-._~/?#&=]*$/.test(p)) return true;
      try {
        const u = new URL(p);
        return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password;
      } catch { return false; }
    })();
    if (okTitle && okPath && okPoster && okId) out.push({ ...it, title: it.title.slice(0, 200) });
    else dropped += 1;
  }
  return { items: out, dropped };
}
