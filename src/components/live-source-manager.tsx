'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '@/lib/store';
import { useToast } from './toast';
import { api } from '@/lib/client-api';
import { formatRelativeTime, hostnameOf, validateSourceUrl, cn } from '@/lib/utils';
import { SearchInput, SectionTitle, TestBadge, useSourceTests } from './settings-shared';
import { EmptyState } from './states';
import { Icon } from './icon';
import { useT } from '@/lib/i18n';

/**
 * 直播源管理（嵌入设置抽屉）：M3U 订阅的添加 / 探活 / 移除 / 导出，
 * 以及部署者预置源展示。工具条、徽章、空态与撤销语义与点播源面板保持一致。
 */

type LiveFilter = 'all' | 'enabled' | 'disabled' | 'sub' | 'manual';

// 与点播源面板保持同一组筛选项与顺序：先状态（已启用 / 已停用），后来源（来自订阅 / 手动添加）
const LIVE_FILTERS: { id: LiveFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'enabled', label: '已启用' },
  { id: 'disabled', label: '已停用' },
  { id: 'sub', label: '来自订阅' },
  { id: 'manual', label: '手动添加' },
];

interface LiveRow {
  url: string;
  label: string;
  epgUrl?: string;
  preset: boolean;
  lastSync?: number;
  fromSubscriptions: string[];
}

