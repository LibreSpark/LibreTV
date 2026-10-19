'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Icon } from './icon';
import { useT } from '@/lib/i18n';

/**
 * 通用右侧抽屉骨架：
 * - 布局为 flex 纵向三段（标题栏 / 可选副标题栏 / 内容区），只有内容区滚动，
 *   调用方无需再用 sticky + 魔法数字偏移去贴标题栏；
 * - 打开时锁定 body 滚动，关闭后归还焦点，Tab 键在抽屉内循环（focus trap）；
 * - 带进入/退出过渡（水平滑入 + 遮罩淡入），退出动画结束后才卸载内容。
 */

/** 退出过渡时长，需与下方 duration-200 保持一致 */
const EXIT_MS = 200;

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
  closeOnOverlay = true,
  resetScrollKey,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** 抽屉最大宽度类（如 max-w-lg） */
  width?: string;
  /** 固定在标题栏下方的非滚动区（如 Tab 条），随抽屉一起保持可见 */
  subheader?: ReactNode;
  /** 点击遮罩是否关闭（默认 true） */
  closeOnOverlay?: boolean;
  /** 该值变化时内容区滚回顶部（如切换设置分组 / 面板） */
  resetScrollKey?: string;
}) {
  const t = useT();
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
      restoreFocusRef.current = document.activeElement as HTMLElement | null;
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
  }, [open]);

  // 打开期间锁定背景滚动（移动端可避免滚动穿透）
  useEffect(() => {
    if (!mounted) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mounted]);

  // 打开后把焦点移入抽屉，保证键盘用户不从背景页开始
  useEffect(() => {
    if (!mounted) return;
    const panel = panelRef.current;
    if (!panel) return;
    const first = panel.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel).focus();
  }, [mounted]);

  // Esc 关闭 + Tab 循环（焦点不逃逸到背景页面）
  useEffect(() => {
    if (!mounted) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 抽屉内若有确认弹窗等上层对话框（role=alertdialog），Esc 交给它处理，避免一并关闭抽屉
        if (document.querySelector('[role="alertdialog"]')) return;
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
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
  }, [mounted, onClose]);

  if (!mounted) return null;

  return (
    <div className="fixed inset-0 z-50">
      <div
        className={cn(
          'absolute inset-0 bg-black/60 transition-opacity duration-200',
          entered ? 'opacity-100' : 'opacity-0'
        )}
        onClick={closeOnOverlay ? onClose : undefined}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cn(
          'absolute right-0 top-0 h-full w-full bg-surface-raised border-l border-line flex flex-col outline-none',
          'transition-transform duration-200 ease-out',
          width,
          entered ? 'translate-x-0' : 'translate-x-full'
        )}
      >
        <div className="shrink-0 px-4 py-2.5 border-b border-line flex items-center justify-between">
          <h2 className="font-semibold text-content">{title}</h2>
          <button
            className="p-1.5 rounded-md text-muted hover:text-content hover:bg-hover transition-colors"
            onClick={onClose}
            aria-label={t('关闭')}
          >
            <Icon name="close" />
          </button>
        </div>
        {subheader && <div className="shrink-0 px-4 py-2.5 border-b border-line bg-surface-raised">{subheader}</div>}
        {/* 唯一滚动区：内容再长也只在这一层滚动，避免与列表内滚形成嵌套滚动 */}
        <div ref={contentRef} className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-4 pt-4 pb-6">
          {children}
        </div>
      </div>
    </div>
  );
}
