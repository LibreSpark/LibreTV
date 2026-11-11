import { normalizeTitle } from './cms-parser';

/**
 * 跳过片段：标记的归一化、校验与「当前是否命中」判定。
 *
 * 采集站的详情接口不提供片头片尾元数据（vod_play_url 只有分集地址），
 * 因此边界只能由用户手动标记一次、按剧名记住，后续各集与同名资源自动套用。
 *
 * 相比固定的「片头/片尾」两个标记，这里泛化为任意数量的跳过片段（SkipSegment），
 * 每个片段用位置归类：opening（开头/片头）、middle（中间）、ending（结尾/片尾）。
 * 本模块只做纯计算，播放器接入与 UI 见 player-shell.tsx / skip-mark-panel.tsx。
 *
 * 三类片段的锚点不同，这是刻意的：
 * - 片头/中段锚在时间轴开头（第 X 秒 → 第 Y 秒）；
 * - 片尾锚在时间轴末尾（距结尾 tail 秒），生效起点 = 本集时长 - tail。
 *   采集站各集时长常常差一两分钟，片尾若只存绝对起点，短一集的标记会整条失效
 *   （起点已越过片尾护栏）、长一集会一路跳到结尾多跳几分钟；倒着算就不会。
 */

/** 片段位置类型：开头 / 中间 / 结尾 */
export type SkipSegmentType = 'opening' | 'middle' | 'ending';

/** 一条跳过片段；时间单位为秒（播放时间轴，与广告过滤后的时间轴一致） */
export interface SkipSegment {
  type: SkipSegmentType;
  /** 片段起点；opening 恒为 0 */
  start: number;
  /** 片段终点；ending 用 -1 表示「到视频结尾」，运行时以实际时长填充 */
  end: number;
  /**
   * 片尾专用：距视频结尾的秒数（倒着算的长度），生效起点 = 时长 - tail。
   * 缺省表示这是一条历史遗留的「绝对起点」片尾标记，沿用 start 的老语义；
   * 新记录与任何一次微调都会补上 tail。
   * ending 的 start 保留为记录当时的绝对起点，只做展示与时长未知时的兜底。
   */
  tail?: number;
}

/** 一部剧的跳过标记；按归一化剧名持久化 */
export interface SkipMark {
  segments: SkipSegment[];
  /** 本剧总开关：关掉后保留标记但完全不生效（误标时不必删掉重标） */
  enabled: boolean;
  /** 最近一次修改时间（epoch ms），便于后续做清理/展示 */
  updatedAt: number;
}

/** 三类片段在进度条色带与图例中的颜色（player-shell / skip-mark-panel 共用） */
export const SEGMENT_COLORS: Record<SkipSegmentType, string> = {
  opening: 'rgba(37,99,235,0.45)',
  middle: 'rgba(148,163,184,0.45)',
  ending: 'rgba(249,115,22,0.45)',
};

/** 三类片段的展示名（面板列表 / 进度条 tooltip 共用） */
export const SEGMENT_LABELS: Record<SkipSegmentType, string> = {
  opening: '片头',
  middle: '中段',
  ending: '片尾',
};

/** 某集经过时长校验后的有效片段；ending 的 end 已填充为实际时长，起点按 tail 倒算 */
export interface ResolvedSegment {
  type: SkipSegmentType;
  start: number;
  end: number;
}

/** 跳过片段的最短时长：比这更短的区间没有跳过价值 */
export const MIN_SEGMENT_SECONDS = 3;
/** 相邻片段之间的最小间隔：贴太近说明某个标记错了 */
export const MIN_SEGMENT_GAP_SECONDS = 5;
/** 片段终点（ending 为起点）至少要比总时长提前的秒数，贴着结尾的片段没有跳过价值 */
export const END_GUARD_SECONDS = 2;
/**
 * 片尾长度占本集时长的上限。
 * 倒着算让标记能跨集套用，代价是短片/特辑会被一条长尾标记吃掉大半集——
 * 例如 27 分钟记录的 2 分钟片尾，套到 5 分钟的特辑就是跳过 40%。
 * 超过该比例宁可整条不生效（用户仍可自己拖进度条），也不要默默切掉大半集正片。
 */
export const MAX_ENDING_TAIL_RATIO = 0.25;
/** 命中提示的收尾余量：距片段末尾不足 1s 时不再打扰 */
export const PROMPT_GUARD_SECONDS = 1;
/** 两次 timeupdate 之间超过该秒数视为 seek，不使用「连续越过」判定 */
export const MAX_CONTINUOUS_STEP_SECONDS = 10;

