import { log } from './logger';

// 增加 userId 校验与竞态占位 (TOCTOU防御)
type Entry = { userId: string; ctrl: AbortController };
const inflight = new Map<string, Entry>();
const pendingCancelled = new Map<string, string>();

export function registerInflight(requestId: string, userId: string, ctrl: AbortController): boolean {
  if (inflight.has(requestId)) {
    log.warn('[inflight] 重复 requestId，拒绝注册', { requestId });
    return false;
  }
  inflight.set(requestId, { userId, ctrl });

  // 处理“先取消后注册”的竞态
  const owner = pendingCancelled.get(requestId);
  if (owner) {
    pendingCancelled.delete(requestId);
    if (owner === userId) {
      ctrl.abort(new Error('CANCELLED_BY_CLIENT'));
    }
  }
  return true;
}

export function unregisterInflight(requestId: string) {
  inflight.delete(requestId);
  pendingCancelled.delete(requestId);
}

export type CancelResult = 'ok' | 'pending' | 'forbidden';

export function cancelInflight(requestId: string, userId: string): CancelResult {
  const e = inflight.get(requestId);
  if (e) {
    if (e.userId !== userId) return 'forbidden';
    e.ctrl.abort(new Error('CANCELLED_BY_CLIENT'));
    inflight.delete(requestId);
    return 'ok';
  }
  pendingCancelled.set(requestId, userId);
  return 'pending';
}

export function inflightCount() { return inflight.size; }
