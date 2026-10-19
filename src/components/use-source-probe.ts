'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client-api';
import { useAppStore } from '@/lib/store';
import type { SourceSearchOutcome } from '@/lib/types';
import { tr } from '@/lib/i18n-core';

/**
 * 点播源批量探活 hook：
 * - 受控并发（点播源上限 100，并发 4 足够快且不会同时压垮多个源站）；
 * - 进度实时回传（已完成 / 总数 / 可用数），可随时中止（已完成结果保留）；
 * - 结果写入 store 的 sourceHealth，与搜索过程共用同一份健康度模型
 *   （因此连续失败达阈值会临时停用，与搜索行为一致，不再出现两套「健康度」）。
 */

/** 同时在途的探测数 */
const CONCURRENCY = 4;

export interface SourceProbeProgress {
  done: number;
  total: number;
  /** 已完成中可用的数量（能返回搜索结果） */
  ok: number;
  /** 本轮开始时间（用于估算剩余时间） */
  startedAt: number;
}

export function useSourceProbe() {
  const [progress, setProgress] = useState<SourceProbeProgress | null>(null);
  const runIdRef = useRef(0);

  useEffect(
    () => () => {
      // 卸载时作废在途轮次，避免结果写回已卸载组件的状态
      runIdRef.current++;
    },
    []
  );

  /** 中止在途测活：已完成的结果保留 */
  const cancel = useCallback(() => {
    runIdRef.current++;
    setProgress(null);
  }, []);

  const probe = useCallback(async (sources: { key: string; url: string }[]) => {
    if (sources.length === 0) return;
    const runId = ++runIdRef.current;
    const total = sources.length;
    const startedAt = Date.now();
    setProgress({ done: 0, total, ok: 0, startedAt });

    const outcomes: SourceSearchOutcome[] = [];
    let done = 0;
    let okCount = 0;
    let cursor = 0;
    // 进度写回节流：批量测活结果密集到达，避免每个源都触发一次渲染
    let lastFlush = 0;
    const flush = (force = false) => {
      const now = Date.now();
      if (!force && now - lastFlush < 150) return;
      lastFlush = now;
      setProgress({ done, total, ok: okCount, startedAt });
    };

    const worker = async () => {
      for (;;) {
        if (runIdRef.current !== runId) return;
        const index = cursor++;
        if (index >= sources.length) return;
        const source = sources[index];
        let outcome: SourceSearchOutcome;
        try {
          const r = await api.testSource(source.url);
          outcome = { sourceKey: source.key, ok: r.ok, ms: r.ms, error: r.error, list: [] };
        } catch (err) {
          outcome = {
            sourceKey: source.key,
            ok: false,
            error: err instanceof Error ? err.message : tr('测试失败'),
            list: [],
          };
        }
        if (runIdRef.current !== runId) return;
        outcomes.push(outcome);
        done++;
        if (outcome.ok) okCount++;
        flush();
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sources.length) }, worker));
    if (runIdRef.current !== runId) return undefined;
    useAppStore.getState().recordSourceHealth(outcomes);
    setProgress(null);
    // 返回汇总供调用方提示；被取消时返回 undefined
    return { total, ok: okCount };
  }, []);

  return { progress, probe, cancel, isProbing: progress !== null };
}