/** 播放页在拿不到真实标题时使用的占位文案（watch/page.tsx 复用，避免双处硬编码） */
export const UNKNOWN_TITLE = '未知视频';

const SEGMENT_TYPES: ReadonlySet<string> = new Set<SkipSegmentType>(['opening', 'middle', 'ending']);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 标记的存储键。
 * - 有标题时按归一化标题：同剧各集、换源后的同名资源共享同一份标记；
 * - 标题缺失/占位文案时退回 `${sourceKey}:${vodId}`，至少保证本源本片可用。
 * 前缀区分两类键，避免真实标题恰好长成兜底键的形态而串数据。
 */
export function skipMarkKey(title: string | undefined, fallback: string): string {
  const normalized = normalizeTitle(title ?? '');
  if (!normalized || normalized === normalizeTitle(UNKNOWN_TITLE)) {
    return `f:${fallback}`;
  }
  return `t:${normalized}`;
}

/**
 * 把持久化快照里的 skipMarks 归一化为当前结构（persist v3 → v4）。
 * - 已是 segments 结构的直接保留（按结构探测，兼容后续再升级）；
 * - 旧的 { introEnd, outroStart } 转成 opening + ending 两条；
 * - 片尾的 tail（距结尾长度）原样保留；没有 tail 就是历史「绝对起点」片尾，沿用旧语义；
 * - 损坏条目（null/非对象）直接丢弃，绝不能让恢复过程抛错。
 */
export function migrateSkipMarks(raw: unknown): Record<string, SkipMark> {
  const result: Record<string, SkipMark> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const mark = value as {
      segments?: unknown;
      enabled?: unknown;
      introEnd?: unknown;
      outroStart?: unknown;
      updatedAt?: unknown;
    };
    const updatedAt = typeof mark.updatedAt === 'number' ? mark.updatedAt : Date.now();
    // 缺省视为开启：v4 及更早的快照没有这个字段
    const enabled = mark.enabled !== false;

    if (Array.isArray(mark.segments)) {
      // 逐条校验结构：面板直接渲染 segments，损坏条目会显示成 NaN:NaN
      const valid = (mark.segments as unknown[]).flatMap((s): SkipSegment[] => {
        if (!s || typeof s !== 'object') return [];
        const seg = s as { type?: unknown; start?: unknown; end?: unknown; tail?: unknown };
        if (typeof seg.type !== 'string' || !SEGMENT_TYPES.has(seg.type)) return [];
        if (!isFiniteNumber(seg.start) || !isFiniteNumber(seg.end)) return [];
        const item: SkipSegment = {
          type: seg.type as SkipSegmentType,
          start: seg.start,
          end: seg.end,
        };
        // tail 只对片尾有意义：非片尾带着脏 tail 会误启用倒算语义，直接丢回绝对起点
        if (item.type === 'ending' && isFiniteNumber(seg.tail) && seg.tail > 0) {
          item.tail = seg.tail;
        }
        return [item];
      });
      result[key] = { segments: valid, enabled, updatedAt };
      continue;
    }

    const segments: SkipSegment[] = [];
    if (typeof mark.introEnd === 'number' && mark.introEnd > 0) {
      segments.push({ type: 'opening', start: 0, end: mark.introEnd });
    }
    if (typeof mark.outroStart === 'number' && mark.outroStart > 0) {
      segments.push({ type: 'ending', start: mark.outroStart, end: -1 });
    }
    result[key] = { segments, enabled, updatedAt };
  }
  return result;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/** 一条片尾的「距结尾长度」；无 tail（历史绝对起点标记）或非法时返回 null */
export function endingTailSeconds(seg: SkipSegment): number | null {
  if (seg.type !== 'ending') return null;
  return isFiniteNumber(seg.tail) && seg.tail > 0 ? seg.tail : null;
}

/**
 * 记录片尾时把「距结尾长度」补上：tail = 本集时长 - 起点。
 * 时长未知（播放器还没报时长）时原样返回，退化成历史的绝对起点语义。
 */
export function withEndingTail(segment: SkipSegment, duration: number): SkipSegment {
  if (segment.type !== 'ending') return segment;
  if (!isFiniteNumber(duration) || duration <= 0) return segment;
  const tail = round1(duration - segment.start);
  if (!(tail > 0)) return segment;
  return { ...segment, tail };
}

