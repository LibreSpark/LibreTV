'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/client-api';
import { QUALITY_FAIL_TTL_MS, isRetryableTimeout, qualityKey, summarizeQuality } from '@/lib/quality';
import { createProbeQueue, type ProbeQueue } from '@/lib/quality-probe-queue';
import { readQualities, useAppStore } from '@/lib/store';
import type { QualityEntry, QualityProbeItem, QualityProbeResult, SourceConfig } from '@/lib/types';
import { tr } from '@/lib/i18n-core';

/** 探测目标：搜索结果条目里与画质相关的最小字段集 */
export interface QualityProbeTarget {
  sourceKey: string;
  vodId: string;
  /** 源配置缺失时的兜底地址（搜索结果自带）；缺 detail，走不了详情页降级 */
  sourceUrl?: string;
  sourceName?: string;
}

export interface QualityProbeProgress {
  /** 本轮目标数 */
  total: number;
  /** 已拿到终态（有档位 / 未知 / 失败）的数量 */
  done: number;
  /** 拿到分辨率的数量 */
  known: number;
  /** 探测失败的数量 */
  failed: number;
  /** 已探到的最高档位 */
  best?: string;
}

/**
 * 单源卡片的探测必须共用同一个队列：每张卡片各建一个队列等于没有限流。
 * 队列只在浏览器里跑，模块级单例足够（SSR 不会调用 push）。
 */
let sharedQueue: ProbeQueue | null = null;
function getSharedQueue(): ProbeQueue {
  sharedQueue ??= createProbeQueue({
    run: (items, onResult, signal) => api.qualityProbeStream(items, onResult, signal),
  });
  return sharedQueue;
}

const toEntry = (result: QualityProbeResult): QualityEntry => ({
  height: result.height,
  from: 'probe',
  error: result.error,
  timestamp: Date.now(),
});

