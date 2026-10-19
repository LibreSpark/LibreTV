'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Drawer } from './drawer';
import { Icon } from './icon';
import { useToast } from './toast';
import { db, type DownloadTaskEntry } from '@/lib/db';
import {
  PauseResumeController,
  clearDownloadChunks,
  runDownloadJob,
  supportsChunkCache,
  type DownloadProgress,
} from '@/lib/m3u8-downloader';
import { loadDownloadSettings, saveDownloadSettings } from '@/lib/download-settings';
import { detectSavingCapability, pickSaveTarget } from '@/lib/download-saver';
import { Switch } from './settings-shared';
import { tr, useT } from '@/lib/i18n';

/**
 * 全局下载管理器（UI 采用本站 Drawer 模式）：
 * - 入口：header 下载图标 + 播放页「下载本集」（均派发 window 事件）；
 * - 并发：全局最多同时进行 3 个任务，其余排队（waiting）；
 * - 断点：已下载分片写入 Cache Storage（网络层断点）；
 *   保存目标（FS Access / 内存）活不过页面刷新，恢复时由用户点击「继续」重新选择。
 */

const MAX_CONCURRENT_DOWNLOADS = 3;
/** 进度落库节流间隔：整集动辄上千分片，逐片「写库 + 全量查询 + setState」会把长任务页面拖垮 */
const PROGRESS_PERSIST_INTERVAL_MS = 1000;
const ADD_TASK_EVENT = 'libretv:add-download';
const SHOW_MANAGER_EVENT = 'libretv:show-download-manager';
export const DOWNLOADS_UPDATED_EVENT = 'libretv:downloads-updated';

export interface AddDownloadPayload {
  url: string;
  title: string;
  format?: 'TS' | 'MP4';
}

/** 运行中的任务句柄（不进持久化） */
interface RunningHandle {
  abort: AbortController;
  pause: PauseResumeController;
  /** 恢复后需要用户重选保存位置时置 false */
  hasTarget: boolean;
}