/**
 * 把一条片段的边界平移 delta 秒（+1 = 边界推后 1 秒），供面板/快捷键的 ±1s 微调使用。
 * - 片头调终点、中段整段平移；
 * - 片尾调的是「距结尾的长度」：边界推后 1 秒 = 少跳 1 秒 = 长度 -1，
 *   绝对起点同步平移，保证 start + tail 恒等于记录那集的时长；
 * - 历史「绝对起点」片尾只要有时长可参照就顺手换算成 tail（这次手动确认等于用户
 *   承认「本集从这里到结尾是片尾」）；拿不到时长时退回改绝对起点的老语义。
 */
export function nudgeSegment(seg: SkipSegment, delta: number, duration: number): SkipSegment {
  if (seg.type === 'opening') return { ...seg, end: round1(seg.end + delta) };
  if (seg.type !== 'ending') {
    return { ...seg, start: round1(seg.start + delta), end: round1(seg.end + delta) };
  }
  const tail =
    endingTailSeconds(seg) ??
    (isFiniteNumber(duration) && duration > 0 ? round1(duration - seg.start) : null);
  if (tail === null) return { ...seg, start: round1(seg.start + delta) };
  return { ...seg, start: round1(seg.start + delta), tail: round1(tail - delta) };
}

/**
 * 单条片段在当前这集的生效区间：opening 起点恒 0，ending 终点用时长填充，
 * 带 tail 的片尾起点按时长倒算。非法/越界/长度异常时返回 null。
 *
 * 必须是「读取侧」校验：标记按剧共享，不同集/不同源的时长可能不同，
 * 旧标记完全可能越界；损坏的持久化数据也不应让播放报错。
 */
export function resolveSegment(
  seg: SkipSegment | undefined,
  duration: number
): ResolvedSegment | null {
  if (!seg || !SEGMENT_TYPES.has(seg.type)) return null;
  if (!isFiniteNumber(seg.start) || seg.start < 0) return null;
  if (!isFiniteNumber(duration) || duration <= 0) return null;

  if (seg.type === 'ending') {
    const tail = endingTailSeconds(seg);
    if (tail !== null) {
      // 倒着算：长度太短没有跳过价值，太长会把短片/特辑的大半集切掉，两种都整条不生效
      if (tail < MIN_SEGMENT_SECONDS) return null;
      if (tail > duration * MAX_ENDING_TAIL_RATIO) return null;
      const start = round1(duration - tail);
      if (start < END_GUARD_SECONDS) return null;
      return { type: 'ending', start, end: duration };
    }
    // 历史「绝对起点」片尾：沿用旧语义（等长/更长的集照常生效，短集不生效）
    const start = seg.start;
    if (start > duration - END_GUARD_SECONDS) return null;
    if (duration - start < MIN_SEGMENT_SECONDS) return null;
    return { type: 'ending', start, end: duration };
  }

  const start = seg.type === 'opening' ? 0 : seg.start;
  const end = seg.end;
  if (!isFiniteNumber(end)) return null;
  if (end <= start) return null;
  if (end - start < MIN_SEGMENT_SECONDS) return null;
  if (end > duration - END_GUARD_SECONDS) return null;

  return { type: seg.type, start, end };
}

/**
 * 把持久化标记裁剪成当前这集可用的片段列表（按 start 升序、无重叠）。
 * ending 的 end 用实际时长填充；重叠或过近的片段保留靠前者、丢弃后者。
 */
export function resolveSegments(mark: SkipMark | undefined, duration: number): ResolvedSegment[] {
  if (!mark || !Array.isArray(mark.segments) || !isFiniteNumber(duration) || duration <= 0) return [];
  // 本剧总开关关闭：保留标记但一格都不生效（缺省视为开启，兼容旧快照）
  if (mark.enabled === false) return [];

  const resolved: ResolvedSegment[] = [];
  for (const seg of mark.segments) {
    const r = resolveSegment(seg, duration);
    if (r) resolved.push(r);
  }
  resolved.sort((a, b) => a.start - b.start);

  const result: ResolvedSegment[] = [];
  for (const seg of resolved) {
    const last = result[result.length - 1];
    if (last && seg.start - last.end < MIN_SEGMENT_GAP_SECONDS) continue;
    result.push(seg);
  }
  return result;
}

/** 当前位置是否落在某个跳过片段内（用于显示「跳过」按钮与自动跳转） */
export function findActiveSegment(
  segments: ResolvedSegment[],
  position: number
): ResolvedSegment | undefined {
  if (!isFiniteNumber(position)) return undefined;
  return segments.find((s) => position >= s.start && position < s.end - PROMPT_GUARD_SECONDS);
}

