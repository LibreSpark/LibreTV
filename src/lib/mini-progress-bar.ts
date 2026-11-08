/**
 * 「底部细进度条」状态机（issue LibreSpark/LibreTV#965）。
 *
 * ArtPlayer 的 miniProgressBar 是一个插件：它在 `control` 事件里给播放器元素挂/摘
 * `art-mini-progress-bar` 类；CSS 随即把 `.art-bottom` 整条下移 52.5px 并由
 * `overflow: hidden` 裁掉，只在画面底边留一条 3px 的进度线常驻（已播段是主题色，
 * 未播段 rgba(255,255,255,.25)，圆点指示器 display:none）。两个必须记住的前提：
 *
 * 1. **插件在不在，取决于构造时的 option.miniProgressBar**，运行时不可更换；
 * 2. 该类只在「控制栏已收起」时才改变几何——库样式里 `.art-control-show … translateY(0)`
 *    排在 mini 规则之后，同特异性下后者胜出，所以控制栏可见时挂着不会让控制栏跳位；
 *    但同一组规则里的 `background-image: none`（底部渐变遮罩）与
 *    `.art-progress-indicator { display: none !important }`（进度圆点）是**无条件**生效的。
 *    类名一旦常驻，控制栏看着正常，渐变遮罩和圆点却没了。
 *
 * 因此策略是：构造时**恒传 true**（保证插件状态机常驻，它是「控制栏显示时摘类」的唯一
 * 维护者），设置项只负责把类名收敛到「开启 且 控制栏已收起」这一个目标态。
 * 不去猜库的内部状态，也不判断任何臆想中的类名。
 */

/** ArtPlayer 用来切换细进度条的类名（库内部约定，我们只依赖它和下面这一个） */
export const MINI_PROGRESS_BAR_CLASS = 'art-mini-progress-bar';

/** 控制栏可见标志：收起时该 class 会被摘掉，是判断可见性的唯一可靠依据 */
export const CONTROL_SHOW_CLASS = 'art-control-show';

/** 最小 DOM 依赖：只用 classList 的三个方法，便于在 node 环境下用假对象驱动真实逻辑 */
export interface ClassListLike {
  contains(token: string): boolean;
  add(token: string): void;
  remove(token: string): void;
}

export interface MiniProgressBarState {
  /** 设置项 miniProgressBar（出厂默认 true，保持既有观感） */
  enabled: boolean;
  /** 控制栏此刻是否可见：`control` 事件的 state，或播放器元素上的 art-control-show */
  controlsShown: boolean;
}

/** 唯一判定：只有「设置开启 + 控制栏已收起」才保留类名 */
export function shouldKeepMiniProgressBar({ enabled, controlsShown }: MiniProgressBarState): boolean {
  return enabled && !controlsShown;
}

/**
 * 把类名同步到目标态，返回同步后的期望值。
 * classList 为空（播放器未创建 / 已销毁）时什么都不做，返回 false。
 * 幂等：已经是目标态就不再调用 add/remove。
 */
export function syncMiniProgressBar(
  classList: ClassListLike | null | undefined,
  state: MiniProgressBarState
): boolean {
  if (!classList) return false;
  const keep = shouldKeepMiniProgressBar(state);
  if (classList.contains(MINI_PROGRESS_BAR_CLASS) === keep) return keep;
  if (keep) {
    classList.add(MINI_PROGRESS_BAR_CLASS);
  } else {
    classList.remove(MINI_PROGRESS_BAR_CLASS);
  }
  return keep;
}
