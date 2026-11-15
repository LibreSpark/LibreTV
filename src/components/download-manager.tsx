'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Drawer } from './drawer';
import { useToast } from './toast';
import { db, type DownloadTaskEntry } from '@/lib/db';
import {
  PauseResumeController,
  clearDownloadChunks,
  runDownloadJob,
  runDirectDownloadJob,
  supportsChunkCache,
  type DownloadProgress,
} from '@/lib/m3u8-downloader';
import { loadDownloadSettings, saveDownloadSettings } from '@/lib/download-settings';
import { detectSavingCapability, pickSaveTarget, suggestDownloadFilename } from '@/lib/download-saver';
import { detectDownloadSourceFormat, recoverInterruptedDownloadStatus } from '@/lib/download-task-state';
import { Switch } from './settings-shared';

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
// De-duplicate the same browser event across overlapping manager mounts.
const handledAddEvents = new WeakSet<Event>();
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
}

type SaveTarget = import('@/lib/download-saver').SaveTarget;

function saveTargetRegistry(): Map<string, SaveTarget> {
  const host = globalThis as unknown as { __dlSaveTargets?: Map<string, SaveTarget> };
  if (!host.__dlSaveTargets) host.__dlSaveTargets = new Map();
  return host.__dlSaveTargets;
}

