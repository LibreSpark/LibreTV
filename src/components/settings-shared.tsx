'use client';

import { useCallback, useState, type ReactNode } from 'react';
import { cn, formatDisableTtl } from '@/lib/utils';
import { isInDisabledSubscription, useAppStore } from '@/lib/store';
import { useToast } from './toast';
import { Icon } from './icon';
import { Dropdown, type DropdownOption } from './dropdown';
import { Spinner } from './states';
import { tr, useT } from '@/lib/i18n';

/**
 * 设置面板共享件：把此前点播源 / 直播源各自「抄一遍」的标题、开关、
 * 下拉、空态、搜索框、探活徽章与健康度统一到一处，保证两类源面板风格与行为一致。
 */

/** 探活结果（点播 / 直播共用同一结构） */
export type TestState =
  | { status: 'loading' }
  | { status: 'done'; ok: boolean; ms?: number; count?: number; error?: string };

/** 探活结果状态管理：替代两条源列表各自维护一份 tests 的实现 */
export function useSourceTests() {
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const runTest = useCallback(
    async (
      key: string,
      run: () => Promise<{ ok: boolean; ms?: number; count?: number; error?: string }>
    ) => {
      setTests((prev) => ({ ...prev, [key]: { status: 'loading' } }));
      try {
        const r = await run();
        setTests((prev) => ({
          ...prev,
          [key]: r.ok
            ? { status: 'done', ok: true, ms: r.ms, count: r.count }
            : { status: 'done', ok: false, error: r.error },
        }));
      } catch (err) {
        setTests((prev) => ({
          ...prev,
          [key]: { status: 'done', ok: false, error: err instanceof Error ? err.message : tr('测试失败') },
        }));
      }
    },
    []
  );
  return { tests, runTest };
}

export function SectionTitle({ title, hint, extra }: { title: string; hint?: string; extra?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 mb-2.5">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-content">{title}</h3>
        {hint && <p className="text-[11px] text-faint truncate">{hint}</p>}
      </div>
      {extra}
    </div>
  );
}

export function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-0.5">
      <div className="min-w-0">
        <div className="text-sm text-content">{label}</div>
        <div className="text-xs text-faint">{description}</div>
      </div>
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

/** 开关本体：设置项与列表行（如订阅启停）共用，保证尺寸与动效一致 */
export function Switch({
  checked,
  onChange,
  label,
  title,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  title?: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title ?? label}
      className={cn(
        'relative h-[22px] w-10 shrink-0 rounded-full transition-colors duration-200',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        checked ? 'bg-accent' : 'bg-chip ring-1 ring-inset ring-line'
      )}
      onClick={() => onChange(!checked)}
    >
      <span
        className={cn(
          'absolute left-[2px] top-[2px] h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-transform duration-200 ease-out',
          checked ? 'translate-x-[18px]' : 'translate-x-0'
        )}
      />
    </button>
  );
}

/**
 * 设置行下拉：自定义样式的下拉组件（见 Dropdown），替代原生 <select>——
 * 原生展开面板由操作系统渲染，与站点风格割裂且暗色模式下突兀；
 * 选中的详细说明由调用方经 description 随选项动态展示（对齐 ToggleRow 的布局）。
 */
