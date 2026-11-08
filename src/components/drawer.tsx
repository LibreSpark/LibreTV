'use client';

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Icon } from './icon';

/**
 * 通用右侧抽屉骨架：
 * - 布局为 flex 纵向三段（标题栏 / 可选副标题栏 / 内容区），只有内容区滚动，
 *   调用方无需再用 sticky + 魔法数字偏移去贴标题栏；
 * - 打开时锁定 body 滚动，关闭后归还焦点，Tab 键在抽屉内循环（focus trap）；
 * - 带进入/退出过渡（水平滑入 + 遮罩淡入），退出动画结束后才卸载内容；
 * - modal=false 时退化成非模态侧栏：没有遮罩、不锁 body 滚动、不限制焦点，
 *   抽屉以外的区域照常可见可点（播放页要一边看画面一边标记，遮罩会挡住画面）。
 */

/** 退出过渡时长，需与下方 duration-200 保持一致 */
const EXIT_MS = 200;
/** 把手下滑多少 CSS px 判定为「要关闭」（小于该值松手回弹） */
const DRAG_CLOSE_PX = 64;

/** 抽屉内可聚焦元素选择器 */
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Drawer({
  open,
  onClose,
  title,
  children,
  width = 'max-w-md',
  subheader,
  footer,
  closeOnOverlay = true,
  resetScrollKey,
  modal = true,
  mobileSheet = false,
  mobileFull = false,
  panelStyle,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** 抽屉最大宽度类（如 max-w-lg） */
  width?: string;
  /** 固定在标题栏下方的非滚动区（如 Tab 条），随抽屉一起保持可见 */
  subheader?: ReactNode;
  /** 固定在滚动区下方的非滚动区（主操作按钮），内容再长也不用滚到底才能点 */
  footer?: ReactNode;
  /** 面板内联样式（小屏按剩余空间限制高度，避免压住上方画面） */
  panelStyle?: CSSProperties;
  /** 点击遮罩是否关闭（默认 true） */
  closeOnOverlay?: boolean;
  /** 该值变化时内容区滚回顶部（如切换设置分组 / 面板） */
  resetScrollKey?: string;
  /**
   * 是否模态（默认 true）。false 时不渲染遮罩、不锁 body 滚动、不做 focus trap，
   * 抽屉以外的页面照常可见可点——用于必须同时看背景内容的场景。
   */
  modal?: boolean;
  /**
   * 小屏（<lg）改为底部抽屉（默认 false）。手机上右侧抽屉几乎占满整屏，
   * 需要同时看上方画面的场景（播放页标记）只有底部半屏才成立。
   */
  mobileSheet?: boolean;
  /**
   * 小屏（<lg）改为近全屏底部面板（默认 false）。用于内容较多的抽屉（如设置），
   * 手机上半屏高度明显不够用；保留顶部一条露出遮罩，便于点空白处关闭。
   */
  mobileFull?: boolean;
}) {
  const [mounted, setMounted] = useState(open);
  const [entered, setEntered] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // 切换面板时滚回顶部：新面板不应继承上一个面板的滚动位置
  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [resetScrollKey]);

  // 进入：先挂载（保持 slide-out 初态）再于下一帧切换为进入态，触发过渡
  // 退出：先回到初态，过渡结束后卸载并归还焦点
  useEffect(() => {
    if (open) {
      // 非模态不抢焦点，焦点留在原处（播放页要保留播放器的快捷键控制）
      if (modal) restoreFocusRef.current = document.activeElement as HTMLElement | null;
      setMounted(true);
      const raf = requestAnimationFrame(() => requestAnimationFrame(() => setEntered(true)));
      return () => cancelAnimationFrame(raf);
    }
    setEntered(false);
    const timer = setTimeout(() => {
      setMounted(false);
      restoreFocusRef.current?.focus?.();
      restoreFocusRef.current = null;
    }, EXIT_MS);
    return () => clearTimeout(timer);
  }, [open, modal]);

  // 打开期间锁定背景滚动（移动端可避免滚动穿透）；非模态不锁，页面照常可用
  useEffect(() => {
    if (!mounted || !modal) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mounted, modal]);

  // 打开后把焦点移入抽屉，保证键盘用户不从背景页开始
  useEffect(() => {
    if (!mounted || !modal) return;
    const panel = panelRef.current;
    if (!panel) return;
    const first = panel.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel).focus();
  }, [mounted, modal]);

  // Esc 关闭 + Tab 循环（焦点不逃逸到背景页面）
  useEffect(() => {
    if (!mounted) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 抽屉内若有确认弹窗等上层对话框（role=alertdialog），Esc 交给它处理，避免一并关闭抽屉
        if (document.querySelector('[role="alertdialog"]')) return;
        // 非模态不抢 Esc：焦点不在抽屉里时（如正在全屏看片）留给播放器退出全屏
        if (!modal && !panelRef.current?.contains(document.activeElement)) return;
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !modal) return;
      const panel = panelRef.current;
      if (!panel) return;
      const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.getClientRects().length > 0 || el === document.activeElement
      );
      if (nodes.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !panel.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !panel.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [mounted, onClose, modal]);

  // —— 近全屏形态（mobileFull）的把手拖拽关闭 ——
  // 把手不是一个"看着能拖其实没用"的装饰条：按住它下滑，面板跟手移动，
  // 超过阈值松手即关闭，未达阈值回弹。拖动期间临时关掉 class 里的 200ms 过渡，
  // 否则跟手会被过渡拖成橡皮筋；松手后恢复过渡再交给 class 驱动退出动画。
  const dragState = useRef<{ id: number; startY: number; dy: number } | null>(null);
  const beginDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    dragState.current = { id: e.pointerId, startY: e.clientY, dy: 0 };
    if (panelRef.current) panelRef.current.style.transition = 'none';
    // 指针可能在这一瞬已经消失（pointercancel 先到），setPointerCapture 会抛错；
    // 抓不住不影响主流程（move/up 仍会到达元素），不能让它冒成未捕获异常。
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      /* 忽略：降级为不捕获 */
    }
  };
  const moveDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragState.current;
    const panel = panelRef.current;
    if (!drag || !panel || e.pointerId !== drag.id) return;
    drag.dy = Math.max(0, e.clientY - drag.startY);
    panel.style.transform = `translateY(${drag.dy}px)`;
  };
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragState.current;
    const panel = panelRef.current;
    dragState.current = null;
    if (!drag || !panel) return;
    panel.style.transition = '';
    // 松手即回弹：pointercancel（系统抢走手势）也按取消处理
    if (e.type === 'pointercancel' || drag.dy <= DRAG_CLOSE_PX) {
      panel.style.transform = '';
      return;
    }
    // 先按把手位置滑出屏幕，动画结束后清掉内联 transform 并走正常关闭流程
    panel.style.transform = 'translateY(100%)';
    window.setTimeout(() => {
      if (panelRef.current) panelRef.current.style.transform = '';
      onClose();
    }, EXIT_MS);
  };

  if (!mounted) return null;

  return (
    // 非模态时容器只用于定位：pointer-events-none 让抽屉以外的点击穿透到页面
    <div className={cn('fixed inset-0 z-50', !modal && 'pointer-events-none')}>
      {modal && (
        <div
          className={cn(
            'absolute inset-0 bg-black/60 transition-opacity duration-200',
            entered ? 'opacity-100' : 'opacity-0'
          )}
          onClick={closeOnOverlay ? onClose : undefined}
          aria-hidden
        />
      )}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal={modal || undefined}
        aria-label={title}
        tabIndex={-1}
        className={cn(
          'absolute right-0 top-0 h-full w-full bg-surface-raised border-l border-line flex flex-col outline-none',
          'transition-transform duration-200 ease-out',
          width,
          !modal && 'pointer-events-auto shadow-2xl',
          // 小屏底部抽屉：占下半屏、贴底、顶部圆角，留出上半屏给画面
          mobileSheet &&
            'max-lg:inset-x-0 max-lg:top-auto max-lg:bottom-0 max-lg:h-auto max-lg:max-h-[60vh] max-lg:max-w-none max-lg:rounded-t-xl max-lg:border-t max-lg:border-l-0 max-lg:pb-[env(safe-area-inset-bottom)]',
          // 近全屏底部面板：单列设置项在手机上需要完整高度可用
          mobileFull &&
            'max-lg:inset-x-0 max-lg:top-auto max-lg:bottom-0 max-lg:h-[92dvh] max-lg:max-h-[92dvh] max-lg:max-w-none max-lg:rounded-t-xl max-lg:border-t max-lg:border-l-0 max-lg:pb-[env(safe-area-inset-bottom)]',
          entered
            ? 'translate-x-0 max-lg:translate-y-0'
            : cn('translate-x-full', (mobileSheet || mobileFull) && 'max-lg:translate-x-0 max-lg:translate-y-full')
        )}
        style={panelStyle}
      >
        {mobileFull && (
          /* 顶部把手：按住下滑可关闭面板（阈值见 DRAG_CLOSE_PX），仅近全屏移动形态出现。
             touch-none 让浏览器把这段手势交给我们而不是拿去滚动页面。 */
          <div
            className="hidden max-lg:flex shrink-0 justify-center pt-2 pb-0.5 touch-none select-none cursor-grab active:cursor-grabbing"
            aria-hidden
            onPointerDown={beginDrag}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <span className="h-1 w-10 rounded-full bg-line" />
          </div>
        )}
        <div className="shrink-0 px-4 py-2.5 border-b border-line flex items-center justify-between">
          <h2 className="font-semibold text-content">{title}</h2>
          <button
            className="p-1.5 rounded-md text-muted hover:text-content hover:bg-hover transition-colors"
            onClick={onClose}
            aria-label="关闭"
          >
            <Icon name="close" />
          </button>
        </div>
        {subheader && <div className="shrink-0 px-4 py-2.5 border-b border-line bg-surface-raised">{subheader}</div>}
        {/* 唯一滚动区：内容再长也只在这一层滚动，避免与列表内滚形成嵌套滚动 */}
        <div
          ref={contentRef}
          className="flex-1 min-h-0 overflow-y-auto overscroll-contain scrollbar-thin px-4 pt-4 pb-6 max-lg:pt-3 max-lg:pb-3"
        >
          {children}
        </div>
        {footer && <div className="shrink-0 border-t border-line bg-surface-raised px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}