export function DownloadManager({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { toast } = useToast();
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

  // A reload destroys browser file handles and in-memory controllers. Mark stale active
  // tasks as paused so the user can explicitly reselect an output target and resume.
  useEffect(() => {
    let active = true;
    void db.downloads.toArray().then(async (entries) => {
      if (!active) return;
      const interrupted = entries.filter((entry) =>
        recoverInterruptedDownloadStatus(entry.status) === 'paused' && entry.status !== 'paused'
      );
      await Promise.all(interrupted.map((entry) => db.downloads.update(entry.id, {
        status: 'paused',
        errorMessage: '页面重新加载导致下载中断，请点击「继续」重新选择保存位置',
        updatedAt: Date.now(),
      })));
      if (active) refresh();
    }).catch((error) => {
      if (active) toast('恢复下载任务失败：' + (error instanceof Error ? error.message : String(error)), 'error');
    });
    return () => { active = false; };
  }, [refresh, toast]);

  // 下载设置在挂载时读取：抽屉关闭时 header / 播放页也会派发入队事件，
  // 若只在打开抽屉时才读，关闭状态下加入的任务会漏掉用户的中转偏好
  useEffect(() => {
    setProxy(loadDownloadSettings().proxy);
  }, []);

  // —— 任务启动：选目标 → runDownloadJob ——
  const startTask = useCallback(
    async (entry: DownloadTaskEntry) => {
      if (running.current.has(entry.id)) return;
      const abort = new AbortController();
      const pause = new PauseResumeController();
      running.current.set(entry.id, { abort, pause });
      await updateEntry(entry.id, { status: 'validating', errorMessage: undefined });

      // 进度：UI 走本地 state 实时刷新，落库按固定间隔节流。整集动辄上千分片，
      // 逐片 updateEntry（写库 + 全量查询 + setState）会让页面越下越卡，
      // 极端情况下长任务被浏览器判定为无响应
      let lastPersistAt = 0;
      const onProgress = (p: DownloadProgress) => {
        const status = p.status === 'done' ? 'completed' : p.status === 'error' ? 'failed' : p.status;
        setTasks((prev) => prev.map((t) => (t.id === entry.id ? { ...t, finished: p.current, total: p.total, status, errorMessage: p.message } : t)));
        const now = Date.now();
        // 状态切换（完成/失败/处理中）必须立刻持久化，纯进度才节流
        if (p.status === 'downloading' && now - lastPersistAt < PROGRESS_PERSIST_INTERVAL_MS) return;
        lastPersistAt = now;
        void db.downloads.update(entry.id, { finished: p.current, total: p.total, status, errorMessage: p.message, updatedAt: now });
      };

      const jobOptions = {
        taskId: entry.id,
        url: entry.url,
        title: entry.title,
        format: entry.format,
        signal: abort.signal,
        pause,
        // 中转开关只作用于 HLS；直链下载遵循浏览器 CORS 策略，不伪造跨域代理能力
        proxy,
        onProgress,
        // 刷新恢复后必须由用户重新选择保存位置
        target: saveTargetRegistry().get(entry.id) ?? {
          kind: 'memory' as const,
          write: async () => { throw new Error('保存位置已失效，请点击「继续」重新选择'); },
          close: async () => {},
          abort: async () => {},
        },
      };
      const job = entry.sourceFormat === 'HLS'
        ? runDownloadJob(jobOptions)
        : runDirectDownloadJob(jobOptions);

      void job
        .then(async () => {
          if (abort.signal.aborted) return;
          await updateEntry(entry.id, { status: 'completed', errorMessage: undefined });
          void clearDownloadChunks(entry.id);
          toast(`《${entry.title}》下载完成`, 'success');
        })
        .catch(async (err: Error) => {
          if (abort.signal.aborted) return; // 用户取消：状态已在取消处理里写好
          // 任一下载/解密/合并/写盘失败都要中止保存流，不能遗留半开文件或部分文件。
          const target = saveTargetRegistry().get(entry.id);
          if (target) {
            try { await target.abort(); } catch { /* ignore secondary abort failure */ }
          }
          const latest = await db.downloads.get(entry.id);
          const message = err instanceof Error ? err.message : String(err);
          await updateEntry(entry.id, { status: 'failed', errorMessage: message, errorNum: (latest?.errorNum ?? entry.errorNum) + 1 });
          toast(`《${entry.title}》下载失败：${message}`, 'error');
        })
        .finally(() => {
          saveTargetRegistry().delete(entry.id);
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
      const targets = saveTargetRegistry();
      // A file handle cannot survive refresh. Do not auto-run a recovered task into
      // the intentionally failing placeholder target; wait for the user's re-pick gesture.
      const waiting = all.filter((t) => (t.status === 'queued' || t.status === 'waiting') && !running.current.has(t.id) && targets.has(t.id));
      for (const t of waiting.slice(0, MAX_CONCURRENT_DOWNLOADS - runningCount)) {
        const entry = t;
        // 队列恢复的任务没有保存目标：以内存目标启动（分片已在本地，写出快）
        void startTask({ ...entry, format: entry.format });
      }
    })();
  }, [startTask]);

  // —— 事件：新增任务（用户手势内触发，可安全弹文件选择器） ——
  // 监听器必须常驻：播放页「下载本集」在抽屉关闭时也会派发事件，
  // 若仅 isOpen 时注册，事件会凭空丢失——toast 提示了入队，实际什么都没发生
  useEffect(() => {
    const onAdd = (e: Event) => {
      // The global manager can be mounted twice briefly during React/route
      // lifecycle transitions. One dispatched Event must create exactly one
      // persistent task even if more than one listener observes it.
      if (handledAddEvents.has(e)) return;
      handledAddEvents.add(e);
      const detail = (e as CustomEvent<AddDownloadPayload>).detail;
      if (!detail?.url || !detail?.title) return;
      // 无 Cache Storage 时 runDownloadJob 会自动退化为串行边下边写：
      // 不支持断点缓存，但仍可完成下载；不要在入队阶段错误拦截。
      void (async () => {
        const format = detail.format ?? 'MP4';
        const sourceFormat = detectDownloadSourceFormat(detail.url);
        const id = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const entry: DownloadTaskEntry = {
          id,
          url: detail.url,
          title: detail.title,
          format,
          sourceFormat,
          status: 'queued',
          finished: 0,
          total: 0,
          errorNum: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        // 用户手势内预选保存目标（FS Access 弹窗必须在手势内）
        try {
          const target = await pickSaveTarget(suggestDownloadFilename(detail.title, detail.url));
          saveTargetRegistry().set(id, target);
        } catch (err) {
          if (err instanceof Error && err.message.includes('取消')) {
            toast('已取消下载', 'info');
          } else {
            toast('无法创建下载文件：' + (err instanceof Error ? err.message : String(err)), 'error');
          }
          return;
        }
        try {
          await db.downloads.put(entry);
          refresh();
          scheduleNext();
          toast(`《${detail.title}》已加入下载队列`, 'success');
        } catch (err) {
          const target = saveTargetRegistry().get(id);
          if (target) {
            try { await target.abort(); } catch { /* ignore cleanup failure */ }
            saveTargetRegistry().delete(id);
          }
          toast('无法创建下载任务：' + (err instanceof Error ? err.message : String(err)), 'error');
        }
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
      next ? '已开启下载中转，新任务经服务器转发' : '已关闭下载中转，新任务直连源站',
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
    if (handle && entry.status === 'paused') {
      handle.pause.resume();
      await updateEntry(entry.id, { status: 'downloading' });
      return;
    }
    if (entry.status === 'paused' || entry.status === 'queued' || entry.status === 'waiting' || entry.status === 'failed' || entry.status === 'error') {
      // 恢复：需要用户手势内重选保存目标（浏览器限制）
      try {
        const target = await pickSaveTarget(suggestDownloadFilename(entry.title, entry.url));
        saveTargetRegistry().set(entry.id, target);
        if (running.current.has(entry.id)) return;
        await updateEntry(entry.id, { status: 'queued', errorMessage: undefined });
        scheduleNext();
      } catch (err) {
        if (err instanceof Error && err.message.includes('取消')) toast('已取消', 'info');
      }
      return;
    }
    void handle; // downloading 且无 handle：状态漂移，等待调度器自愈
  };

  const onCancel = async (entry: DownloadTaskEntry) => {
    const handle = running.current.get(entry.id);
    if (handle) {
      handle.abort.abort();
      handle.pause.destroy();
      running.current.delete(entry.id);
    }
    const target = saveTargetRegistry().get(entry.id);
    if (target) {
      try { await target.abort(); } catch { /* already closed or unavailable */ }
      saveTargetRegistry().delete(entry.id);
    }
    await clearDownloadChunks(entry.id);
    if (entry.status === 'completed' || entry.status === 'failed' || entry.status === 'error' || entry.status === 'cancelled') {
      await db.downloads.delete(entry.id);
      toast(`《${entry.title}》已删除下载记录`, 'info');
    } else {
      await updateEntry(entry.id, { status: 'cancelled', errorMessage: undefined });
      toast(`《${entry.title}》已取消下载`, 'info');
    }
    refresh();
    scheduleNext();
  };

  const statusLabel: Record<DownloadTaskEntry['status'], string> = {
    queued: '排队中',
    waiting: '排队中',
    validating: '校验资源中',
    downloading: '下载中',
    merging: '合并文件中',
    paused: '已暂停',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
    error: '失败',
  };

  return (
    <Drawer open={isOpen} onClose={onClose} title="下载管理" width="max-w-lg">
      <div className="space-y-3">
        <div className="card p-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-content">经服务器中转下载</p>
            <p className="text-xs text-faint">
              直连被跨域 / 防盗链 / 混合内容拦下时开启：整集流量（含分片与密钥）经服务器转发，
              带宽由部署者承担。仅对之后开始的任务生效。
            </p>
          </div>
          <Switch checked={proxy} onChange={onToggleProxy} label="经服务器中转下载" />
        </div>
        <p className="text-xs text-faint">
          保存能力：{capability === 'fs-access' ? '磁盘直写（边下边存）' : '内存聚合（完成后浏览器下载）'}
          {chunkCache ? ' · 支持断点续传' : ' · 当前环境无断点缓存（需 HTTPS 访问）'} ·
          同时进行 {Math.min(running.current.size, MAX_CONCURRENT_DOWNLOADS)}/{MAX_CONCURRENT_DOWNLOADS} 个任务
        </p>
        {tasks.length === 0 && (
          <div className="py-10 text-center text-sm text-faint">
            暂无下载任务。在播放页点击「下载本集」开始。
          </div>
        )}
        {tasks.map((t) => (
          <div key={t.id} className="card p-3 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm text-content truncate">{t.title}</p>
                <p className="text-xs text-faint">
                  {t.sourceFormat ?? 'MEDIA'} → {t.sourceFormat === 'HLS' ? t.format.toUpperCase() : '原文件'} · {statusLabel[t.status]}
                  {(t.status === 'downloading' || t.status === 'merging') && t.total > 0
                    ? t.sourceFormat === 'HLS'
                      ? ` · ${t.finished}/${t.total} 分片`
                      : ` · ${(t.finished / 1024 / 1024).toFixed(1)}/${(t.total / 1024 / 1024).toFixed(1)} MB`
                    : t.status === 'downloading' && t.sourceFormat !== 'HLS' && t.finished > 0
                      ? ` · 已接收 ${(t.finished / 1024 / 1024).toFixed(1)} MB`
                      : ''}
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {t.status === 'downloading' && (
                  <button
                    type="button"
                    className="px-2 py-1 rounded bg-chip hover:bg-hover text-xs text-content transition-colors"
                    onClick={() => void onPauseResume(t)}
                  >
                    暂停
                  </button>
                )}
                {(t.status === 'paused' || t.status === 'queued' || t.status === 'waiting' || t.status === 'failed' || t.status === 'error') && (
                  <button
                    type="button"
                    className="px-2 py-1 rounded bg-chip hover:bg-hover text-xs text-content transition-colors"
                    onClick={() => void onPauseResume(t)}
                  >
                    继续
                  </button>
                )}
                <button
                  type="button"
                  aria-label={t.status === 'completed' || t.status === 'failed' || t.status === 'error' || t.status === 'cancelled' ? '删除下载任务' : '取消下载任务'}
                  className="p-1.5 rounded bg-chip hover:bg-hover text-content transition-colors"
                  onClick={() => void onCancel(t)}
                >
                  {t.status === 'completed' || t.status === 'failed' || t.status === 'error' || t.status === 'cancelled' ? '删除' : '取消'}
                </button>
              </div>
            </div>
            {t.errorMessage && (t.status === 'failed' || t.status === 'error') && (
              <p className="text-xs text-red-400" role="alert">{t.errorMessage}</p>
            )}
            {(t.status === 'downloading' || t.status === 'merging' || t.status === 'paused' || t.status === 'completed') && t.total > 0 && (
              <div className="h-1.5 rounded-full bg-chip overflow-hidden">
                <div
                  className="h-full bg-accent transition-all"
                  style={{ width: `${t.total > 0 ? Math.min(100, Math.round((t.finished / t.total) * 100)) : 0}%` }}
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
    Object.assign(window, { __LIBRETV_DOWNLOAD_MANAGER_READY__: true });
    window.dispatchEvent(new Event('libretv:download-manager-ready'));
    return () => {
      window.removeEventListener(SHOW_MANAGER_EVENT, onShow);
    };
  }, []);
  return <DownloadManager isOpen={open} onClose={() => setOpen(false)} />;
}

