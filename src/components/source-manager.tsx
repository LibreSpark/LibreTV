'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Drawer } from './drawer';
import { ConfirmDialog } from './confirm-dialog';
import { Icon, type IconName } from './icon';
import { LiveSourceManager } from './live-source-manager';
import {
  HealthBadge,
  SearchInput,
  SectionTitle,
  SelectRow,
  TestBadge,
  ToggleRow,
  Switch,
  useSourceTests,
  type TestState,
} from './settings-shared';
import { loadCacheSettings, saveCacheSettings, getCacheSummary, clearVideoCache, type CacheSummary } from '@/lib/video-cache';
import { EmptyState, Spinner } from './states';
import { useSourceProbe } from './use-source-probe';
import { allLiveSources, isSourceDisabled, keyBelongsToSubscription, resolveSource, subKeyPrefix, useAppStore } from '@/lib/store';
import type { SourceConfig } from '@/lib/types';
import { useToast } from './toast';
import { formatRelativeTime, hostnameOf, validateSourceUrl, cn } from '@/lib/utils';
import { exportConfig, importConfig } from '@/lib/db';
import { PERSIST_KEY } from '@/lib/persist-storage';
import { copyToClipboard } from '@/lib/clipboard';
import { useAuth } from './auth';
import { api } from '@/lib/client-api';
import { syncSourceSubscription } from '@/lib/subscription-sync';
import { describeParseStats } from '@/lib/tvbox-parser';

/**
 * 设置抽屉：顶部两级导航。
 * - 一级按性质分组：源管理 / 偏好设置 / 数据；
 * - 二级为该分组下的具体面板，每次只渲染一类内容，避免源很多时长距离滚动。
 * 选中位置记忆到 localStorage，再次打开回到上次所在面板。
 */

type PrimaryTab = 'sources' | 'prefs' | 'data';
type SecondaryTab = 'vod' | 'live' | 'subs' | 'playback' | 'image' | 'home' | 'io';

const PRIMARY_TABS: { id: PrimaryTab; label: string; icon: IconName }[] = [
  { id: 'sources', label: '源管理', icon: 'link' },
  { id: 'prefs', label: '偏好设置', icon: 'gear' },
  { id: 'data', label: '数据', icon: 'download' },
];

const SECONDARY_TABS: Record<PrimaryTab, { id: SecondaryTab; label: string }[]> = {
  sources: [
    { id: 'vod', label: '点播源' },
    { id: 'live', label: '直播源' },
    { id: 'subs', label: '数据源订阅' },
  ],
  prefs: [
    { id: 'playback', label: '播放与过滤' },
    { id: 'image', label: '封面图加载' },
    { id: 'home', label: '首页与内容' },
  ],
  data: [{ id: 'io', label: '配置导入导出' }],
};

const TAB_STORAGE_KEY = 'libretv-settings-tab';

export function SourceManagerDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [primary, setPrimary] = useState<PrimaryTab>('sources');
  const [secondary, setSecondary] = useState<Record<PrimaryTab, SecondaryTab>>({
    sources: 'vod',
    prefs: 'playback',
    data: 'io',
  });

  // 挂载后读取上次位置（不在渲染期读 localStorage，避免 SSR/hydration 不一致）
  useEffect(() => {
    try {
      const raw = localStorage.getItem(TAB_STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as {
        primary?: PrimaryTab;
        secondary?: Partial<Record<PrimaryTab, SecondaryTab>>;
      };
      // 旧版把「数据源订阅」放在「数据」下，现已迁至「源管理」：自动重定向到新位置
      const migratedSubs = saved.secondary?.data === 'subs';
      const targetPrimary = migratedSubs && saved.primary === 'data' ? 'sources' : saved.primary;
      if (targetPrimary && SECONDARY_TABS[targetPrimary]) setPrimary(targetPrimary);
      setSecondary((prev) => {
        const next = { ...prev };
        if (migratedSubs) next.sources = 'subs';
        for (const key of Object.keys(SECONDARY_TABS) as PrimaryTab[]) {
          const v = saved.secondary?.[key];
          if (v && SECONDARY_TABS[key].some((t) => t.id === v)) next[key] = v;
        }
        return next;
      });
    } catch {
      /* 本地记录损坏时忽略，回到默认面板 */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(TAB_STORAGE_KEY, JSON.stringify({ primary, secondary }));
    } catch {
      /* 隐私模式等无法写入时忽略 */
    }
  }, [primary, secondary]);

  const current = secondary[primary];

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="设置"
      resetScrollKey={current}
      subheader={
        <div className="space-y-2">
          <TabRow tabs={PRIMARY_TABS} value={primary} onChange={setPrimary} variant="primary" ariaLabel="设置分类" />
          {/* 分组下只有一项时无需二级导航，直接展示该面板 */}
          {SECONDARY_TABS[primary].length > 1 && (
            <TabRow
              tabs={SECONDARY_TABS[primary]}
              value={current}
              onChange={(id) => setSecondary((prev) => ({ ...prev, [primary]: id }))}
              variant="secondary"
              ariaLabel="设置项"
            />
          )}
        </div>
      }
    >
      {current === 'vod' && <VodSourcesPanel />}
      {current === 'live' && <LiveSourceManager />}
      {current === 'playback' && <PlaybackPanel />}
      {current === 'image' && <ImagePanel />}
      {current === 'home' && <HomePanel />}
      {current === 'subs' && <SourceSubscriptions />}
      {current === 'io' && <ConfigIoPanel />}
    </Drawer>
  );
}

