'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { PlayerShell } from '@/components/player-shell';

type Batch = {
  batch_id: string;
  goal: string;
  total: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  active: number;
  running: number;
  queued: number;
  paused: number;
  retries: number;
  candidate_count: number;
  media_probe_bytes: number;
  media_probe_budget_bytes: number;
  created_at: string;
};

type BatchSummary = {
  total: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  paused: number;
  running: number;
  queued: number;
  active: number;
  retries: number;
  candidate_count: number;
  batch_count: number;
  media_probe_bytes: number;
  media_probe_budget_bytes: number;
};

type Candidate = {
  candidate_id: string;
  source_url: string;
  title: string;
  media_url?: string | null;
  media_type?: string | null;
  status: string;
  quality_json?: Record<string, unknown> | null;
  playback_json?: Record<string, unknown> | null;
  created_at?: string;
};

type Rule = {
  rule_id: string;
  source_origin: string;
  page_url: string;
  goal: string;
  mode: string;
  selector: string;
  rationale: string;
  status: 'tested' | 'active' | 'disabled';
  version: number;
  test_json?: { match_count?: number; sample_values?: string[]; verification_level?: string };
};

type BatchTask = {
  task_index: number;
  workflow_id: string;
  target_url: string;
  status: string;
  completed_nodes: number;
  total_nodes: number;
  attempts: number;
};

type BatchEvent = {
  id: number;
  workflow_id?: string | null;
  task_index?: number | null;
  type: string;
  payload?: Record<string, unknown>;
  created_at?: string;
};

const initialSummary: BatchSummary = {
  total: 0, succeeded: 0, failed: 0, cancelled: 0, paused: 0,
  running: 0, queued: 0, active: 0, retries: 0, candidate_count: 0, batch_count: 0,
  media_probe_bytes: 0, media_probe_budget_bytes: 0,
};

async function requestJson(path: string, init?: RequestInit) {
  const response = await fetch(path, { cache: 'no-store', ...init });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || payload.detail || `请求失败（${response.status}）`);
  }
  return payload;
}

function mediaFormat(candidate: Candidate): 'hls' | 'mp4' | 'webm' | null {
  if (candidate.media_type === 'hls') return 'hls';
  if (candidate.media_type !== 'file' || !candidate.media_url) return null;
  try {
    const extension = new URL(candidate.media_url).pathname.toLowerCase().split('.').pop();
    return extension === 'mp4' || extension === 'webm' ? extension : null;
  } catch {
    return null;
  }
}

