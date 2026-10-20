import { normalizeTitle } from './cms-parser';

/**
 * 片头/片尾跳过：标记的归一化、校验与「当前是否命中」判定。
 *
 * 采集站的详情接口不提供片头片尾元数据（vod_play_url 只有分集地址），
 * 因此边界只能由用户手动标记一次、按剧名记住，后续各集与同名资源自动套用。
 * 本模块只做纯计算，播放器接入与 UI 见 player-shell.tsx / skip-mark-panel.tsx。
 */

/** 一条剧的跳过标记；时间单位为秒（播放时间轴，与广告过滤后的时间轴一致） */
export interface SkipMark {
  /** 片头结束位置（正片开始） */
  introEnd?: number;
  /** 片尾开始位置（正片结束、片尾曲开始） */
  outroStart?: number;
  /** 最近一次修改时间（epoch ms），便于后续做清理/展示 */
  updatedAt: number;
}

/** 某集经过时长校验后的有效跳过窗口；非法字段会被剔除 */
export interface SkipWindow {
  introEnd?: number;
  outroStart?: number;
}

/** 片头结束与片尾开始之间至少保留的正片时长：贴太近说明两个标记至少有一个错了 */
export const MIN_MARK_GAP_SECONDS = 10;
/** 片头结束的合法下限：刚起播时误点不会写入无意义标记 */
export const MIN_INTRO_SECONDS = 3;
/** 片尾开始的合法下限 */
export const MIN_OUTRO_SECONDS = 5;
/** 标记至少要比总时长提前的秒数，贴着结尾的标记没有跳过价值 */
export const END_GUARD_SECONDS = 2;
/** 片头提示的收尾余量：距片头结束不足 1s 时不再打扰 */
export const INTRO_PROMPT_GUARD_SECONDS = 1;
/** 两次 timeupdate 之间超过该秒数视为 seek，不使用「连续越过」判定 */
export const MAX_CONTINUOUS_STEP_SECONDS = 10;

/** 播放页在拿不到真实标题时使用的占位文案（与 watch/page.tsx 保持一致） */
const UNKNOWN_TITLE = '未知视频';

function isValidTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
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
 * 把持久化标记裁剪成当前这集可用的窗口。
 *
 * 必须是「读取侧」校验：标记按剧共享，不同集/不同源的时长可能不同，
 * 旧标记完全可能越界；损坏的持久化数据也不应让播放报错。
 * 片头与片尾冲突（间隔不足）时保留片头、丢弃片尾——片头通常更早也更稳定。
 */
export function resolveSkipWindow(mark: SkipMark | undefined, duration: number): SkipWindow {
  if (!mark || !Number.isFinite(duration) || duration <= 0) return {};

  const introEnd =
    isValidTime(mark.introEnd) &&
    mark.introEnd >= MIN_INTRO_SECONDS &&
    mark.introEnd <= duration - END_GUARD_SECONDS
      ? mark.introEnd
      : undefined;

  let outroStart =
    isValidTime(mark.outroStart) &&
    mark.outroStart >= MIN_OUTRO_SECONDS &&
    mark.outroStart <= duration - END_GUARD_SECONDS
      ? mark.outroStart
      : undefined;

  if (introEnd !== undefined && outroStart !== undefined && outroStart - introEnd < MIN_MARK_GAP_SECONDS) {
    outroStart = undefined;
  }

  return {
    ...(introEnd !== undefined ? { introEnd } : {}),
    ...(outroStart !== undefined ? { outroStart } : {}),
  };
}

/** 当前是否仍处于片头（用于显示「跳过片头」按钮） */
export function isIntroActive(position: number, window: SkipWindow): boolean {
  const { introEnd } = window;
  if (introEnd === undefined || !Number.isFinite(position)) return false;
  return position >= 0 && position < introEnd - INTRO_PROMPT_GUARD_SECONDS;
}

/**
 * 是否在连续播放中越过了片尾起点。
 * 只认小步前进：用户拖动进度条、刚写入标记、以及进度恢复造成的大跳变
 * 都不应触发自动结束；这些场景仍会显示按钮，由用户自己决定。
 */
export function hasCrossedOutro(previous: number, current: number, window: SkipWindow): boolean {
  const { outroStart } = window;
  if (outroStart === undefined) return false;
  if (!Number.isFinite(previous) || !Number.isFinite(current)) return false;
  const step = current - previous;
  return previous < outroStart && current >= outroStart && step > 0 && step <= MAX_CONTINUOUS_STEP_SECONDS;
}

/** 校验「片头结束」；duration 未知（<=0）时只做相对校验。返回错误文案或 null */
export function validateIntroEnd(value: number, duration: number, mark?: SkipMark): string | null {
  if (!isValidTime(value)) return '片头结束时间无效';
  if (value < MIN_INTRO_SECONDS) return '请播放几秒后再记录片头结束';
  if (Number.isFinite(duration) && duration > 0 && value > duration - END_GUARD_SECONDS) {
    return '片头结束不能接近视频末尾';
  }
  const outroStart = mark?.outroStart;
  if (isValidTime(outroStart) && value > outroStart - MIN_MARK_GAP_SECONDS) {
    return `片头结束需早于片尾开始至少 ${MIN_MARK_GAP_SECONDS} 秒`;
  }
  return null;
}

/** 校验「片尾开始」；规则与 validateIntroEnd 对称 */
export function validateOutroStart(value: number, duration: number, mark?: SkipMark): string | null {
  if (!isValidTime(value)) return '片尾开始时间无效';
  if (value < MIN_OUTRO_SECONDS) return '请播放到片尾附近再记录片尾开始';
  if (Number.isFinite(duration) && duration > 0 && value > duration - END_GUARD_SECONDS) {
    return '片尾开始需早于视频结束';
  }
  const introEnd = mark?.introEnd;
  if (isValidTime(introEnd) && value < introEnd + MIN_MARK_GAP_SECONDS) {
    return `片尾开始需晚于片头结束至少 ${MIN_MARK_GAP_SECONDS} 秒`;
  }
  return null;
}