export function DownloadManager({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const t = useT();
  const [tasks, setTasks] = useState<DownloadTaskEntry[]>([]);
  const [capability, setCapability] = useState<'fs-access' | 'memory'>('memory');
  const [chunkCache, setChunkCache] = useState(true);
  const [proxy, setProxy] = useState(false);
  const running = useRef(new Map<string, RunningHandle>());

  const refresh = useCallback(() => {
    void db.downloads.orderBy('createdAt').reverse().toArray().then(setTasks);
  }, []);

  const updateEntry = useCallback(async (id: string, patch: Partial<DownloadTaskEntry>) => {
    await db.downloads.update(id, { ...patch, updatedAt: Date.now() });
    refresh();
  }, [refresh]);

  // 下载设置在挂载时读取：抽屉关闭时 header / 播放页也会派发入队事件，
  // 若只在打开抽屉时才读，关闭状态下加入的任务会漏掉用户的中转偏好
  useEffect(() => {
    setProxy(loadDownloadSettings().proxy);
  }, []);

  // —— 任务启动：选目标 → runDownloadJob ——
  const startTask = useCallback(
    async (entry: DownloadTaskEntry, hasTarget: boolean) => {
      if (running.current.has(entry.id)) return;
      const abort = new AbortController();
      const pause = new PauseResumeController();
      running.current.set(entry.id, { abort, pause, hasTarget });
      await updateEntry(entry.id, { status: 'downloading' });

      // 进度：UI 走本地 state 实时刷新，落库按固定间隔节流。整集动辄上千分片，
      // 逐片 updateEntry（写库 + 全量查询 + setState）会让页面越下越卡，
      // 极端情况下长任务被浏览器判定为无响应
      let lastPersistAt = 0;
      const onProgress = (p: DownloadProgress) => {
        const status = p.status === 'done' ? 'completed' : p.status === 'error' ? 'error' : 'downloading';
        setTasks((prev) => prev.map((t) => (t.id === entry.id ? { ...t, finished: p.current, total: p.total, status } : t)));
        const now = Date.now();
        // 状态切换（完成/失败/处理中）必须立刻持久化，纯进度才节流
        if (p.status === 'downloading' && now - lastPersistAt < PROGRESS_PERSIST_INTERVAL_MS) return;
        lastPersistAt = now;
        void db.downloads.update(entry.id, { finished: p.current, total: p.total, status, updatedAt: now });
      };

      const job = runDownloadJob({
        taskId: entry.id,
        url: entry.url,
        title: entry.title,
        format: entry.format,
        signal: abort.signal,
        pause,
        // 中转开关在任务启动时取当前值：切换只影响之后开始的任务，
        // 已在跑的任务保持原有链路，不会下到一半换源
        proxy,
        onProgress,
        // hasTarget=false（刷新恢复/排队恢复）时目标已在手势内由「继续」按钮选好
        target: (globalThis as unknown as { __dlSaveTarget?: { id: string; target: import('@/lib/download-saver').SaveTarget } }).__dlSaveTarget?.id === entry.id
          ? (globalThis as unknown as { __dlSaveTarget: { target: import('@/lib/download-saver').SaveTarget } }).__dlSaveTarget.target
          : {
              // 目标已失效（页面刷新后句柄消亡）：显式报错引导用户点「继续」重选，
              // 绝不能静默空写——否则任务会显示完成却产出空文件
              kind: 'memory',
              write: async () => {
                throw new Error(tr('保存位置已失效，请点击「继续」重新选择'));
              },
              close: async () => {},
              abort: async () => {},
            },
      });

      void job
        .then(async () => {
          await updateEntry(entry.id, { status: 'completed' });
          void clearDownloadChunks(entry.id);
          toast(tr('《{title}》下载完成', { title: entry.title }), 'success');
        })
        .catch(async (err: Error) => {
          if (abort.signal.aborted) return; // 用户取消：状态已在取消处理里写好
          await updateEntry(entry.id, { status: 'error' });
          toast(tr('《{title}》下载失败：{message}', { title: entry.title, message: tr(err.message) }), 'error');
        })
        .finally(() => {
          running.current.delete(entry.id);
          scheduleNext();
        });
    },
    // scheduleNext 刻意不进依赖：它与 startTask 相互引用，进依赖会让回调每帧重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [toast, updateEntry, proxy]
  );

  // —— 全局并发调度 ——
  const scheduleNext = useCallback(() => {
    void (async () => {
      const runningCount = running.current.size;
      if (runningCount >= MAX_CONCURRENT_DOWNLOADS) return;
      const all = await db.downloads.orderBy('createdAt').toArray();
      const waiting = all.filter((t) => t.status === 'waiting' && !running.current.has(t.id));
      for (const t of waiting.slice(0, MAX_CONCURRENT_DOWNLOADS - runningCount)) {
        const entry = t;
        // 队列恢复的任务没有保存目标：以内存目标启动（分片已在本地，写出快）
        void startTask(
          { ...entry, format: entry.format },
          (globalThis as { __dlSaveTarget?: { id: string } }).__dlSaveTarget?.id === entry.id
        );
      }
    })();
  }, [startTask]);

  // —— 事件：新增任务（用户手势内触发，可安全弹文件选择器） ——
  // 监听器必须常驻：播放页「下载本集」在抽屉关闭时也会派发事件，
  // 若仅 isOpen 时注册，事件会凭空丢失——toast 提示了入队，实际什么都没发生
  useEffect(() => {
    const onAdd = (e: Event) => {
      const detail = (e as CustomEvent<AddDownloadPayload>).detail;
      if (!detail?.url || !detail?.title) return;
      // 无 Cache Storage（HTTP 访问 / 老浏览器）时下载必然失败——分片无处暂存。
      // 在入队这一步就讲清楚，别让用户等到任务跑到一半才看到报错
      if (!supportsChunkCache()) {
        toast(tr('当前环境不支持下载缓存（需通过 HTTPS 访问），无法下载'), 'error');
        return;
      }
      void (async () => {
        const format = detail.format ?? 'MP4';
        const id = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const entry: DownloadTaskEntry = {
          id,
          url: detail.url,
          title: detail.title,
          format,
          status: 'waiting',
          finished: 0,
          total: 0,
          errorNum: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        // 用户手势内预选保存目标（FS Access 弹窗必须在手势内）
        try {
          const target = await pickSaveTarget(`${detail.title}.${format.toLowerCase()}`);
          (globalThis as unknown as { __dlSaveTarget?: { id: string; target: import('@/lib/download-saver').SaveTarget } }).__dlSaveTarget = {
            id,
            target,
          };
        } catch (err) {
          if (err instanceof Error && err.message.includes('取消')) {
            toast(tr('已取消下载'), 'info');
            return;
          }
        }
        await db.downloads.put(entry);
        refresh();
        scheduleNext();
        toast(tr('《{title}》已加入下载队列', { title: detail.title }), 'success');
      })();
    };

    window.addEventListener(ADD_TASK_EVENT, onAdd);
    return () => {
      window.removeEventListener(ADD_TASK_EVENT, onAdd);
    };
  }, [refresh, scheduleNext, toast]);

  // 抽屉打开时：刷新保存能力与任务列表，并启动排队中的任务
  useEffect(() => {
    if (!isOpen) return;
    setCapability(detectSavingCapability());
    setChunkCache(supportsChunkCache());
    // 顺带重读下载设置：多标签页下另一处改了开关也能同步过来
    setProxy(loadDownloadSettings().proxy);
    refresh();
    scheduleNext();
  }, [isOpen, refresh, scheduleNext]);

  const onToggleProxy = (next: boolean) => {
    // 以落库结果为准回写 state：存储不可用（隐私模式）时 UI 不能假装已保存
    setProxy(saveDownloadSettings({ proxy: next }).proxy);
    toast(
      next ? t('已开启下载中转，新任务经服务器转发') : t('已关闭下载中转，新任务直连源站'),
      'info'
    );
  };

  const onPauseResume = async (entry: DownloadTaskEntry) => {
    const handle = running.current.get(entry.id);
    if (handle && entry.status === 'downloading') {
      handle.pause.pause();
      await updateEntry(entry.id, { status: 'paused' });
      return;
    }
    if (entry.status === 'paused' || entry.status === 'waiting' || entry.status === 'error') {
      // 恢复：需要用户手势内重选保存目标（浏览器限制）
      try {
        const target = await pickSaveTarget(`${entry.title}.${entry.format.toLowerCase()}`);
        (globalThis as unknown as { __dlSaveTarget?: { id: string; target: import('@/lib/download-saver').SaveTarget } }).__dlSaveTarget = {
          id: entry.id,
          target,
        };
        if (running.current.has(entry.id)) return;
        await updateEntry(entry.id, { status: 'waiting' });
        scheduleNext();
      } catch (err) {
        if (err instanceof Error && err.message.includes('取消')) toast(tr('已取消'), 'info');
      }
      return;
    }
    void handle; // downloading 且无 handle：状态漂移，等待调度器自愈
  };

  const onCancel = async (entry: DownloadTaskEntry) => {
    running.current.get(entry.id)?.abort.abort();
    running.current.delete(entry.id);
    await clearDownloadChunks(entry.id);
    await db.downloads.delete(entry.id);
    refresh();
    // 终态（已完成/失败）删的是记录而非终止任务；文件已保存在用户选择的位置，不受影响
    toast(
      entry.status === 'completed' || entry.status === 'error'
        ? t('《{title}》已删除下载记录', { title: entry.title })
        : t('《{title}》已取消下载', { title: entry.title }),
      'info'
    );
  };

  const statusLabel: Record<DownloadTaskEntry['status'], string> = {
    waiting: t('排队中'),
    downloading: t('下载中'),
    paused: t('已暂停'),
    completed: t('已完成'),
    error: t('失败'),
  };

  return (
    <Drawer open={isOpen} onClose={onClose} title={t('下载管理')} width="max-w-lg">
      <div className="space-y-3">
        <div className="card p-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-content">{t('经服务器中转下载')}</p>
            <p className="text-xs text-faint">
              {t('直连被跨域 / 防盗链 / 混合内容拦下时开启：整集流量（含分片与密钥）经服务器转发，带宽由部署者承担。仅对之后开始的任务生效。')}
            </p>
          </div>
          <Switch checked={proxy} onChange={onToggleProxy} label={t('经服务器中转下载')} />
        </div>
        <p className="text-xs text-faint">
          {t('保存能力：')}{capability === 'fs-access' ? t('磁盘直写（边下边存）') : t('内存聚合（完成后浏览器下载）')}
          {chunkCache ? ` · ${t('支持断点续传')}` : ` · ${t('当前环境无断点缓存（需 HTTPS 访问）')}`} ·{' '}
          {t('同时进行 {n}/{max} 个任务', { n: Math.min(running.current.size, MAX_CONCURRENT_DOWNLOADS), max: MAX_CONCURRENT_DOWNLOADS })}
        </p>
        {tasks.length === 0 && (
          <div className="py-10 text-center text-sm text-faint">
            {t('暂无下载任务。在播放页点击「下载本集」开始。')}
          </div>
        )}
        {tasks.map((task) => (
          <div key={task.id} className="card p-3 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm text-content truncate">{task.title}</p>
                <p className="text-xs text-faint">
                  {task.format.toUpperCase()} · {statusLabel[task.status]}
                  {task.status === 'downloading' && task.total > 0 ? ` · ${t('{done}/{total} 分片', { done: task.finished, total: task.total })}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {task.status === 'downloading' && (
                  <button
                    type="button"
                    className="px-2 py-1 rounded bg-chip hover:bg-hover text-xs text-content transition-colors"
                    onClick={() => void onPauseResume(task)}
                  >
                    {t('暂停')}
                  </button>
                )}
                {(task.status === 'paused' || task.status === 'waiting' || task.status === 'error') && (
                  <button
                    type="button"
                    className="px-2 py-1 rounded bg-chip hover:bg-hover text-xs text-content transition-colors"
                    onClick={() => void onPauseResume(task)}
                  >
                    {t('继续')}
                  </button>
                )}
                <button
                  type="button"
                  aria-label={t('删除下载任务')}
                  className="p-1.5 rounded bg-chip hover:bg-hover text-content transition-colors"
                  onClick={() => void onCancel(task)}
                >
                  <Icon name="close" className="w-4 h-4" />
                </button>
              </div>
            </div>
            {(task.status === 'downloading' || task.status === 'paused' || task.status === 'completed') && task.total > 0 && (
              <div className="h-1.5 rounded-full bg-chip overflow-hidden">
                <div
                  className="h-full bg-accent transition-all"
                  style={{ width: `${task.total > 0 ? Math.min(100, Math.round((task.finished / task.total) * 100)) : 0}%` }}
                />
              </div>
            )}
          </div>
        ))}
      </div>
    </Drawer>
  );
}

/** 播放页等处调用：把一集加入下载队列（必须在用户手势内调用） */
export function enqueueDownload(payload: AddDownloadPayload): void {
  window.dispatchEvent(new CustomEvent(ADD_TASK_EVENT, { detail: payload }));
}

/** header 等处调用：打开下载管理器 */
export function requestShowDownloadManager(): void {
  window.dispatchEvent(new CustomEvent(SHOW_MANAGER_EVENT));
}

/** 全局挂载点：根布局渲染一次，监听打开事件 */
export function GlobalDownloadManager() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onShow = () => setOpen(true);
    window.addEventListener(SHOW_MANAGER_EVENT, onShow);
    return () => window.removeEventListener(SHOW_MANAGER_EVENT, onShow);
  }, []);
  return <DownloadManager isOpen={open} onClose={() => setOpen(false)} />;
}