function shownBytes(value: number) {
  if (value <= 0) return '0 B';
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function shownTime(value?: string) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

export function IntelligentCollectorPanel() {
  const [summary, setSummary] = useState<BatchSummary>(initialSummary);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [batchDetails, setBatchDetails] = useState<Record<string, BatchTask[]>>({});
  const [batchOffsets, setBatchOffsets] = useState<Record<string, number>>({});
  const [events, setEvents] = useState<Record<string, BatchEvent[]>>({});
  const [eventCursors, setEventCursors] = useState<Record<string, number>>({});
  const [eventHasMore, setEventHasMore] = useState<Record<string, boolean>>({});
  const [targetsText, setTargetsText] = useState('');
  const [goal, setGoal] = useState('发现同站点内公开可访问的影视目录与媒体候选');
  const [expandedBatch, setExpandedBatch] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [pendingFingerprint, setPendingFingerprint] = useState('');
  const [pendingIdempotencyKey, setPendingIdempotencyKey] = useState('');
  const [pendingStart, setPendingStart] = useState<number | null>(null);

  const targets = useMemo(
    () => targetsText.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
    [targetsText],
  );

  const refresh = useCallback(async () => {
    const results = await Promise.allSettled([
      requestJson('/api/resource-collector/batches/summary'),
      requestJson('/api/resource-collector/batches?limit=20'),
      requestJson('/api/resource-collector/candidates?status=pending_review&limit=100'),
      requestJson('/api/resource-collector/rules?limit=100'),
    ]);
    if (results[0].status === 'fulfilled') setSummary(results[0].value.summary ?? initialSummary);
    if (results[1].status === 'fulfilled') setBatches(results[1].value.batches ?? []);
    if (results[2].status === 'fulfilled') setCandidates(results[2].value.candidates ?? []);
    if (results[3].status === 'fulfilled') setRules(results[3].value.rules ?? []);
    const failure = results.find((result) => result.status === 'rejected');
    setError(failure?.status === 'rejected'
      ? failure.reason instanceof Error
        ? failure.reason.message
        : '智能采集服务暂时不可用。'
      : '');
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function submitBatch() {
    if (targets.length < 1 || targets.length > 1000) {
      setError('请提供 1 至 1,000 个网址，每行一个。');
      return;
    }
    const fingerprint = `${goal.trim()}\n${targets.join('\n')}`;
    const key = fingerprint === pendingFingerprint && pendingIdempotencyKey
      ? pendingIdempotencyKey
      : crypto.randomUUID().replaceAll('-', '');
    setPendingFingerprint(fingerprint);
    setPendingIdempotencyKey(key);
    setBusy('batch');
    setError('');
    setNotice('');
    try {
      const result = await requestJson('/api/resource-collector/batches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify({ urls: targets, goal: goal.trim() }),
      });
      const total = result.batch?.total ?? targets.length;
      setNotice(`${result.created === false ? '已恢复上次提交结果' : '已创建'} ${total} 个独立任务；任务进入持久队列，不会并发请求 1,000 个站点。`);
      setTargetsText('');
      setPendingFingerprint('');
      setPendingIdempotencyKey('');
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法提交任务批次。');
    } finally {
      setBusy('');
    }
  }

  async function loadBatchPage(batchId: string, offset: number) {
    const safeOffset = Math.max(offset, 0);
    setBatchOffsets((current) => ({ ...current, [batchId]: safeOffset }));
    try {
      const result = await requestJson(`/api/resource-collector/batches/${batchId}?limit=25&offset=${safeOffset}`);
      setBatchDetails((current) => ({ ...current, [batchId]: result.batch?.tasks ?? [] }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '读取批次详情失败。');
    }
  }

  async function loadBatch(batchId: string) {
    const next = expandedBatch === batchId ? '' : batchId;
    setExpandedBatch(next);
    if (next) await loadBatchPage(batchId, 0);
  }

  async function loadEvents(batchId: string, after = 0) {
    try {
      const result = await requestJson(`/api/resource-collector/batches/${batchId}/events?after=${after}&limit=100`);
      const page = result.events ?? [];
      setEvents((current) => ({
        ...current,
        [batchId]: after === 0 ? page : [...(current[batchId] ?? []), ...page],
      }));
      setEventCursors((current) => ({ ...current, [batchId]: result.next_after ?? after }));
      setEventHasMore((current) => ({ ...current, [batchId]: page.length === 100 }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '读取事件记录失败。');
    }
  }

  async function retryBatch(batchId: string) {
    setBusy(`retry:${batchId}`);
    setError('');
    try {
      const result = await requestJson(`/api/resource-collector/batches/${batchId}/retry`, { method: 'POST' });
      setNotice(`已重新排队 ${result.requeued ?? 0} 个失败任务。`);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '重试失败。');
    } finally {
      setBusy('');
    }
  }

  async function reviewCandidate(candidateId: string, decision: 'approved' | 'rejected') {
    setBusy(`review:${candidateId}`);
    setError('');
    try {
      await requestJson(`/api/resource-collector/candidates/${candidateId}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, note: decision === 'approved' ? '人工检查通过' : '人工检查拒绝' }),
      });
      setNotice(decision === 'approved' ? '已人工批准并原子发布到正式资源库。' : '已拒绝该候选，未发布。');
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '候选审核失败。');
    } finally {
      setBusy('');
    }
  }

  async function setRuleStatus(rule: Rule, status: 'activate' | 'disable') {
    setBusy(`rule:${rule.rule_id}`);
    setError('');
    try {
      await requestJson(`/api/resource-collector/rules/${rule.rule_id}/${status}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: status === 'activate' ? '人工检查通过' : '人工停用' }),
      });
      setNotice(status === 'activate' ? '规则已人工启用。' : '规则已人工停用。');
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '规则操作失败。');
    } finally {
      setBusy('');
    }
  }

  async function recordPlayback(candidate: Candidate, evidence: Record<string, unknown>) {
    if (!candidate.media_url) return;
    setBusy(`playback:${candidate.candidate_id}`);
    try {
      const result = await requestJson(`/api/resource-collector/candidates/${candidate.candidate_id}/playback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          media_type: evidence.mediaType,
          observed_seconds: evidence.observedSeconds,
          progressed_seconds: evidence.progressedSeconds,
          decoded_width: evidence.decodedWidth,
          decoded_height: evidence.decodedHeight,
          selected_rendition_height: evidence.selectedRenditionHeight ?? 0,
          selected_rendition_bitrate_kbps: evidence.selectedRenditionBitrateKbps ?? 0,
        }),
      });
      if (result.playback_confirmed) setNotice('已记录播放器的真实解码与时间轴进度证据。');
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '播放器验收证据保存失败。');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="space-y-8">
      {error ? <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-600">{error}</div> : null}
      {notice ? <div role="status" className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-700">{notice}</div> : null}

      <section className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">千级持久化任务批次</h2>
            <p className="mt-1 max-w-3xl text-sm text-[var(--muted)]">一次最多创建 1,000 个独立工作流。Worker 数量与站点级限速决定实际并发；同站点默认串行并带退避/熔断，不会同时向 1,000 个站点发请求。</p>
          </div>
          <span className="rounded-full border border-[var(--border)] px-3 py-1 text-xs">每批最多 1,000 项</span>
        </div>
        <textarea value={targetsText} onChange={(event) => setTargetsText(event.target.value)} rows={7}
          aria-label="采集网址，每行一个" placeholder={'https://example.com/catalog\nhttps://another.example/list'}
          className="mt-4 w-full rounded-xl border border-[var(--border)] bg-transparent px-3 py-3 font-mono text-xs leading-6" />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--muted)]">
          <span>{targets.length.toLocaleString()} / 1,000 个非空网址</span>
          <span>每个网址只接受公开 HTTP(S)；拒绝私网、登录、付费墙、DRM 与其他访问控制绕过。</span>
        </div>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row">
          <input value={goal} onChange={(event) => setGoal(event.target.value.slice(0, 200))} maxLength={200}
            aria-label="采集目标" className="min-w-0 flex-1 rounded-xl border border-[var(--border)] bg-transparent px-3 py-3 text-sm" />
          <button type="button" onClick={() => void submitBatch()} disabled={busy === 'batch' || targets.length === 0 || targets.length > 1000}
            className="rounded-xl bg-[var(--accent)] px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">
            {busy === 'batch' ? '正在创建任务…' : `创建 ${targets.length || ''} 个任务`}
          </button>
        </div>
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div><h2 className="text-lg font-semibold">全部批次统计</h2><p className="mt-1 text-sm text-[var(--muted)]">总量来自数据库全表统计；下方每个批次的计数包含该批次全部任务，不只显示最近 30 条。</p></div>
          <span className="text-xs text-[var(--muted)]">{summary.batch_count.toLocaleString()} 个批次</span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
          {[
            ['任务总数', summary.total], ['排队中', summary.queued], ['运行中', summary.running],
            ['成功 / 失败', `${summary.succeeded} / ${summary.failed}`],             ['重试 / 候选', `${summary.retries} / ${summary.candidate_count}`],
            ['媒体探测用量', `${shownBytes(summary.media_probe_bytes)} / ${shownBytes(summary.media_probe_budget_bytes)}`],
          ].map(([label, value]) => <div key={String(label)} className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4">
            <p className="text-xs text-[var(--muted)]">{label}</p><p className="mt-2 text-2xl font-semibold">{value}</p>
          </div>)}
        </div>
        <div className="mt-4 space-y-3">
          {batches.length === 0 ? <p className="rounded-xl border border-[var(--border)] p-5 text-center text-sm text-[var(--muted)]">尚无智能任务批次。</p> : batches.map((batch) => (
            <article key={batch.batch_id} className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold">{batch.goal}</p>
                  <p className="mt-1 break-all font-mono text-[11px] text-[var(--muted)]">{batch.batch_id} · {shownTime(batch.created_at)}</p>
                  <p className="mt-2 text-sm">{batch.total.toLocaleString()} 项 · 排队 {batch.queued} · 运行 {batch.running} · 成功 {batch.succeeded} · 失败 {batch.failed} · 重试 {batch.retries} · 候选 {batch.candidate_count} · 媒体探测 {shownBytes(batch.media_probe_bytes)} / {shownBytes(batch.media_probe_budget_bytes)}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => void loadBatch(batch.batch_id)} className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs">{expandedBatch === batch.batch_id ? '收起' : '查看任务'}</button>
                  <button type="button" onClick={() => void loadEvents(batch.batch_id)} className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs">重放事件</button>
                  {batch.failed > 0 ? <button type="button" onClick={() => void retryBatch(batch.batch_id)} disabled={Boolean(busy)} className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs disabled:opacity-50">重试失败项</button> : null}
                </div>
              </div>
              {expandedBatch === batch.batch_id ? <div className="mt-3 overflow-hidden rounded-xl border border-[var(--border)]">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[680px] text-left text-xs"><thead><tr className="border-b border-[var(--border)] text-[var(--muted)]"><th className="p-2">序号</th><th className="p-2">状态</th><th className="p-2">节点</th><th className="p-2">尝试</th><th className="p-2">目标网址</th></tr></thead>
                    <tbody>{(batchDetails[batch.batch_id] ?? []).map((task) => <tr key={task.workflow_id} className="border-b border-[var(--border)] last:border-0"><td className="p-2">{task.task_index + 1}</td><td className="p-2">{task.status}</td><td className="p-2">{task.completed_nodes}/{task.total_nodes}</td><td className="p-2">{task.attempts}</td><td className="max-w-[360px] truncate p-2 font-mono">{task.target_url}</td></tr>)}</tbody></table>
                </div>
                <div className="flex items-center justify-between gap-3 border-t border-[var(--border)] p-2 text-xs text-[var(--muted)]">
                  <span>显示 {(batchDetails[batch.batch_id]?.length ?? 0) ? (batchOffsets[batch.batch_id] ?? 0) + 1 : 0}–{(batchOffsets[batch.batch_id] ?? 0) + (batchDetails[batch.batch_id]?.length ?? 0)} / {batch.total.toLocaleString()}</span>
                  <div className="flex gap-2">
                    <button type="button" disabled={(batchOffsets[batch.batch_id] ?? 0) === 0} onClick={() => void loadBatchPage(batch.batch_id, Math.max(0, (batchOffsets[batch.batch_id] ?? 0) - 25))} className="rounded-lg border border-[var(--border)] px-3 py-1.5 disabled:opacity-40">上一页</button>
                    <button type="button" disabled={(batchOffsets[batch.batch_id] ?? 0) + 25 >= batch.total} onClick={() => void loadBatchPage(batch.batch_id, (batchOffsets[batch.batch_id] ?? 0) + 25)} className="rounded-lg border border-[var(--border)] px-3 py-1.5 disabled:opacity-40">下一页</button>
                  </div>
                </div>
              </div> : null}
              {events[batch.batch_id] ? <div className="mt-3 max-h-52 overflow-auto rounded-xl border border-[var(--border)] p-3">
                <p className="mb-2 text-xs font-semibold">持久事件记录（{events[batch.batch_id].length} 条）</p>
                <ul className="space-y-1 text-[11px] text-[var(--muted)]">{events[batch.batch_id].map((event) => <li key={event.id}>#{event.id} · {event.type} · 任务 {event.task_index == null ? '—' : event.task_index + 1} · {shownTime(event.created_at)}</li>)}</ul>
                {eventHasMore[batch.batch_id] ? <button type="button" onClick={() => void loadEvents(batch.batch_id, eventCursors[batch.batch_id] ?? 0)} className="mt-3 rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs">加载更多事件</button> : null}
              </div> : null}
            </article>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-5">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
          <div><h2 className="text-lg font-semibold">候选审核与正式发布</h2><p className="mt-1 text-sm text-[var(--muted)]">必须先通过质量报告和当前播放器的真实解码/进度验收，再由人工批准；拒绝时不会进入正式资源库。</p></div>
          <span className="text-xs text-[var(--muted)]">待审核 {candidates.length} 项</span>
        </div>
        {candidates.length === 0 ? <p className="py-5 text-center text-sm text-[var(--muted)]">没有待审核候选。</p> : <div className="space-y-4">
          {candidates.map((candidate) => {
            const format = mediaFormat(candidate);
            const playbackConfirmed = Number(candidate.playback_json?.progressed_seconds ?? 0) >= 2 &&
              Number(candidate.playback_json?.decoded_width ?? 0) > 0 && Number(candidate.playback_json?.decoded_height ?? 0) > 0;
            const quality = candidate.quality_json;
            const protectedMedia = quality?.protection_state === 'protected_or_encrypted';
            const protectionChecked = quality?.protection_state === 'none' || quality?.protection_state === 'none_detected';
            const qualityReady = Boolean(quality && protectionChecked && (
              (quality.decode_check as Record<string, unknown> | undefined)?.status === 'passed' ||
              quality.container === 'hls'
            ));
            return <article key={candidate.candidate_id} className="rounded-xl border border-[var(--border)] p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="font-semibold">{candidate.title || candidate.media_url || candidate.source_url}</h3>
                  <p className="mt-1 break-all font-mono text-[11px] text-[var(--muted)]">{candidate.source_url}</p>
                  <p className="mt-2 text-xs text-[var(--muted)]">类型：{candidate.media_type || '未识别'} · 质量：{String(quality?.quality_label ?? '尚无报告')} · 播放验收：{playbackConfirmed ? '已确认' : '未确认'}</p>
                  {quality?.verification_level ? <p className="mt-1 text-[11px] text-[var(--muted)]">证据等级：{String(quality.verification_level)}{quality?.decode_check ? ` · 抽帧解码 ${String((quality.decode_check as Record<string, unknown>).status)}` : ''}</p> : null}
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => void reviewCandidate(candidate.candidate_id, 'rejected')} disabled={Boolean(busy)} className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs disabled:opacity-50">拒绝</button>
                  <button type="button" onClick={() => void reviewCandidate(candidate.candidate_id, 'approved')} disabled={Boolean(busy) || !playbackConfirmed || !qualityReady || !format} className="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">人工批准并发布</button>
                </div>
              </div>
              {format && candidate.media_url && qualityReady && !protectedMedia ? <div className="mt-4 overflow-hidden rounded-xl border border-[var(--border)]">
                <PlayerShell url={candidate.media_url} title={candidate.title || '待审核媒体'} mediaType={format}
                  adFilter={false} autoplayNext={false} autoSkipSegments={false}
                  pendingStart={pendingStart} onPendingStart={setPendingStart}
                  onPlaybackConfirmed={(evidence) => void recordPlayback(candidate, evidence as unknown as Record<string, unknown>)} />
              </div> : <p className="mt-3 rounded-lg bg-black/5 p-3 text-xs text-[var(--muted)]">{protectedMedia ? '检测到加密或 DRM 保护，禁止播放与发布。' : format ? '需要先完成媒体质量报告与未受保护检查，才会启用播放器验收。' : '当前播放器不支持此格式（例如 DASH）；不会以清单元数据代替真实播放验收，因此不能批准发布。'}</p>}
            </article>;
          })}
        </div>}
      </section>

      <section className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-5">
        <div className="mb-4"><h2 className="text-lg font-semibold">版本化采集规则</h2><p className="mt-1 text-sm text-[var(--muted)]">已测试规则默认不启用；只有人工检查来源与选择器后才能激活，连续失败的规则会自动停用。</p></div>
        {rules.length === 0 ? <p className="py-4 text-center text-sm text-[var(--muted)]">暂无规则版本。</p> : <div className="space-y-3">
          {rules.map((rule) => <article key={rule.rule_id} className="rounded-xl border border-[var(--border)] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0"><p className="font-medium">{rule.goal} · v{rule.version}</p><p className="mt-1 break-all text-xs text-[var(--muted)]">{rule.source_origin} · {rule.mode}: <code>{rule.selector}</code></p><p className="mt-1 text-xs text-[var(--muted)]">测试匹配 {rule.test_json?.match_count ?? 0} 项 · {rule.status}</p></div>
              <div className="flex gap-2">{rule.status !== 'active' ? <button type="button" disabled={Boolean(busy)} onClick={() => void setRuleStatus(rule, 'activate')} className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs">人工启用</button> : null}{rule.status === 'active' ? <button type="button" disabled={Boolean(busy)} onClick={() => void setRuleStatus(rule, 'disable')} className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs">停用</button> : null}</div>
            </div>
          </article>)}
        </div>}
      </section>
    </div>
  );
}