export function SelectRow({
  label,
  value,
  onChange,
  options,
  description,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: DropdownOption[];
  /** 当前选中项的说明文案，随选中项变化 */
  description?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-0.5">
      <div className="min-w-0">
        <div className="text-sm text-content">{label}</div>
        {description && <div className="text-xs text-faint">{description}</div>}
      </div>
      <Dropdown
        value={value}
        onChange={onChange}
        options={options}
        ariaLabel={label}
        className="shrink-0 [&>button]:!py-1.5 [&>button]:!pl-2.5 [&>button]:!pr-2 [&>button]:text-xs"
      />
    </div>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const t = useT();
  return (
    <div className="relative">
      <Icon
        name="search"
        className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-faint pointer-events-none"
      />
      <input
        className="input w-full !pl-8 !py-1.5 text-xs"
        aria-label={placeholder ?? t('搜索')}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}

/** 单源探活徽章 + 触发按钮（点播 / 直播共用；`badgeWhenOk` 决定成功文案） */
export function TestBadge({
  state,
  onTest,
  title,
  badgeWhenOk,
}: {
  state?: TestState;
  onTest: () => void;
  title: string;
  badgeWhenOk: (t: { ms?: number; count?: number }) => string;
}) {
  const t = useT();
  return (
    <span className="flex items-center gap-1 shrink-0">
      {state?.status === 'done' && (
        <span
          className={cn(
            'text-[10px] px-1.5 py-0.5 rounded',
            state.ok ? 'bg-success/15 text-success' : 'bg-danger/15 text-danger'
          )}
          title={state.ok ? `${state.ms}ms` : state.error}
        >
          {state.ok ? badgeWhenOk({ ms: state.ms, count: state.count }) : `✗ ${state.error?.slice(0, 12) || t('失败')}`}
        </span>
      )}
      <button
        className={cn(
          'rounded-md p-2 transition-colors disabled:opacity-40',
          state?.status === 'done' && !state.ok ? 'text-danger' : 'text-muted hover:text-accent hover:bg-hover'
        )}
        disabled={state?.status === 'loading'}
        onClick={onTest}
        aria-label={title}
        title={title}
      >
        {state?.status === 'loading' ? <Spinner size="sm" /> : <Icon name="bolt" className="w-4 h-4" />}
      </button>
    </span>
  );
}

/** 点播源搜索健康度徽章（随搜索/批量测活滚动更新）；被自动停用的源提供手动恢复入口 */
export function HealthBadge({ sourceKey }: { sourceKey: string }) {
  const entry = useAppStore((s) => s.sourceHealth[sourceKey]);
  const inDisabledSub = useAppStore((s) => isInDisabledSubscription(s, sourceKey));
  const { toast } = useToast();
  const t = useT();

  // 订阅被整体关闭时优先说明原因：否则源看起来「勾选正常却搜不到」，用户会以为是源坏了
  if (inDisabledSub) {
    return (
      <span
        className="text-[10px] px-1.5 py-0.5 rounded bg-warning/15 text-warning shrink-0"
        title={t('所属订阅已被停用，该源暂不参与搜索；到「数据源订阅」重新启用即可')}
      >
        {t('订阅已停用')}
      </span>
    );
  }

  if (!entry) return null;

  const permanent = entry.permanent === true;
  const disabled = permanent || (!!entry.disabledUntil && entry.disabledUntil > Date.now());
  if (disabled) {
    // 长期停用（阶梯用尽）没有到期时间，展示为红色并提示需手动恢复
    const remainText = formatDisableTtl((entry.disabledUntil ?? 0) - Date.now());
    return (
      <span className="flex items-center gap-1 shrink-0">
        <span
          className={cn(
            'inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded',
            permanent ? 'bg-danger/15 text-danger' : 'bg-warning/15 text-warning'
          )}
          title={
            permanent
              ? t('已第 {n} 次被自动停用，暂停参与搜索；点「恢复」重新启用', { n: entry.disableCount })
              : t('连续 {n} 次超时/失败，{time}后自动恢复', { n: entry.failStreak, time: remainText })
          }
        >
          <Icon name="clock" className="w-3 h-3" />
          {permanent ? t('已停用') : remainText}
        </span>
        <button
          className="text-[10px] px-1.5 py-0.5 rounded text-muted hover:text-accent hover:bg-hover transition-colors"
          aria-label={t('恢复此源')}
          title={t('清除健康度记录，立即恢复参与搜索')}
          onClick={() => {
            useAppStore.getState().clearSourceHealth(sourceKey);
            toast(t('已恢复，下次搜索重新参与'), 'success');
          }}
        >
          {t('恢复')}
        </button>
      </span>
    );
  }

  if (entry.ok) {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-success/15 text-success shrink-0" title={t('上次搜索 {ms}ms', { ms: entry.ms })}>
        ✓ {entry.ms}ms
      </span>
    );
  }
  return (
    <span
      className={cn(
        'text-[10px] px-1.5 py-0.5 rounded shrink-0',
        entry.timedOut ? 'bg-warning/15 text-warning' : 'bg-danger/15 text-danger'
      )}
      title={entry.error}
    >
      {t('连续 {n} 次失败', { n: entry.failStreak })}
    </span>
  );
}
