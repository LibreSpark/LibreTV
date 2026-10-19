'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useT } from '@/lib/i18n';

/**
 * 破坏性操作确认弹窗（分级确认中的「重操作」）：
 * 删除整个订阅、导入配置覆盖全部数据、清空观看历史等不可逆或影响面大的操作，
 * 先弹出确认并说明影响面；轻操作（删单个源/单条历史）改用 Toast 撤销（Undo）。
 */

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 危险操作：确认按钮用红色，且默认焦点落在取消上，避免误回车 */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    // 危险操作默认聚焦「取消」，回车不会误触破坏性动作
    (danger ? cancelRef : confirmRef).current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      } else if (e.key === 'Enter' && !danger) {
        e.preventDefault();
        onConfirm();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, danger, onCancel, onConfirm]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 animate-fade-in" onClick={onCancel} aria-hidden />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        className="relative bg-surface-raised rounded-xl w-full max-w-sm shadow-2xl p-5 animate-slide-up"
      >
        <h2 className="text-base font-semibold text-content mb-2">{title}</h2>
        {message && <div className="text-sm text-muted leading-relaxed">{message}</div>}
        <div className="flex gap-2 justify-end mt-5">
          <button ref={cancelRef} className="btn-ghost text-sm" onClick={onCancel}>
            {cancelLabel ?? t('取消')}
          </button>
          <button
            ref={confirmRef}
            className={cn(
              'btn text-sm text-white',
              danger ? 'bg-danger hover:bg-danger-hover' : 'bg-accent hover:bg-accent-hover'
            )}
            onClick={onConfirm}
          >
            {confirmLabel ?? t('确认')}
          </button>
        </div>
      </div>
    </div>
  );
}
