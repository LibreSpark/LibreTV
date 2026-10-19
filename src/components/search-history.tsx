'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { addSearchHistory, clearSearchHistory, db, removeSearchHistory, restoreSearchHistory } from '@/lib/db';
import { cn } from '@/lib/utils';
import { useToast } from './toast';
import { Icon } from './icon';
import { useT } from '@/lib/i18n';

/** 下拉最多展示条数，与 db 层 MAX_SEARCH_HISTORY 保持一致 */
const HISTORY_LIMIT = 10;

/**
 * 「最近搜索」下拉的交互逻辑：聚焦展开、输入时按关键字过滤（浏览器地址栏式交互）。
 * 首页搜索框与顶栏搜索框共用本 hook 与下方 SearchHistoryDropdown，避免两处实现分叉。
 */
export function useSearchHistory(input: string) {
  const t = useT();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  /** 键盘高亮项下标，-1 表示未选中 */
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);

  const history = useQuery({
    queryKey: ['searchHistory'],
    queryFn: () => db.searchHistory.orderBy('timestamp').reverse().limit(HISTORY_LIMIT).toArray(),
  });

  const matches = useMemo(() => {
    const all = history.data ?? [];
    const keyword = input.trim().toLowerCase();
    return keyword ? all.filter((h) => h.text.toLowerCase().includes(keyword)) : all;
  }, [history.data, input]);

  // 唯一命中项与输入内容完全一致时不展开：否则会盖住用户刚敲进去的内容
  const visible = open && matches.length > 0 && !(matches.length === 1 && matches[0].text === input.trim());

  // 点按下拉之外的任意位置收起
  useEffect(() => {
    if (!visible) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [visible]);

  const close = () => {
    setOpen(false);
    setActiveIndex(-1);
  };

  /** 记录一次搜索；顺带刷新下拉数据（历史也会在播放页被写入） */
  const record = (text: string) => {
    addSearchHistory(text)
      .then(() => history.refetch())
      .catch(() => {});
  };

  const remove = (text: string) => {
    setActiveIndex(-1);
    removeSearchHistory(text).then(() => history.refetch());
  };

  const clearAll = async () => {
    const snapshot = history.data ?? [];
    if (snapshot.length === 0) return;
    close();
    await clearSearchHistory();
    await history.refetch();
    // 轻量破坏性操作：给一次撤销机会，不打断式弹确认
    toast(t('已清空搜索记录'), 'info', {
      action: {
        label: t('撤销'),
        onClick: () => {
          restoreSearchHistory(snapshot).then(() => history.refetch());
        },
      },
    });
  };

  const onFocus = () => {
    setOpen(true);
    history.refetch();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>, onPick: (text: string) => void) => {
    if (e.key === 'Escape') {
      close();
      return;
    }
    if (!visible) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % matches.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i <= 0 ? matches.length - 1 : i - 1));
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      // 有高亮项时 Enter 采用该条历史，不再提交输入框原文
      e.preventDefault();
      onPick(matches[activeIndex].text);
    }
  };

  return {
    visible,
    matches,
    activeIndex,
    containerRef,
    close,
    record,
    remove,
    clearAll,
    onFocus,
    onKeyDown,
    /** 输入变化时清掉键盘高亮，避免指向已过滤掉的项 */
    resetActive: () => setActiveIndex(-1),
  };
}

/**
 * 最近搜索浮层：紧贴输入框下方，与输入框「拼成同一个面板」。
 * - 不留间隙、不画上边框、上角为直角：上圆角与上边框由输入框容器补齐，
 *   因此接缝处既不会出现缝隙，也不会出现双线；
 * - 外框取 accent 色，与输入框的聚焦边框同色，避免拼接处「上半蓝、下半灰」断色；
 * - 左右内边距与输入框文字（pl-4）对齐，使下拉文字与输入内容在同一条竖线上；
 * - 作为浮层不占文档流，出现/消失不会引起下方内容跳动。
 */
export function SearchHistoryDropdown({
  id,
  matches,
  activeIndex,
  onPick,
  onRemove,
  onClearAll,
}: {
  /** 同时作为 listbox 的 id 前缀：外部输入框用 aria-controls 指向它 */
  id: string;
  matches: { text: string }[];
  activeIndex: number;
  onPick: (text: string) => void;
  onRemove: (text: string) => void;
  onClearAll: () => void;
}) {
  const t = useT();
  return (
    <div
      className={cn(
        'absolute left-0 right-0 top-full z-40 overflow-hidden text-left',
        'rounded-b-xl border-x border-b border-accent bg-surface-raised shadow-2xl animate-fade-in'
      )}
    >
      <div className="flex items-center justify-between pl-4 pr-2 py-2 border-b border-line">
        <span className="flex items-center gap-1.5 text-xs text-faint">
          <Icon name="clock" className="w-3.5 h-3.5" />
          {t('最近搜索')}
        </span>
        <button
          type="button"
          className="px-2 py-1 rounded-md text-xs text-faint hover:text-danger hover:bg-hover transition-colors"
          onClick={onClearAll}
        >
          {t('清空')}
        </button>
      </div>
      <ul
        id={id}
        role="listbox"
        aria-label={t('最近搜索')}
        className="max-h-[min(70vh,400px)] overflow-y-auto scrollbar-thin py-1"
      >
        {matches.map((h, i) => (
          <li
            key={h.text}
            id={`${id}-${i}`}
            role="option"
            aria-selected={i === activeIndex}
            className={cn('flex items-center hover:bg-hover', i === activeIndex && 'bg-hover')}
          >
            <button
              type="button"
              className="flex-1 min-w-0 pl-4 pr-2 py-2.5 text-left text-sm text-content truncate"
              onClick={() => onPick(h.text)}
            >
              {h.text}
            </button>
            <button
              type="button"
              className="shrink-0 p-1.5 mr-2 rounded-md text-faint hover:text-danger hover:bg-chip transition-colors"
              aria-label={t('删除搜索记录 {text}', { text: h.text })}
              onClick={() => onRemove(h.text)}
            >
              <Icon name="close" className="w-3.5 h-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