/** 一级/二级导航条（role=tablist，左右方向键切换） */
function TabRow<T extends string>({
  tabs,
  value,
  onChange,
  variant,
  ariaLabel,
}: {
  tabs: { id: T; label: string; icon?: IconName }[];
  value: T;
  onChange: (id: T) => void;
  variant: 'primary' | 'secondary';
  ariaLabel: string;
}) {
  const move = (dir: 1 | -1) => {
    const idx = tabs.findIndex((t) => t.id === value);
    onChange(tabs[(idx + dir + tabs.length) % tabs.length].id);
  };
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn('flex w-full gap-1', variant === 'primary' && 'p-0.5 bg-chip rounded-lg')}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          move(1);
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          move(-1);
        }
      }}
    >
      {tabs.map((t) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={active}
            className={cn(
              // 两级导航都等宽撑满一行（原先二级按内容宽度、超宽才横滚，与一级不一致）
              'flex-1 min-w-0 inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-md transition-colors',
              variant === 'primary'
                ? cn(
                    'px-2 py-1.5 text-xs',
                    active ? 'bg-surface-raised text-accent font-medium shadow-sm' : 'text-muted hover:text-content'
                  )
                : cn(
                    'px-2.5 py-1 text-xs',
                    active ? 'bg-accent/10 text-accent font-medium' : 'text-muted hover:text-content hover:bg-hover'
                  )
            )}
            onClick={() => onChange(t.id)}
          >
            {t.icon && <Icon name={t.icon} className="w-3.5 h-3.5" />}
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// —— 点播源面板 ——

type VodFilter = 'all' | 'enabled' | 'disabled' | 'sub' | 'manual';

// 与直播源面板保持同一组筛选项与顺序：先状态（已启用 / 已停用），后来源（来自订阅 / 手动添加）
const VOD_FILTERS: { id: VodFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'enabled', label: '已启用' },
  { id: 'disabled', label: '已停用' },
  { id: 'sub', label: '来自订阅' },
  { id: 'manual', label: '手动添加' },
];

function VodSourcesPanel() {
  const store = useAppStore();
  const { toast } = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<VodFilter>('all');
  const { tests, runTest } = useSourceTests();
  const { progress, probe, cancel, isProbing } = useSourceProbe();

  const envKeys = useMemo(() => new Set(store.envSources.map((s) => s.key)), [store.envSources]);
  const all = useMemo(() => [...store.envSources, ...store.customAPIs], [store.envSources, store.customAPIs]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((s) => {
      const fromSub = s.key.startsWith('sub_');
      // 已启用 = 勾选中且当前未被自动停用（即真正在参与搜索的源）
      if (filter === 'enabled' && !(store.selectedKeys.includes(s.key) && !isSourceDisabled(store, s.key))) return false;
      if (filter === 'disabled' && !isSourceDisabled(store, s.key)) return false;
      if (filter === 'sub' && !fromSub) return false;
      // 手动添加 = 既非订阅导入、也非部署者预置
      if (filter === 'manual' && (fromSub || envKeys.has(s.key))) return false;
      if (!q) return true;
      return s.name.toLowerCase().includes(q) || s.url.toLowerCase().includes(q);
    });
  }, [all, query, filter, store, envKeys]);

  const visibleKeys = filtered.map((s) => s.key);
  const allSelected = visibleKeys.length > 0 && visibleKeys.every((k) => store.selectedKeys.includes(k));

  const toggleAll = () => {
    if (allSelected) {
      store.setSelectedKeys(store.selectedKeys.filter((k) => !visibleKeys.includes(k)));
      return;
    }
    // 成人过滤开启时成人源不可勾选，与行内复选框保持一致
    const eligible = filtered.filter((s) => !(s.isAdult && store.yellowFilter)).map((s) => s.key);
    const skipped = filtered.length - eligible.length;
    store.setSelectedKeys([...new Set([...store.selectedKeys, ...eligible])]);
    if (skipped > 0) toast(`已启用 ${eligible.length} 个；${skipped} 个成人源因过滤开启被跳过`, 'info');
  };

  const runAll = async () => {
    if (isProbing) {
      cancel();
      return;
    }
    const result = await probe(filtered.map((s) => ({ key: s.key, url: s.url })));
    if (!result) return; // 被取消则无汇总
    toast(`测活完成：${result.ok}/${result.total} 个可用`, result.ok === result.total ? 'success' : 'info');
  };

  /** 一键恢复被自动停用的源（仅「已停用」筛选下提供） */
  const restoreAll = () => {
    const keys = filtered.filter((s) => isSourceDisabled(store, s.key)).map((s) => s.key);
    if (keys.length === 0) return;
    keys.forEach((k) => useAppStore.getState().clearSourceHealth(k));
    toast(`已恢复 ${keys.length} 个源`, 'success');
  };

  const empty = store.envSources.length === 0 && store.customAPIs.length === 0;

  return (
    <section>
      <SectionTitle
        title="点播源"
        hint={empty ? undefined : `共 ${all.length} 个 · 已启用 ${all.filter((s) => store.selectedKeys.includes(s.key)).length}`}
        extra={
          <button className="btn-primary btn-sm" onClick={() => setEditing('__new__')}>
            <Icon name="plus" className="w-3.5 h-3.5" />
            添加 API
          </button>
        }
      />

      <SourceForm
        visible={editing === '__new__'}
        onCancel={() => setEditing(null)}
        onSubmit={(data) => {
          store.addCustomApi(data);
          setEditing(null);
        }}
      />

      {empty && editing !== '__new__' ? (
        <EmptyState
          icon="link"
          title="还没有添加任何点播源"
          description="添加一个 Apple CMS 采集站 API 即可开始搜索影片；也可到「数据源订阅」一次导入点播源与直播源"
          action={
            <button className="btn-primary btn-sm" onClick={() => setEditing('__new__')}>
              添加第一个点播源
            </button>
          }
        />
      ) : (
        <>
          <div className="space-y-2 mb-3">
            <SearchInput value={query} onChange={setQuery} placeholder="搜索名称或地址" />
            <div className="flex flex-wrap items-center gap-1">
              {VOD_FILTERS.map((f) => (
                <button
                  key={f.id}
                  className={cn(
                    'chip',
                    filter === f.id ? 'bg-accent/10 text-accent font-medium' : 'text-muted hover:text-content hover:bg-hover'
                  )}
                  onClick={() => setFilter(f.id)}
                  aria-pressed={filter === f.id}
                >
                  {f.label}
                </button>
              ))}
              <span className="ml-auto text-[11px] text-faint">显示 {filtered.length} 个</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button className="btn-ghost btn-sm" onClick={toggleAll} disabled={filtered.length === 0}>
                {allSelected ? '全部停用' : '全部启用'}
              </button>
              <button
                className="btn-ghost btn-sm"
                onClick={runAll}
                disabled={filtered.length === 0}
              >
                {isProbing ? '取消测活' : '批量测活'}
              </button>
              {/* 查看「已停用」时提供一键恢复，省去逐个点击 */}
              {filter === 'disabled' && (
                <button className="btn-ghost btn-sm" onClick={restoreAll} disabled={filtered.length === 0}>
                  全部恢复
                </button>
              )}
            </div>
            {progress && (
              <div className="flex items-center gap-2 text-[11px] text-muted">
                <div className="flex-1 h-1.5 bg-chip rounded-full overflow-hidden">
                  <div
                    className="h-full bg-accent transition-[width] duration-200"
                    style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
                  />
                </div>
                <span className="tabular-nums shrink-0">
                  {progress.done}/{progress.total} · 可用 {progress.ok}
                  {formatEta(progress.done, progress.total, progress.startedAt)}
                </span>
                <button className="btn-ghost btn-sm shrink-0" onClick={cancel}>
                  取消
                </button>
              </div>
            )}
          </div>

          {filtered.length === 0 ? (
            <EmptyState variant="plain" title="没有符合条件的源" />
          ) : (
            <ul className="space-y-2">
              {filtered.map((source) => (
                <VodSourceRow
                  key={source.key}
                  api={source}
                  isEnv={envKeys.has(source.key)}
                  editing={editing === source.key}
                  onEdit={setEditing}
                  onCancelEdit={() => setEditing(null)}
                  onUpdate={(data) => {
                    store.updateCustomApi(source.key, data);
                    setEditing(null);
                  }}
                  testState={tests[source.key]}
                  onTest={() =>
                    runTest(source.key, async () => {
                      const r = await api.testSource(source.url);
                      // 手动测试也写入健康度，与搜索 / 批量测活共用同一份模型（不再存在两套健康度）
                      useAppStore.getState().recordSourceHealth([
                        { sourceKey: source.key, ok: r.ok, ms: r.ms, error: r.error, list: [] },
                      ]);
                      return r;
                    })
                  }
                />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function formatEta(done: number, total: number, startedAt: number): string {
  if (done <= 0 || done >= total) return '';
  const elapsed = Date.now() - startedAt;
  const remainSec = Math.max(0, Math.round((elapsed / done) * (total - done) / 1000));
  return remainSec > 0 ? ` · 约 ${remainSec}s` : '';
}

/** 单条点播源行：勾选 / 名称标签 / 健康度 / 探活 / 编辑删除（订阅源与预置源按来源限制操作） */
function VodSourceRow({
  api,
  isEnv,
  editing,
  onEdit,
  onCancelEdit,
  onUpdate,
  testState,
  onTest,
}: {
  api: SourceConfig;
  isEnv: boolean;
  editing: boolean;
  onEdit: (key: string) => void;
  onCancelEdit: () => void;
  onUpdate: (data: { name: string; url: string; detail?: string; isAdult?: boolean }) => void;
  testState?: TestState;
  onTest: () => void;
}) {
  const selected = useAppStore((s) => s.selectedKeys.includes(api.key));
  const yellowFilter = useAppStore((s) => s.yellowFilter);
  const toast = useToast().toast;
  const fromSubscription = api.key.startsWith('sub_');
  const adultBlocked = !!api.isAdult && yellowFilter;

  const remove = () => {
    const snapshot = useAppStore.getState().removeCustomApi(api.key);
    if (!snapshot) return;
    // 轻操作：不做确认弹窗，给 6 秒撤销窗口
    toast(`已移除「${api.name}」`, 'info', {
      action: {
        label: '撤销',
        onClick: () => {
          const ok = useAppStore.getState().restoreCustomApi(snapshot);
          toast(ok ? '已恢复' : '恢复失败：该源位置已被重新占用', ok ? 'success' : 'warning');
        },
      },
    });
  };

  if (editing) {
    return (
      <li className="bg-card rounded-lg p-3">
        <SourceForm visible initial={api} onCancel={onCancelEdit} onSubmit={onUpdate} />
      </li>
    );
  }

  return (
    <li
      className={cn(
        'bg-card rounded-lg p-3 transition-colors hover:bg-hover/50',
        // 未勾选 = 不参与搜索：整行淡显，长列表里才能一眼扫出哪些没启用
        !selected && 'opacity-70'
      )}
    >
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          className="h-4 w-4 accent-accent shrink-0"
          checked={selected}
          onChange={() => useAppStore.getState().toggleSourceSelected(api.key)}
          disabled={adultBlocked}
          title={adultBlocked ? '成人内容过滤开启中，需先关闭过滤才能启用此源' : undefined}
          aria-label={`选择 ${api.name}`}
        />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-content truncate">
            {api.name}
            {api.isAdult && <span className="text-pink-400 text-xs ml-1">(18+)</span>}
            {isEnv && (
              <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-chip text-faint align-middle">
                部署者预置
              </span>
            )}
            {fromSubscription && (
              <span
                className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent align-middle"
                title="来自数据源订阅，重新同步时此源的名称/地址会以订阅内容为准"
              >
                订阅
              </span>
            )}
          </div>
          <div className="text-xs text-faint truncate">{api.url}</div>
        </div>
        <HealthBadge sourceKey={api.key} />
        <TestBadge
          state={testState}
          onTest={onTest}
          title="测试可用性（搜索耗时与结果量）"
          badgeWhenOk={({ ms }) => `✓ ${ms}ms`}
        />
        {!isEnv &&
          (fromSubscription ? (
            // 订阅源由远端列表管理：编辑会被下次同步覆盖、删除会复活，故置为禁用态并说明去处
            <>
              <button
                className="rounded-md p-2 text-muted/30 cursor-not-allowed shrink-0"
                disabled
                aria-label="订阅源不可单独编辑"
                title="该源来自订阅，修改会在下次同步时被覆盖；请修改远端订阅后重新同步"
              >
                <Icon name="edit" className="w-4 h-4" />
              </button>
              <button
                className="rounded-md p-2 text-muted/30 cursor-not-allowed shrink-0"
                disabled
                aria-label="订阅源不可单独删除"
                title="该源来自订阅，单独删除会在下次同步时恢复；请到「数据源订阅」删除整个订阅"
              >
                <Icon name="trash" className="w-4 h-4" />
              </button>
            </>
          ) : (
            <>
              <button
                className="rounded-md p-2 text-muted transition-colors hover:bg-hover hover:text-accent shrink-0"
                onClick={() => onEdit(api.key)}
                aria-label="编辑"
                title="编辑"
              >
                <Icon name="edit" className="w-4 h-4" />
              </button>
              <button
                className="rounded-md p-2 text-muted transition-colors hover:bg-hover hover:text-danger shrink-0"
                onClick={remove}
                aria-label="删除"
                title="移除（可在提示中撤销）"
              >
                <Icon name="trash" className="w-4 h-4" />
              </button>
            </>
          ))}
      </div>
    </li>
  );
}

// —— 偏好设置面板 ——

function PlaybackPanel() {
  const store = useAppStore();
  const { toast } = useToast();
  const [clearMarksOpen, setClearMarksOpen] = useState(false);
  const markCount = Object.keys(store.skipMarks).length;
  return (
    <section>
      <SectionTitle title="播放与过滤" />
      <div className="space-y-3">
        <ToggleRow
          label="广告切片过滤"
          description="剔除播放列表中的广告分片段落（按分片 URL 特征、片头插入与长片间超短中插识别，不动 DISCONTINUITY 时间轴）"
          checked={store.adFilter}
          onChange={(v) => store.updateSettings({ adFilter: v })}
        />
        <ToggleRow
          label="自动连播"
          description="单集播放结束后自动播放下一集"
          checked={store.autoplayNext}
          onChange={(v) => store.updateSettings({ autoplayNext: v })}
        />
        <ToggleRow
          label="自动跳过片头"
          description="命中片头标记时自动跳到片头结束位置；关闭后仍显示「跳过片头」按钮（标记在播放页「片头片尾」中设置）"
          checked={store.autoSkipIntro}
          onChange={(v) => store.updateSettings({ autoSkipIntro: v })}
        />
        <ToggleRow
          label="自动跳过片尾"
          description="到达片尾标记时自动结束本集（开启自动连播则继续下一集）；关闭后仍显示「跳过片尾」按钮"
          checked={store.autoSkipOutro}
          onChange={(v) => store.updateSettings({ autoSkipOutro: v })}
        />
      </div>

      {markCount > 0 && (
        <div className="flex items-center justify-between gap-3 pt-3 mt-3 border-t border-line">
          <div className="min-w-0">
            <div className="text-sm text-content">片头片尾标记</div>
            <div className="text-xs text-faint">已记录 {markCount} 部；在播放页「片头片尾」中设置</div>
          </div>
          <button className="btn-ghost btn-sm shrink-0" onClick={() => setClearMarksOpen(true)}>
            清除全部
          </button>
        </div>
      )}

      <ConfirmDialog
        open={clearMarksOpen}
        danger
        title="清除全部片头片尾标记？"
        message={`将删除已记录的 ${markCount} 部剧的片头片尾标记，之后播放不再自动跳过；可重新在播放页标记。`}
        confirmLabel="清除全部"
        onCancel={() => setClearMarksOpen(false)}
        onConfirm={() => {
          store.clearAllSkipMarks();
          setClearMarksOpen(false);
          toast('已清除全部片头片尾标记', 'success');
        }}
      />

      <VideoCachePanel />
    </section>
  );
}

/** 片段缓存：开启/关闭 + 用量展示 + 清理（数据在浏览器本地，独立于配置导出） */
function VideoCachePanel() {
  const [enabled, setEnabled] = useState(() => loadCacheSettings().enabled);
  const [summary, setSummary] = useState<CacheSummary>({ segments: 0, bytes: 0, episodes: 0 });
  const [clearing, setClearing] = useState(false);

  const refresh = useCallback(() => {
    void getCacheSummary().then(setSummary);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const formatBytes = (bytes: number): string => {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
    return `${(bytes / 1024).toFixed(0)} KB`;
  };

  return (
    <div className="space-y-3 pt-3 mt-3 border-t border-line">
      <ToggleRow
        label="片段本地缓存"
        description="暂停或观看时把后续分片缓存到浏览器本地，二次播放与断网卡顿时直接命中（存储于本机，不计入配置导出）"
        checked={enabled}
        onChange={(v) => {
          const next = saveCacheSettings({ enabled: v });
          setEnabled(next.enabled);
        }}
      />
      <div className="flex items-center justify-between text-xs text-faint">
        <span>
          已缓存 {summary.segments} 个分片 · {formatBytes(summary.bytes)} · {summary.episodes} 集
        </span>
        <button
          type="button"
          className="px-2 py-1 rounded bg-chip text-content hover:bg-hover transition-colors disabled:opacity-50"
          disabled={clearing || summary.segments === 0}
          onClick={async () => {
            setClearing(true);
            await clearVideoCache();
            refresh();
            setClearing(false);
          }}
        >
          清理缓存
        </button>
      </div>
    </div>
  );
}

function ImagePanel() {
  const store = useAppStore();
  const mode = store.imageProxyMode;
  const description: Record<'direct' | 'proxy' | 'custom', string> = {
    direct: '原站直连；豆瓣封面自动换公共镜像，仍失败回退内置代理。最省服务器流量',
    proxy: '封面优先经本站服务器转发并伪装来源，失败自动回退公共镜像/直连。最稳定，消耗服务器流量',
    custom: '使用你填写的模板转发封面图',
  };
  return (
    <section>
      <SectionTitle title="封面图加载" />
      <div className="space-y-2">
        <SelectRow
          label="加载方式"
          value={mode}
          description={description[mode]}
          onChange={(v) => store.updateSettings({ imageProxyMode: v as 'direct' | 'proxy' | 'custom' })}
          options={[
            { value: 'direct', label: '直连优先', hint: '最省服务器流量' },
            { value: 'proxy', label: '内置代理', hint: '最稳定' },
            { value: 'custom', label: '自定义', hint: '自建转发模板' },
          ]}
        />
        {mode === 'custom' && <CustomProxyInput />}
      </div>
    </section>
  );
}

/**
 * 自定义代理模板输入：本地即时回显 + 300ms 防抖写 store。
 * 直接每次按键写 store 会让全站封面 URL 重算并触发一轮图片重载（模板输入时缩略图持续闪烁）。
 */
function CustomProxyInput() {
  const value = useAppStore((s) => s.customImageProxy);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const [draft, setDraft] = useState(value);

  // 外部值变化（如导入配置）时同步回显
  useEffect(() => setDraft(value), [value]);

  useEffect(() => {
    if (draft === value) return;
    const timer = setTimeout(() => updateSettings({ customImageProxy: draft }), 300);
    return () => clearTimeout(timer);
  }, [draft, value, updateSettings]);

  return (
    <input
      className="input w-full"
      aria-label="自定义代理模板"
      placeholder="代理模板，如 https://p.example.com/?url={url}"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
    />
  );
}

function HomePanel() {
  const store = useAppStore();
  return (
    <section>
      <SectionTitle title="首页与内容过滤" />
      <div className="space-y-3">
        <ToggleRow
          label="成人内容过滤"
          description="过滤“伦理片”等分类的结果"
          checked={store.yellowFilter}
          onChange={(v) => store.updateSettings({ yellowFilter: v })}
        />
        <ToggleRow
          label="首页推荐"
          description="在首页展示推荐内容"
          checked={store.doubanEnabled}
          onChange={(v) => store.updateSettings({ doubanEnabled: v })}
        />
        <SelectRow
          label="推荐数据源"
          value={store.recommendSource}
          onChange={(v) => store.updateSettings({ recommendSource: v as 'douban' | 'bangumi' | 'hot-list' })}
          options={[
            { value: 'douban', label: '豆瓣', hint: '热门电影与剧集' },
            { value: 'bangumi', label: 'Bangumi', hint: '每日新番放送（免 key）' },
            { value: 'hot-list', label: '影视榜单', hint: '豆瓣周榜 / 百度热播' },
          ]}
        />
      </div>
    </section>
  );
}

// —— 数据面板 ——

/**
 * 数据源订阅 / 分享：
 * - 订阅：填入远程订阅地址（LibreTV-SourceList JSON 或 TVBOX 配置 JSON，由服务端自动识别），
 *   一次拉取点播源与直播源，可随时重新同步；
 * - 分享：把当前点播源 + 直播源导出为同格式 JSON 文件，托管到任意位置即可被他人订阅。
 */
function SourceSubscriptions() {
  const store = useAppStore();
  const { toast } = useToast();
  const [subUrl, setSubUrl] = useState('');
  // 每个订阅独立的同步状态，允许多个订阅并行同步（此前单值状态会串台）
  const [syncing, setSyncing] = useState<Set<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const sync = async (url: string) => {
    setSyncing((prev) => new Set(prev).add(url));
    try {
      const { vodCount, liveCount, stats } = await syncSourceSubscription(url);
      // 如实说明跳过/截断情况，避免用户疑惑「配置里站点很多，为何只导入了个位数」
      const detail = describeParseStats(stats, { includeSamples: false });
      const formatLabel = stats?.format === 'tvbox' ? '（TVBOX 配置）' : '';
      toast(`已同步 ${vodCount} 个点播源、${liveCount} 个直播源${formatLabel}${detail ? `；${detail}` : ''}`, 'success');
      setSubUrl('');
    } catch (err) {
      toast(err instanceof Error ? err.message : '订阅同步失败', 'error');
    } finally {
      setSyncing((prev) => {
        const next = new Set(prev);
        next.delete(url);
        return next;
      });
    }
  };

  const addAndSync = () => {
    const url = subUrl.trim();
    if (!validateSourceUrl(url)) {
      toast('订阅地址需以 http:// 或 https:// 开头', 'warning');
      return;
    }
    void sync(url);
  };

  // 发布状态：进行中 + 上一次的发布结果（链接、粘贴板来源与条数）
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState<{
    url: string;
    provider: string;
    sources: number;
    liveSources: number;
  } | null>(null);

  /**
   * 发布当前「已勾选启用」的源：只把真正在参与搜索的源发出去
   * （未勾选的、以及被自动停用的都排除）。注意这与「导出数据源」的全量语义不同。
   */
  const publish = async () => {
    const seen = new Set<string>();
    const sources = store.selectedKeys
      .map((key) => resolveSource(store, key))
      .filter((s): s is SourceConfig => !!s && validateSourceUrl(s.url) && !isSourceDisabled(store, s.key))
      .filter((s) => {
        const key = s.url.replace(/\/+$/, '');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(({ name, url }) => ({ name, url }));

    const liveSeen = new Set<string>();
    const liveSources = allLiveSources(store)
      .filter((s) => store.liveSelectedUrls.includes(s.url))
      .filter((s) => {
        if (liveSeen.has(s.url)) return false;
        liveSeen.add(s.url);
        return true;
      })
      .map(({ name, url, epg }) => ({ name: name || hostnameOf(url), url, epg }));

    if (sources.length === 0 && liveSources.length === 0) {
      toast('没有已勾选启用的源可发布', 'warning');
      return;
    }

    setPublishing(true);
    try {
      const result = await api.publishSourceList({ name: 'LibreTV-SourceList', sources, liveSources });
      setPublished(result);
      toast(`已发布 ${result.sources} 个点播源、${result.liveSources} 个直播源到 ${result.provider}`, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : '发布失败', 'error');
    } finally {
      setPublishing(false);
    }
  };

  const copyPublished = () => {
    if (!published) return;
    copyToClipboard(published.url).then((ok) =>
      ok ? toast('订阅链接已复制', 'success') : toast('复制失败，请手动选中复制', 'warning'),
    );
  };

  const exportSources = () => {
    const all = [...store.envSources, ...store.customAPIs];
    const seen = new Set<string>();
    const sources = all
      .filter((s) => {
        const u = s.url.replace(/\/+$/, '');
        if (seen.has(u)) return false;
        seen.add(u);
        return true;
      })
      .map(({ name, url, detail, isAdult }) => ({ name, url, detail, isAdult }));

    // 直播源：预置 + 手动 + 订阅导入，按 URL 去重
    const liveSeen = new Set<string>();
    const liveSources = [...store.liveEnvSources, ...store.liveSubscriptions]
      .filter((s) => {
        if (liveSeen.has(s.url)) return false;
        liveSeen.add(s.url);
        return true;
      })
      .map(({ name, url, epg }) => ({ name: name || hostnameOf(url), url, epg }));

    const payload = { name: 'LibreTV-SourceList', version: 2, exportedAt: Date.now(), sources, liveSources };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `LibreTV-SourceList_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast(`已导出 ${sources.length} 个点播源、${liveSources.length} 个直播源，托管后即可被他人订阅`, 'success');
  };

  const deleteImpact = (url: string) => {
    const prefix = subKeyPrefix(url);
    return {
      vod: store.customAPIs.filter((a) => keyBelongsToSubscription(a.key, prefix)).length,
      live: store.liveSubscriptions.filter((s) => s.fromSubscriptions.includes(url)).length,
    };
  };

  return (
    <section>
      <SectionTitle
        title="数据源订阅 / 分享"
        extra={
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              className="btn-ghost btn-sm"
              onClick={exportSources}
              disabled={
                store.customAPIs.length + store.envSources.length + store.liveSubscriptions.length + store.liveEnvSources.length ===
                0
              }
            >
              导出数据源
            </button>
            <button
              className="btn-ghost btn-sm"
              onClick={() => void publish()}
              disabled={publishing}
              title="把当前已勾选启用的源上传到公开粘贴板，生成可直接订阅的链接"
            >
              {publishing ? '发布中…' : '发布为链接'}
            </button>
          </div>
        }
      />

      {/* 发布结果：链接公开可读、粘贴板也可能随时清理，这些风险直接写在这里而不是只在 toast 里闪一下 */}
      {published && (
        <div className="mb-3 rounded-lg border border-line bg-chip/60 p-2.5">
          <div className="flex items-center gap-1.5">
            <input
              readOnly
              value={published.url}
              className="input flex-1 min-w-0 !py-1.5 text-xs"
              aria-label="已发布的订阅地址"
              onFocus={(e) => e.currentTarget.select()}
            />
            <button className="btn-ghost btn-sm shrink-0" onClick={copyPublished}>
              复制
            </button>
            <button
              className="btn-ghost btn-sm shrink-0"
              onClick={() => {
                setSubUrl(published.url);
                void sync(published.url);
              }}
            >
              直接订阅
            </button>
          </div>
          <p className="mt-1.5 text-[11px] text-faint leading-relaxed">
            已发布到 {published.provider}（{published.sources} 个点播源、{published.liveSources} 个直播源）。
            链接内容公开可读，粘贴板也可能随时清理——长期使用建议自行托管。
          </p>
        </div>
      )}

      <div className="flex gap-2 mb-2">
        <input
          className="input flex-1 min-w-0"
          placeholder="订阅地址（LibreTV 源列表或 TVBOX 配置的 JSON URL）"
          value={subUrl}
          onChange={(e) => setSubUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addAndSync();
          }}
        />
        <button
          className="btn-primary btn-sm shrink-0"
          disabled={!subUrl.trim() || syncing.size > 0}
          onClick={addAndSync}
        >
          {syncing.size > 0 ? '同步中…' : '订阅'}
        </button>
      </div>
      {store.subscriptions.length === 0 ? (
        <p className="text-xs text-faint">
          一份订阅可同时下发点播源与直播源，支持 LibreTV 源列表与 TVBOX 配置（仅导入可直接使用的接口，Spider 类站点自动跳过）；
          「导出数据源」生成的 JSON 托管到任意 URL 即可分享给他人订阅。
        </p>
      ) : (
        <ul className="space-y-2">
          {store.subscriptions.map((sub) => {
            const vodCount = store.customAPIs.filter((a) => keyBelongsToSubscription(a.key, subKeyPrefix(sub.url))).length;
            const liveCount = store.liveSubscriptions.filter((s) => s.fromSubscriptions.includes(sub.url)).length;
            const isSyncing = syncing.has(sub.url);
            return (
              <li
                key={sub.url}
                className={cn(
                  'bg-card rounded-lg p-3 transition-colors hover:bg-hover/50',
                  // 与源列表的「未勾选」用同一套停用观感：淡显 + 徽章说明
                  sub.enabled === false && 'opacity-70'
                )}
              >
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-content truncate">{sub.name || hostnameOf(sub.url)}</div>
                    <div className="text-xs text-faint truncate">
                      {sub.url}
                      {sub.lastSync && ` · 同步于 ${formatRelativeTime(sub.lastSync)}`}
                    </div>
                    <div className="mt-1 flex items-center gap-1 flex-wrap">
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">点播 {vodCount}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">直播 {liveCount}</span>
                      {sub.enabled === false && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-warning/15 text-warning">已停用</span>
                      )}
                      {sub.lastStatus === 'error' ? (
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded bg-danger/15 text-danger"
                          title={sub.lastError}
                        >
                          上次同步失败
                        </span>
                      ) : sub.lastStatus === 'ok' && sub.lastCounts ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-success/15 text-success">
                          上次导入 {sub.lastCounts.vod} 点播 / {sub.lastCounts.live} 直播
                        </span>
                      ) : null}
                    </div>
                    {sub.lastStatus === 'error' && sub.lastError && (
                      <p className="text-[11px] text-danger mt-1 break-all">{sub.lastError}</p>
                    )}
                  </div>
                  <Switch
                    checked={sub.enabled !== false}
                    onChange={(v) => store.setSubscriptionEnabled(sub.url, v)}
                    label={sub.enabled === false ? '启用该订阅' : '停用该订阅'}
                    title={
                      sub.enabled === false
                        ? '当前已停用（其源不参与搜索），点击启用'
                        : '停用后该订阅下的源暂不参与搜索；已导入的数据与各源勾选状态都保留'
                    }
                  />
                  <button
                    className="rounded-md p-2 shrink-0 text-muted transition-colors hover:bg-hover hover:text-accent disabled:opacity-40"
                    disabled={isSyncing}
                    onClick={() => sync(sub.url)}
                    aria-label="重新同步"
                    title="重新同步（以远端列表为准，整体替换该订阅名下的点播源与直播源）"
                  >
                    {isSyncing ? (
                      <Spinner size="sm" />
                    ) : (
                      <Icon name="refresh" className="w-4 h-4" />
                    )}
                  </button>
                  <button
                    className="rounded-md p-2 shrink-0 text-muted transition-colors hover:bg-hover hover:text-danger"
                    onClick={() => setPendingDelete(sub.url)}
                    aria-label="删除订阅"
                    title="删除订阅及其导入的点播源与直播源（保留收藏的频道）"
                  >
                    <Icon name="trash" className="w-4 h-4" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* 重操作：删除订阅会级联移除其导入的源，先确认并说明影响面 */}
      <ConfirmDialog
        open={pendingDelete !== null}
        danger
        title="删除该订阅？"
        message={
          pendingDelete
            ? (() => {
                const impact = deleteImpact(pendingDelete);
                const parts: string[] = [];
                if (impact.vod > 0) parts.push(`${impact.vod} 个点播源`);
                if (impact.live > 0) parts.push(`${impact.live} 个直播源`);
                return parts.length > 0
                  ? `将同时删除该订阅导入的 ${parts.join(' 与 ')}；你收藏的频道会保留。`
                  : '该订阅当前未导入任何源，删除后不影响其他数据。';
              })()
            : undefined
        }
        confirmLabel="删除订阅"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const url = pendingDelete;
          if (url) useAppStore.getState().removeSubscription(url);
          setPendingDelete(null);
          toast('订阅已删除', 'success');
        }}
      />
    </section>
  );
}

/** 配置导入导出（导出受登录门控；导入前先解析预览再确认，避免误覆盖） */
function ConfigIoPanel() {
  const { toast } = useToast();
  const { verified, openLogin } = useAuth();
  const [pending, setPending] = useState<{ file: File; summary: string } | null>(null);

  const doExport = async () => {
    if (verified === false) {
      openLogin();
      return;
    }
    try {
      const json = await exportConfig();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `LibreTV-Settings_${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast('配置已导出', 'success');
    } catch {
      toast('导出失败', 'error');
    }
  };

  const pickImport = async (file: File) => {
    try {
      const summary = summarizeConfig(await file.text());
      setPending({ file, summary });
    } catch (err) {
      toast(err instanceof Error ? err.message : '导入失败', 'error');
    }
  };

  const confirmImport = async () => {
    if (!pending) return;
    try {
      await importConfig(await pending.file.text());
      setPending(null);
      toast('配置导入成功，即将刷新页面', 'success');
      setTimeout(() => window.location.reload(), 1500);
    } catch (err) {
      toast(err instanceof Error ? err.message : '导入失败', 'error');
    }
  };

  return (
    <section>
      <SectionTitle title="配置导入导出" hint="导出/导入包含数据源、订阅与偏好设置的整机配置" />
      <div className="flex gap-2">
        <button className="btn-ghost flex-1 text-xs" onClick={doExport}>
          导出配置
        </button>
        <label className="btn-ghost flex-1 text-xs cursor-pointer">
          导入配置
          <input
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void pickImport(f);
              e.target.value = '';
            }}
          />
        </label>
      </div>

      {/* 重操作：导入会覆盖全部配置，先确认并展示将导入的内容概要 */}
      <ConfirmDialog
        open={pending !== null}
        danger
        title="导入配置并覆盖当前数据？"
        message={pending ? `${pending.summary}。导入后将立即刷新页面，当前设备上的配置与观看历史会被覆盖。` : undefined}
        confirmLabel="导入并覆盖"
        onCancel={() => setPending(null)}
        onConfirm={confirmImport}
      />
    </section>
  );
}

/** 解析配置文件概要（宽松，仅用于导入前预览） */
function summarizeConfig(text: string): string {
  let cfg: { name?: string; data?: Record<string, unknown> };
  try {
    cfg = JSON.parse(text) as { name?: string; data?: Record<string, unknown> };
  } catch {
    throw new Error('文件不是合法的 JSON');
  }
  if (cfg.name !== 'LibreTV-Settings') throw new Error('不是 LibreTV 的配置文件');

  const parts: string[] = [];
  const settingsRaw = cfg.data?.[PERSIST_KEY];
  if (typeof settingsRaw === 'string') {
    try {
      const state = (JSON.parse(settingsRaw) as { state?: Record<string, unknown> }).state ?? {};
      const vod = Array.isArray(state.customAPIs) ? state.customAPIs.length : 0;
      const live = Array.isArray(state.liveSubscriptions) ? state.liveSubscriptions.length : 0;
      const subs = Array.isArray(state.subscriptions) ? state.subscriptions.length : 0;
      parts.push(`${vod} 个点播源`, `${live} 个直播源`, `${subs} 个订阅`);
    } catch {
      /* 设置片段损坏时忽略该部分统计 */
    }
  }
  const historyRaw = cfg.data?.['viewingHistory'];
  if (typeof historyRaw === 'string') {
    try {
      const h = JSON.parse(historyRaw);
      if (Array.isArray(h)) parts.push(`${h.length} 条观看历史`);
    } catch {
      /* 忽略 */
    }
  }
  return parts.length > 0 ? `该文件包含 ${parts.join('、')}` : '该文件未包含可导入的数据';
}

function SourceForm({
  visible,
  initial,
  onCancel,
  onSubmit,
}: {
  visible: boolean;
  initial?: { key: string; name: string; url: string; detail?: string; isAdult?: boolean };
  onCancel: () => void;
  onSubmit: (data: { name: string; url: string; detail?: string; isAdult?: boolean }) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [url, setUrl] = useState(initial?.url ?? '');
  const [detail, setDetail] = useState(initial?.detail ?? '');
  const [isAdult, setIsAdult] = useState(initial?.isAdult ?? false);
  const { toast } = useToast();

  useEffect(() => {
    if (visible) {
      setName(initial?.name ?? '');
      setUrl(initial?.url ?? '');
      setDetail(initial?.detail ?? '');
      setIsAdult(initial?.isAdult ?? false);
    }
  }, [visible, initial]);

  if (!visible) return null;

  const submit = () => {
    const n = name.trim();
    const u = url.trim().replace(/\/+$/, '');
    if (!n || !u) {
      toast('请输入 API 名称和链接', 'warning');
      return;
    }
    if (!validateSourceUrl(u)) {
      toast('API 链接需以 http:// 或 https:// 开头', 'warning');
      return;
    }
    onSubmit({ name: n, url: u, detail: detail.trim() || undefined, isAdult });
  };

  return (
    <div className="space-y-2 border border-line rounded-lg p-3 bg-chip mb-2">
    <input
      className="input w-full"
      aria-label="点播源名称"
      placeholder="名称"
      value={name}
      onChange={(e) => setName(e.target.value)}
    />
    <input
      className="input w-full"
      aria-label="API 地址"
      placeholder="API 地址，如 https://example.com/api.php/provide/vod"
      value={url}
      onChange={(e) => setUrl(e.target.value)}
    />
    <input
      className="input w-full"
      aria-label="详情页地址（可选）"
      placeholder="详情页地址（可选），如 https://example.com"
      value={detail}
      onChange={(e) => setDetail(e.target.value)}
    />
      <label className="flex items-center gap-2 text-xs text-muted">
        <input
          type="checkbox"
          className="h-3.5 w-3.5 accent-pink-500"
          checked={isAdult}
          onChange={(e) => setIsAdult(e.target.checked)}
        />
        标记为成人内容源（受成人过滤控制）
      </label>
      <div className="flex gap-2 justify-end">
        <button className="btn-ghost btn-sm" onClick={onCancel}>
          取消
        </button>
        <button className="btn-primary btn-sm" onClick={submit}>
          {initial ? '更新' : '添加'}
        </button>
      </div>
    </div>
  );
}