export function LiveSourceManager() {
  const store = useAppStore();
  const { toast } = useToast();
  const t = useT();
  const [adding, setAdding] = useState(false);
  /** 正在编辑的手动源 URL（与「添加」共用同一表单） */
  const [editing, setEditing] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<LiveFilter>('all');
  const { tests, runTest } = useSourceTests();

  const rows = useMemo<LiveRow[]>(() => {
    const preset: LiveRow[] = store.liveEnvSources.map((s) => ({
      url: s.url,
      label: s.name || hostnameOf(s.url),
      epgUrl: s.epg,
      preset: true,
      fromSubscriptions: [],
    }));
    const subs: LiveRow[] = store.liveSubscriptions.map((s) => ({
      url: s.url,
      label: s.name || hostnameOf(s.url),
      epgUrl: s.epg,
      preset: false,
      lastSync: s.lastSync,
      fromSubscriptions: s.fromSubscriptions,
    }));
    const all = [...preset, ...subs];
    const q = query.trim().toLowerCase();
    return all.filter((r) => {
      if (filter === 'enabled' && !store.liveSelectedUrls.includes(r.url)) return false;
      if (filter === 'disabled' && store.liveSelectedUrls.includes(r.url)) return false;
      if (filter === 'sub' && r.fromSubscriptions.length === 0) return false;
      if (filter === 'manual' && !(r.fromSubscriptions.length === 0 && !r.preset)) return false;
      if (!q) return true;
      return r.label.toLowerCase().includes(q) || r.url.toLowerCase().includes(q);
    });
  }, [store.liveEnvSources, store.liveSubscriptions, store.liveSelectedUrls, query, filter]);

  // 编辑中的手动源（与「添加」共用同一表单）
  const editingSource = editing ? store.liveSubscriptions.find((s) => s.url === editing) : undefined;

  const exportM3u = (url: string) => {
    window.open(api.liveExportUrl(url), '_blank', 'noopener');
  };

  const allEnabled = rows.length > 0 && rows.every((r) => store.liveSelectedUrls.includes(r.url));
  const toggleAll = () => {
    // 只翻转状态与目标不一致的源，一次批量 set 完成（逐条 toggle 会触发 O(n) 次持久化）
    const targets = rows
      .filter((r) => store.liveSelectedUrls.includes(r.url) === allEnabled)
      .map((r) => r.url);
    if (targets.length > 0) useAppStore.getState().toggleLiveSelectedMany(targets);
  };

  const removeWithUndo = (row: LiveRow) => {
    const snapshot = useAppStore.getState().removeLiveSubscription(row.url);
    if (!snapshot) return;
    // 正在编辑的条目被移除时收起表单，避免表单悬空
    if (editing === row.url) setEditing(null);
    toast(t('已移除「{name}」', { name: row.label }), 'info', {
      action: {
        label: t('撤销'),
        onClick: () => {
          useAppStore.getState().restoreLiveSubscription(snapshot);
          toast(t('已恢复'), 'success');
        },
      },
    });
  };

  const empty = store.liveEnvSources.length === 0 && store.liveSubscriptions.length === 0;

  return (
    <section>
      <SectionTitle
        title={t('直播源')}
        hint={
          empty
            ? t('M3U 订阅 · /live 页面播放')
            : t('共 {n} 个 · 已启用 {on}', {
                n: store.liveEnvSources.length + store.liveSubscriptions.length,
                on: store.liveSelectedUrls.length,
              })
        }
        extra={
          <button className="btn-primary btn-sm" onClick={() => setAdding(true)}>
            <Icon name="plus" className="w-3.5 h-3.5" />
            {t('添加直播源')}
          </button>
        }
      />

      {/* 与点播源一致：由「+ 添加 / 编辑」按钮展开同一表单，而非常驻占位 */}
      <LiveSourceForm
        visible={adding || editingSource !== undefined}
        initial={editingSource}
        onCancel={() => {
          setAdding(false);
          setEditing(null);
        }}
        onSubmit={(data) => {
          if (editing) {
            // 编辑模式：只更新名称与 EPG（地址不可改）
            store.updateLiveSubscription(editing, { name: data.name, epg: data.epg });
          } else {
            store.addLiveSubscription(data.url, data.name, data.epg);
            void runTest(data.url, () => api.liveTest(data.url));
          }
          setAdding(false);
          setEditing(null);
        }}
      />

      {empty && !adding && editingSource === undefined ? (
        <EmptyState
          icon="link"
          title={t('还没有添加任何直播源')}
          description={t(
            '添加 M3U 地址后即可在「直播」页按分组浏览与播放频道；也可在「数据源订阅」中一次导入点播源与直播源；部署者还可通过 DEFAULT_LIVE_SOURCES 环境变量预置。'
          )}
          action={
            <button className="btn-primary btn-sm" onClick={() => setAdding(true)}>
              {t('添加第一个直播源')}
            </button>
          }
        />
      ) : (
        <>
          <div className="space-y-2 mb-3">
            <SearchInput value={query} onChange={setQuery} placeholder={t('搜索名称或地址')} />
            <div className="flex flex-wrap items-center gap-1">
              {LIVE_FILTERS.map((f) => (
                <button
                  key={f.id}
                  className={cn(
                    'chip',
                    filter === f.id ? 'bg-accent/10 text-accent font-medium' : 'text-muted hover:text-content hover:bg-hover'
                  )}
                  onClick={() => setFilter(f.id)}
                  aria-pressed={filter === f.id}
                >
                  {t(f.label)}
                </button>
              ))}
              <span className="ml-auto text-[11px] text-faint">{t('显示 {n} 个', { n: rows.length })}</span>
            </div>
            <button className="btn-ghost btn-sm" onClick={toggleAll} disabled={rows.length === 0}>
              {allEnabled ? t('全部停用') : t('全部启用')}
            </button>
          </div>

          {rows.length === 0 ? (
            <EmptyState variant="plain" title={t('没有符合条件的源')} />
          ) : (
            <ul className="space-y-2">
              {rows.map((row) => {
                const enabled = store.liveSelectedUrls.includes(row.url);
                const fromSubscription = row.fromSubscriptions.length > 0;
                return (
                  <li
                    key={row.url}
                    className={cn(
                      'bg-card rounded-lg p-3 transition-colors hover:bg-hover/50',
                      // 未勾选 = 不参与直播列表：淡显，与点播源面板保持同一套停用观感
                      !enabled && 'opacity-70'
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-accent shrink-0"
                        checked={enabled}
                        onChange={() => useAppStore.getState().toggleLiveSelected(row.url)}
                        aria-label={enabled ? t('停用 {name}', { name: row.label }) : t('启用 {name}', { name: row.label })}
                        title={enabled ? t('已启用，取消勾选可停用') : t('已停用，勾选后生效')}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-content truncate">
                          {row.label}
                          {row.preset && (
                            <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-chip text-faint align-middle">
                              {t('部署者预置')}
                            </span>
                          )}
                          {fromSubscription && (
                            <span
                              className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent align-middle"
                              title={t('来自 {n} 个数据源订阅；删除单个订阅不影响此源，仅当不再被任何订阅引用时才会移除', { n: row.fromSubscriptions.length })}
                            >
                              {t('订阅')}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-faint truncate">
                          {row.url}
                          {row.epgUrl && ` · ${t('已配置节目单')}`}
                          {row.lastSync && ` · ${t('同步于 {time}', { time: formatRelativeTime(row.lastSync) })}`}
                        </div>
                      </div>
                      <TestBadge
                        state={tests[row.url]}
                        onTest={() => runTest(row.url, () => api.liveTest(row.url))}
                        title={t('拉取解析并测速（频道数量与耗时）')}
                        badgeWhenOk={({ count }) => `✓ ${t('{n} 频道', { n: count ?? 0 })}`}
                      />
                      <button
                        className="rounded-md p-2 text-muted transition-colors hover:bg-hover hover:text-accent shrink-0"
                        onClick={() => exportM3u(row.url)}
                        aria-label={t('导出 M3U')}
                        title={t('导出为标准 M3U 文件')}
                      >
                        <Icon name="download" className="w-4 h-4" />
                      </button>
                      {row.preset ? null : fromSubscription ? (
                        <>
                          {/* 订阅源由远端列表管理：编辑会被下次同步覆盖、删除会复活，故置为禁用态并指路 */}
                          <button
                            className="rounded-md p-2 text-muted/30 cursor-not-allowed shrink-0"
                            disabled
                            aria-label={t('订阅源不可单独编辑')}
                            title={t('该源来自数据源订阅，修改会在下次同步时被覆盖；请修改远端订阅内容后重新同步')}
                          >
                            <Icon name="edit" className="w-4 h-4" />
                          </button>
                          <button
                            className="rounded-md p-2 text-muted/30 cursor-not-allowed shrink-0"
                            disabled
                            aria-label={t('订阅源不可单独删除')}
                            title={t('该源来自数据源订阅；请到「数据源订阅」中删除整个订阅')}
                          >
                            <Icon name="trash" className="w-4 h-4" />
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            className="rounded-md p-2 text-muted transition-colors hover:bg-hover hover:text-accent shrink-0"
                            onClick={() => setEditing(row.url)}
                            aria-label={t('编辑')}
                            title={t('编辑名称与节目单地址')}
                          >
                            <Icon name="edit" className="w-4 h-4" />
                          </button>
                          <button
                            className="rounded-md p-2 text-muted transition-colors hover:bg-hover hover:text-danger shrink-0"
                            onClick={() => removeWithUndo(row)}
                            aria-label={t('删除直播源')}
                            title={t('移除（可在提示中撤销）')}
                          >
                            <Icon name="trash" className="w-4 h-4" />
                          </button>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

/** 直播源表单：与点播源一致，由「+ 添加 / 编辑」按钮展开；编辑时地址只读、提交后自动探活（仅新增） */
function LiveSourceForm({
  visible,
  initial,
  onCancel,
  onSubmit,
}: {
  visible: boolean;
  /** 编辑模式：仅允许改名称与 EPG，地址只读 */
  initial?: { url: string; name?: string; epg?: string };
  onCancel: () => void;
  onSubmit: (data: { url: string; name?: string; epg?: string }) => void;
}) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [epg, setEpg] = useState('');
  const { toast } = useToast();
  const t = useT();

  useEffect(() => {
    if (visible) {
      setUrl(initial?.url ?? '');
      setName(initial?.name ?? '');
      setEpg(initial?.epg ?? '');
    }
  }, [visible, initial]);

  if (!visible) return null;

  const submit = () => {
    if (initial) {
      onSubmit({ url: initial.url, name: name.trim() || undefined, epg: epg.trim() || undefined });
      return;
    }
    const u = url.trim();
    if (!validateSourceUrl(u)) {
      toast(t('订阅地址需以 http:// 或 https:// 开头'), 'warning');
      return;
    }
    onSubmit({ url: u, name: name.trim() || undefined, epg: epg.trim() || undefined });
  };

  return (
    <div className="space-y-2 border border-line rounded-lg p-3 bg-chip mb-2">
      <input
        className="input w-full disabled:opacity-60"
        aria-label={t('M3U 订阅地址')}
        placeholder={t('M3U 订阅地址，如 https://example.com/list.m3u')}
        value={url}
        maxLength={500}
        disabled={!!initial}
        title={initial ? t('地址不可修改；如需更换请删除后重新添加') : undefined}
        onChange={(e) => setUrl(e.target.value)}
      />
      <input
        className="input w-full"
        aria-label={t('直播源名称（可选）')}
        placeholder={t('名称（可选），如 我的频道列表')}
        value={name}
        maxLength={50}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        className="input w-full"
        aria-label={t('EPG 节目单地址（可选）')}
        placeholder={t('EPG 节目单地址（可选，XMLTV xml/xml.gz）')}
        value={epg}
        maxLength={500}
        onChange={(e) => setEpg(e.target.value)}
      />
      <div className="flex gap-2 justify-end">
        <button className="btn-ghost btn-sm" onClick={onCancel}>
          {t('取消')}
        </button>
        <button className="btn-primary btn-sm" onClick={submit}>
          {t('添加')}
        </button>
      </div>
    </div>
  );
}
