'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';
import { Icon } from './icon';

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

  const selected = options.find((o) => o.value === value);

  // 展开期间监听外部点击收起
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

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
      {open && (
        <ul
          role="listbox"
          aria-label={ariaLabel}
          className={cn(
            'absolute right-0 top-full z-50 mt-1.5 min-w-full w-max max-h-60 overflow-y-auto py-1',
            // 窄屏限制宽度：按内容宽度 + nowrap 会把面板撑出手机视口
            'max-w-[calc(100vw-2rem)]',
            'rounded-xl border border-line bg-surface-raised shadow-xl animate-fade-in'
          )}
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
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors',
                    i === active && 'bg-hover'
                  )}
                >
                  <span className="min-w-0">
                    <span
                      className={cn(
                        'block whitespace-nowrap truncate text-xs',
                        isSelected ? 'text-accent font-medium' : 'text-content'
                      )}
                    >
                      {o.label}
                    </span>
                    {o.hint && (
                      <span className="block truncate whitespace-nowrap text-[11px] text-faint">{o.hint}</span>
                    )}
                  </span>
                  {isSelected && <Icon name="check" className="ml-auto w-3.5 h-3.5 shrink-0 text-accent" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