const dedupeByKey = (items: QualityProbeTarget[]): QualityProbeTarget[] => {
  const seen = new Set<string>();
  const out: QualityProbeTarget[] = [];
  for (const item of items) {
    const key = qualityKey(item.sourceKey, item.vodId);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
};

/**
 * 画质探测控制器。
 *
 * 三种入口共用同一份状态与冷却规则：
 * - `probe`：一次 POST 流式探测一批（多源卡片展开、换源面板）；
 * - `probeQueued`：交给全局队列（单源卡片进入视口），并发 2、每批 8 条；
 * - `retry`：绕过失败冷却重探（徽章点击）。
 *
 * 结果一律写回 `useAppStore.setQuality`，换页面/再次搜索时可复用（TTL 与 LRU 由 store 负责）。
 */
export function useQualityProbe(sources?: SourceConfig[]) {
  const [qualities, setQualities] = useState<Record<string, QualityEntry>>({});
  const [probing, setProbing] = useState<Record<string, true>>({});
  const [targets, setTargets] = useState<QualityProbeTarget[]>([]);

  /** 在飞键：防同一个键并发重复请求 */
  const inflightRef = useRef<Set<string>>(new Set());
  /** 拿到终态的时间：失败要冷却 QUALITY_FAIL_TTL_MS，成功的终态由缓存判断，不需要冷却 */
  const settledRef = useRef<Map<string, number>>(new Map());
  /** 当前直连批次：被下一批掐掉时靠它解锁未完成的键 */
  const batchRef = useRef<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);
  /** 交给全局队列、尚未返回的键：卸载时从队列里撤回 */
  const queuedRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);
  /**
   * probe 需要读最新的 qualities 判断「是否已有结论」，但把 qualities 放进依赖会让
   * probe 每次结果到达就换身份；调用方在 effect 里依赖 probe 时就会反复重跑
   * （每次 setQualities 都是新对象）。用 ref 读当前值，让 probe 保持稳定。
   */
  const qualitiesRef = useRef<Record<string, QualityEntry>>({});
  qualitiesRef.current = qualities;
  /** 已经自动重试过的键：超时只补一次，避免「超时→重试→超时」循环打源站 */
  const retriedRef = useRef<Set<string>>(new Set());
  /** 让延迟重试能拿到最新的 probe（probe 依赖 resolveItem，闭包会过期） */
  const probeRef = useRef<((items: QualityProbeTarget[], opts?: { force?: boolean }) => void) | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    // Set 实例只在首次渲染创建，捕获它就能在卸载时读到最新内容（避免 lint 的 ref 快照警告）
    const queued = queuedRef.current;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      if (queued.size > 0) getSharedQueue().cancel([...queued]);
      queued.clear();
    };
  }, []);

  const resolveItem = useCallback(
    (target: QualityProbeTarget): QualityProbeItem | undefined => {
      const source =
        sources?.find((s) => s.key === target.sourceKey) ??
        (target.sourceUrl
          ? ({
              key: target.sourceKey,
              name: target.sourceName ?? target.sourceKey,
              url: target.sourceUrl,
            } as SourceConfig)
          : undefined);
      return source ? { source, id: target.vodId } : undefined;
    },
    [sources]
  );

  const mark = useCallback((keys: string[], value: boolean) => {
    setProbing((prev) => {
      const next = { ...prev };
      for (const key of keys) {
        if (value) next[key] = true;
        else delete next[key];
      }
      return next;
    });
  }, []);

  /**
   * 超时自动补一次。
   * 失败里只有超时是「这次没够着」——冷启动、CDN 抖动、源站响应慢；
   * 同一条请求 300ms 后再打一次成功率明显更高，可避免把可用源标成「未测到」。
   * 只补一次：retriedRef 记住已重试的键，仍失败就交给用户手动重试。
   */
  const scheduleTimeoutRetry = useCallback(
    (collected: Record<string, QualityEntry>, targetByKey: Map<string, QualityProbeTarget>) => {
      const retries: QualityProbeTarget[] = [];
      for (const [key, entry] of Object.entries(collected)) {
        if (!isRetryableTimeout(entry.error)) continue;
        if (retriedRef.current.has(key)) continue;
        const target = targetByKey.get(key);
        if (!target) continue;
        retriedRef.current.add(key);
        retries.push(target);
      }
      if (retries.length === 0) return;
      setTimeout(() => {
        if (!mountedRef.current) return;
        probeRef.current?.(retries, { force: true });
      }, 300);
    },
    []
  );

  /** 读取缓存并把目标登记为「进度分母」：卡片收起时也能显示最高画质 */
  const prime = useCallback((items: QualityProbeTarget[]) => {
    const list = dedupeByKey(items);
    setTargets(list);
    if (list.length === 0) return;
    const cached = readQualities(list.map((i) => ({ sourceKey: i.sourceKey, vodId: i.vodId })));
    if (Object.keys(cached).length > 0) setQualities((prev) => ({ ...cached, ...prev }));
  }, []);

  const probe = useCallback(
    (items: QualityProbeTarget[], opts?: { force?: boolean }) => {
      const list = dedupeByKey(items);
      if (list.length === 0) return;
      setTargets(list);

      const cached = readQualities(list.map((i) => ({ sourceKey: i.sourceKey, vodId: i.vodId })));
      setQualities((prev) => ({ ...cached, ...prev }));

      const force = opts?.force === true;
      const now = Date.now();
      const pending = list.filter((target) => {
        const key = qualityKey(target.sourceKey, target.vodId);
        if (inflightRef.current.has(key)) return false;
        if (force) return true;
        const known = cached[key] ?? qualitiesRef.current[key];
        // 已有结论（含「测不出」）是终态，重探还是同一个结果
        if (known && !known.error) return false;
        const last = settledRef.current.get(key);
        return last === undefined || now - last > QUALITY_FAIL_TTL_MS;
      });

      // 没有新要探的键：让上一批跑完，不打断它
      if (pending.length === 0) return;

      // 掐掉上一批并同步解锁：否则这些键既不在飞、又因 inflight 选不进本批，徽章会一直空着
      const previous = batchRef.current;
      if (previous.size > 0) {
        for (const key of previous) inflightRef.current.delete(key);
        mark([...previous], false);
      }
      batchRef.current.clear();
      abortRef.current?.abort();

      const mapped = pending
        .map((target) => {
          const item = resolveItem(target);
          return item ? { key: qualityKey(target.sourceKey, target.vodId), item } : undefined;
        })
        .filter((v): v is { key: string; item: QualityProbeItem } => Boolean(v));
      if (mapped.length === 0) return;

      const keys = mapped.map((m) => m.key);
      const targetByKey = new Map(list.map((t) => [qualityKey(t.sourceKey, t.vodId), t]));
      const batch = new Set(keys);
      // 结果先攒着，流结束一次性写全局：逐条写会让 persist 把整个 qualityMap（最多 400 条）序列化十几遍
      const collected: Record<string, QualityEntry> = {};
      for (const key of keys) inflightRef.current.add(key);
      batchRef.current = batch;
      mark(keys, true);

      const controller = new AbortController();
      abortRef.current = controller;

      api
        .qualityProbeStream(
          mapped.map((m) => m.item),
          (result) => {
            const key = qualityKey(result.sourceKey, result.vodId);
            const entry = toEntry(result);
            setQualities((prev) => ({ ...prev, [key]: entry }));
            collected[key] = entry;
            inflightRef.current.delete(key);
            settledRef.current.set(key, Date.now());
            // 探成功就忘掉「已重试过」：下次再超时仍然值得补一次
            if (!entry.error) retriedRef.current.delete(key);
            mark([key], false);
          },
          controller.signal
        )
        .catch((err: unknown) => {
          // 主动中止（新批接管 / 组件卸载）不是探测结论，保持「未知」
          if (err instanceof DOMException && err.name === 'AbortError') return;
          // 未登录：登录框已弹出，把每个源都标成失败只会误导
          if (err instanceof ApiError && (err.status === 401 || err.status === 503)) return;
          // 传输层失败（网关拦截 / 容器重启 / 断网）：逐条落成失败结论，徽章上能看出原因。
          // 原先这里静默吞掉，界面只剩一片「未测到」，线上无从判断是哪一环挂了。
          const message = err instanceof Error && err.message ? err.message : tr('探测请求失败');
          const at = Date.now();
          for (const key of keys) {
            if (collected[key]) continue;
            collected[key] = { from: 'probe', error: message, timestamp: at };
            settledRef.current.set(key, at);
          }
          setQualities((prev) => ({ ...prev, ...collected }));
        })
        .finally(() => {
          if (Object.keys(collected).length > 0) useAppStore.getState().setQuality(collected);
          // 超时补一次放在接管守卫之前：结果已经拿到，是否被接管都不影响这一批的补探测
          scheduleTimeoutRetry(collected, targetByKey);
          // 被新一批接管时跳过清理：未完成的键已由新批同步段重新调度（finally 是 microtask，必然晚于它）
          if (batchRef.current !== batch) return;
          for (const key of batch) inflightRef.current.delete(key);
          batchRef.current.clear();
          mark(keys, false);
        });
    },
    [mark, resolveItem, scheduleTimeoutRetry]
  );
  // 延迟重试走的入口：scheduleTimeoutRetry 的定时器里不能直接用 probe（会捕获旧闭包）
  probeRef.current = probe;

  /**
   * 经全局队列探测（单源卡片进入视口）。
   * 不阻塞渲染、不打断直连批次：队列自己限并发，这里只负责把结果摊到本卡片上。
   */
  const probeQueued = useCallback(
    (items: QualityProbeTarget[]) => {
      const list = dedupeByKey(items);
      if (list.length === 0) return;
      setTargets(list);

      const cached = readQualities(list.map((i) => ({ sourceKey: i.sourceKey, vodId: i.vodId })));
      setQualities((prev) => ({ ...cached, ...prev }));

      const now = Date.now();
      const pending = list.filter((target) => {
        const key = qualityKey(target.sourceKey, target.vodId);
        if (inflightRef.current.has(key)) return false;
        const known = cached[key];
        if (known && !known.error) return false;
        const last = settledRef.current.get(key);
        return last === undefined || now - last > QUALITY_FAIL_TTL_MS;
      });

      const mapped = pending
        .map((target) => {
          const item = resolveItem(target);
          return item ? { key: qualityKey(target.sourceKey, target.vodId), item } : undefined;
        })
        .filter((v): v is { key: string; item: QualityProbeItem } => Boolean(v));
      if (mapped.length === 0) return;

      const keys = mapped.map((m) => m.key);
      for (const key of keys) {
        inflightRef.current.add(key);
        queuedRef.current.add(key);
      }

      void getSharedQueue()
        // 「探测中」在批次真正发出时才点亮：排队还没轮到就显示转圈是在说谎
        .push(mapped.map((m) => m.item), () => {
          if (mountedRef.current) mark(keys, true);
        })
        .then((results) => {
          const collected: Record<string, QualityEntry> = {};
          for (const result of Object.values(results)) {
            const key = qualityKey(result.sourceKey, result.vodId);
            collected[key] = toEntry(result);
            settledRef.current.set(key, Date.now());
          }
          // 「已取消」只说明我们没等，不是源站的回答：展示可以，但不该污染长期缓存
          const writable = Object.fromEntries(
            Object.entries(collected).filter(([, entry]) => entry.error !== '探测已取消')
          );
          if (mountedRef.current) setQualities((prev) => ({ ...prev, ...collected }));
          if (Object.keys(writable).length > 0) useAppStore.getState().setQuality(writable);
        })
        // 队列内部已兜住所有失败，这里只防意外异常变成 unhandled rejection
        .catch(() => {})
        .finally(() => {
          for (const key of keys) {
            inflightRef.current.delete(key);
            queuedRef.current.delete(key);
          }
          if (mountedRef.current) mark(keys, false);
        });
    },
    [mark, resolveItem]
  );

  /** 绕过失败冷却重探：只有用户明确点「重试」才走这里 */
  const retry = useCallback(
    (items: QualityProbeTarget[]) => {
      for (const item of items) settledRef.current.delete(qualityKey(item.sourceKey, item.vodId));
      probe(items, { force: true });
    },
    [probe]
  );

  const progress = useMemo<QualityProbeProgress>(() => {
    const entries = targets.map((t) => qualities[qualityKey(t.sourceKey, t.vodId)]);
    const summary = summarizeQuality(entries);
    return {
      total: targets.length,
      done: summary.total,
      known: summary.known,
      failed: summary.failed,
      best: summary.best,
    };
  }, [targets, qualities]);

  return { qualities, probing, progress, prime, probe, probeQueued, retry };
}