/**
 * 是否在连续播放中越过了「结尾」片段的起点。
 * 只认小步前进：用户拖动进度条、刚写入标记、以及进度恢复造成的大跳变
 * 都不应触发自动结束；这些场景仍会显示按钮，由用户自己决定。
 */
export function findCrossedEnding(
  segments: ResolvedSegment[],
  previous: number,
  current: number
): boolean {
  if (!isFiniteNumber(previous) || !isFiniteNumber(current)) return false;
  const step = current - previous;
  if (!(step > 0 && step <= MAX_CONTINUOUS_STEP_SECONDS)) return false;
  return segments.some((s) => s.type === 'ending' && previous < s.start && current >= s.start);
}

/**
 * 校验一条待写入的片段；duration 未知（<=0）时只做相对校验。返回错误文案或 null。
 * existing 为当前已保存的片段（不含待写入这条）。
 *
 * 片尾有两种写法：带 tail（按距结尾长度校验）与不带的历史绝对起点。
 * 写入路径（面板按钮与快捷键）都会先补齐 tail，因为绝对起点只在和记录那集等长时才等价；
 * 本函数两种都接受，好让历史标记在被手动微调时仍能通过校验。
 */
export function validateSegment(
  segment: SkipSegment,
  duration: number,
  existing: SkipSegment[] = []
): string | null {
  if (!segment || !SEGMENT_TYPES.has(segment.type)) return '片段类型无效';
  if (!isFiniteNumber(segment.start) || segment.start < 0) return '片段起点无效';
  if (segment.type === 'opening' && segment.start !== 0) return '片头片段起点必须为 0';

  const hasDuration = isFiniteNumber(duration) && duration > 0;
  const tail = endingTailSeconds(segment);
  if (segment.type === 'ending') {
    if (segment.end !== -1) return '片尾片段无需指定终点';
    if (segment.tail !== undefined && tail === null) return '片尾长度无效';
    if (tail !== null && tail < MIN_SEGMENT_SECONDS) {
      return `片尾长度至少需要 ${MIN_SEGMENT_SECONDS} 秒`;
    }
  } else if (!isFiniteNumber(segment.end)) {
    return '片段终点无效';
  }

  // 本次校验用的区间：片尾优先用倒算起点，其余取字面值
  const start = segment.type === 'ending' && tail !== null && hasDuration ? duration - tail : segment.start;
  let end: number;
  if (segment.type === 'ending') {
    end = hasDuration ? duration : Number.POSITIVE_INFINITY;
  } else {
    end = segment.end;
  }

  if (end - start < MIN_SEGMENT_SECONDS) {
    return `跳过片段至少需要 ${MIN_SEGMENT_SECONDS} 秒`;
  }
  if (hasDuration) {
    if (segment.type === 'ending') {
      if (tail !== null) {
        if (tail > duration * MAX_ENDING_TAIL_RATIO) {
          return `片尾长度不能超过本集时长的 ${Math.round(MAX_ENDING_TAIL_RATIO * 100)}%`;
        }
      } else if (start > duration - END_GUARD_SECONDS) {
        return '片尾开始不能贴近视频末尾';
      }
    } else if (end > duration - END_GUARD_SECONDS) {
      return '片段终点不能贴近视频末尾';
    }
  }

  for (const other of existing) {
    if (!other || !SEGMENT_TYPES.has(other.type)) continue;
    // 已有片段同样按时长解析（片尾可能是倒算的），解析不出来时退回字面值，判定保持保守
    const r = hasDuration ? resolveSegment(other, duration) : null;
    const oStart = r ? r.start : other.start;
    let oEnd: number;
    if (r) oEnd = r.end;
    else if (other.type === 'ending') oEnd = hasDuration ? duration : Number.POSITIVE_INFINITY;
    else oEnd = isFiniteNumber(other.end) ? other.end : other.start;
    // 与已有片段的重叠/间隔判定：gap <= 0 为重叠，0 < gap < MIN_GAP 为过近
    const gap = Math.max(oStart - end, start - oEnd);
    if (gap < MIN_SEGMENT_GAP_SECONDS) {
      return gap <= 0 ? '片段与已有片段重叠' : `片段之间至少间隔 ${MIN_SEGMENT_GAP_SECONDS} 秒`;
    }
  }
  return null;
}
