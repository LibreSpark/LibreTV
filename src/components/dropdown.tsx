'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { Icon } from './icon';
import { LiquidGlassSurface } from '@/components/ui/liquid-glass';

export interface DropdownOption {
  value: string;
  label: string;
  /** 选项面板内的次要说明（弱色小字，第二行），便于对比着选 */
  hint?: string;
}

/**
 * 自定义下拉：替代原生 <select>——原生展开面板由操作系统渲染，
 * 与站点风格割裂、暗色模式下尤其突兀。面板为浮层卡片（surface-raised + 阴影 +
 * fade-in），选中项带勾号；支持点击外部 / Esc 关闭与 ↑ ↓ Enter 键盘导航。
 * 焦点始终留在触发按钮上（不做选项级焦点管理），键盘高亮用 active 下标模拟。
 */
export function Dropdown({
  value,
  onChange,
  options,
  ariaLabel,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  options: DropdownOption[];
  ariaLabel: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  /** 键盘 / 悬停高亮项下标；-1 表示无高亮 */
  const [active, setActive] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const [menuStyle, setMenuStyle] = useState<{ top: number; left: number; minWidth: number; maxWidth: number; maxHeight: number } | null>(null);

  const selected = options.find((o) => o.value === value);

  // 菜单通过 portal 脱离设置抽屉的滚动容器，避免被 overflow-y-auto 裁切。
  // 根据触发按钮位置自动向上/向下展开，并限制在当前可视窗口内。
  useEffect(() => {
    if (!open) {
      setMenuStyle(null);
      return;
    }
    const updatePosition = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = document.documentElement.clientHeight;
      const maxWidth = Math.max(120, viewportWidth - 24);
      const minWidth = Math.min(rect.width, maxWidth);
      const estimatedHeight = Math.min(240, Math.max(44, options.length * 36 + 8));
      const below = viewportHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const placeAbove = below < Math.min(estimatedHeight, 160) && above > below;
      const available = Math.max(96, (placeAbove ? above : below) - 8);
      const top = placeAbove
        ? Math.max(12, rect.top - Math.min(estimatedHeight, available))
        : Math.min(viewportHeight - 12, rect.bottom + 6);
      const left = Math.max(12, Math.min(rect.right - Math.max(minWidth, 180), viewportWidth - Math.min(maxWidth, Math.max(minWidth, 180)) - 12));
      setMenuStyle({ top, left, minWidth, maxWidth, maxHeight: Math.min(240, available) });
    };
    const frame = requestAnimationFrame(updatePosition);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open, options.length]);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    setActive(options.findIndex((o) => o.value === value));
    setOpen(true);
  };

  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!open) {
      // 收起时 Enter / Space / 方向键均可展开（原生 select 的习惯行为）
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        toggle();
      }
      return;
    }
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        setOpen(false);
        break;
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        setActive((i) => (Math.max(i, 0) + dir + options.length) % options.length);
        break;
      }
      case 'Enter': {
        e.preventDefault();
        const opt = options[active];
        if (opt) pick(opt.value);
        break;
      }
    }
  };

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={toggle}
        onKeyDown={onKeyDown}
        className={cn(
          'input flex items-center justify-between gap-1.5 cursor-pointer text-left',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:border-accent',
          open && 'border-accent'
        )}
      >
        <span className="truncate">{selected?.label ?? value}</span>
        <Icon
          name="chevronDown"
          className={cn(
            'w-3.5 h-3.5 shrink-0 text-faint transition-transform duration-200',
            open && 'rotate-180 text-accent'
          )}
        />
      </button>
      {open && menuStyle && typeof document !== 'undefined' && createPortal(
        <LiquidGlassSurface
          as="div"
          variant="panel"
          className="fixed z-[100100] overflow-y-auto overscroll-contain rounded-xl border border-line shadow-2xl animate-fade-in"
          style={{ top: menuStyle.top, left: menuStyle.left, minWidth: menuStyle.minWidth, maxWidth: menuStyle.maxWidth, maxHeight: menuStyle.maxHeight }}
        >
        <ul
          ref={menuRef}
          role="listbox"
          aria-label={ariaLabel}
          className="py-1"
        >
          {options.map((o, i) => {
            const isSelected = o.value === value;
            return (
              <li key={o.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(o.value)}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-2 text-left transition-colors',
                    i === active && 'bg-hover'
                  )}
                >
                  <span className="min-w-0">
                    <span className={cn('block whitespace-nowrap text-xs', isSelected ? 'text-accent font-medium' : 'text-content')}>
                      {o.label}
                    </span>
                    {o.hint && <span className="block whitespace-nowrap text-[11px] text-faint">{o.hint}</span>}
                  </span>
                  {isSelected && <Icon name="check" className="ml-auto w-3.5 h-3.5 shrink-0 text-accent" />}
                </button>
              </li>
            );
          })}
        </ul>
        </LiquidGlassSurface>,
        document.body
      )}
    </div>
  );
}
