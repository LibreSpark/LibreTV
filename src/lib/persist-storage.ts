/**
 * zustand persist 用的节流 localStorage 包装（独立成模块的原因：
 * db.ts 的 importConfig 需要 flush 节流缓冲，而运行时依赖方向是 store → db，
 * db.ts 不能反向 import store，故把两者共用的存储逻辑放在这个无依赖的底层模块）。
 */

import type { StateStorage } from 'zustand/middleware';

/** store 持久化在 localStorage 中的键（store.ts 的 persist name 与 importConfig 共用） */
export const PERSIST_KEY = 'libretv-settings';

/** 节流窗口：搜索/测活等高频 set 合并为 800ms 一次落盘 */
const THROTTLE_MS = 800;

interface Snapshot {
  state: Record<string, unknown>;
  version?: number;
}

interface ThrottledStorage extends StateStorage {
  syncSnapshot: (state: Record<string, unknown>, version?: number) => void;
}

const flushers = new Set<() => void>();
const listeners = new Set<() => void>();

/** 外部写入及本标签重基落盘后，让 store 恢复合并后的快照（恢复本身不写盘）。 */
export function subscribePersistChanges(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notifyChanges(): void {
  for (const listener of listeners) listener();
}

function parseSnapshot(value: string | null): Snapshot | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Snapshot;
    return parsed && parsed.state && typeof parsed.state === 'object' && !Array.isArray(parsed.state)
      ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 立即落盘缓冲中的待写状态。
 * importConfig 直接写 localStorage 前必须先调用，否则缓冲中的旧状态
 * 会在导入后 flush 覆盖刚写入的配置（竞态见 db.ts importConfig）。
 */
export function flushPendingPersist(): void {
  for (const flush of flushers) flush();
}

/**
 * 节流写入的 localStorage 包装。
 * 搜索会逐源写健康度、测活每 200ms 合并写回，这些都会触发 persist 的整份序列化 + 写盘；
 * 这里把写入合并为 800ms 一次，并在页面隐藏/卸载时立即 flush，确保不丢最后一次修改。
 */
export function createThrottledStorage(): ThrottledStorage {
  // 每个标签独立维护「上次交给 store 的快照」和实际修改过的字段。
  // 不能拿整份旧快照覆盖磁盘：即使 storage 事件尚未送达，测速等无关 set 也应保留新源。
  let storage: Storage | undefined;
  try { storage = localStorage; } catch { /* SSR / 禁止存储 */ }
  let snapshot: Snapshot | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingName: string | null = null;
  /**
   * 我们最后一次读到 / 写掉的磁盘原文。用来在 flush 时判断「磁盘上是否有别的标签
   * 刚写进去、而我们内存里没有的内容」——只有真有外部改动才值得让本标签 rehydrate。
   */
  let lastKnownDisk: string | null = null;
  const changes = new Map<string, unknown>();
  const removed = new Set<string>();

  const read = (name: string): string | null => storage?.getItem(name) ?? null;
  const rebase = (latest: Snapshot | null): Snapshot => {
    const state = { ...(latest?.state ?? {}) };
    for (const key of removed) delete state[key];
    for (const [key, value] of changes) state[key] = value;
    return { state, version: snapshot?.version ?? latest?.version };
  };
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!pendingName || !storage) return;
    const name = pendingName;
    try {
      const latest = read(name);
      // 磁盘内容与上次已知不一致 = 别的标签写过，本标签内存确实落后，才需要 rehydrate。
      // 单标签场景（绝大多数时候）这一句直接把「每次落盘都自我 rehydrate」省掉：
      // 那会多出一轮全应用订阅者通知，而值并没有任何变化。
      const external = latest !== lastKnownDisk;
      const next = JSON.stringify(rebase(parseSnapshot(latest)));
      if (next !== latest) {
        storage.setItem(name, next);
        lastKnownDisk = next;
      } else {
        lastKnownDisk = latest;
      }
      pendingName = null;
      changes.clear();
      removed.clear();
      if (external) notifyChanges();
    } catch {
      // 配额不足 / 隐私模式下保留内存态，后续操作或显式 flush 可重试。
    }
  };
  flushers.add(flush);

  if (typeof window !== 'undefined') {
    const doc = document;
    window.addEventListener('visibilitychange', () => {
      if (doc.visibilityState === 'hidden') flush();
    });
    window.addEventListener('beforeunload', flush);
    window.addEventListener('storage', (event) => {
      if ((event.key === PERSIST_KEY || event.key === null) && event.storageArea === storage) notifyChanges();
    });
  }

  return {
    // hydration 会补入缺省字段；比较基线必须与实际 store 一致，否则旧快照缺少的
    // 默认值会在下次普通 set 时被误认作本标签的修改，回退另一标签的新偏好。
    syncSnapshot: (state, version) => { snapshot = { state, version }; },
    getItem: (name) => {
      try {
        const latest = read(name);
        lastKnownDisk = latest;
        // 收到 storage 通知时，先把本标签尚未落盘的真实修改重放到最新快照再 hydrate，
        // 不能直接丢掉 pending，也不能更新基线后继续把旧内存视作新修改。
        const value = pendingName === name ? JSON.stringify(rebase(parseSnapshot(latest))) : latest;
        const next = parseSnapshot(value);
        // 与 persist 的浅合并一致：缺省字段沿用当前内存值。迁移触发 setItem 时，
        // 也不能把这些补入的默认值误记为修改；仍保留真正的迁移差异和版本升级。
        snapshot = next ? { ...next, state: { ...snapshot?.state, ...next.state } } : snapshot;
        return value;
      } catch {
        return null;
      }
    },
    setItem: (name, value) => {
      const next = parseSnapshot(value);
      if (!next) return;
      const versionChanged = snapshot?.version !== next.version;
      const previous = snapshot?.state ?? {};
      for (const key of new Set([...Object.keys(previous), ...Object.keys(next.state)])) {
        if (JSON.stringify(previous[key]) === JSON.stringify(next.state[key])) continue;
        if (Object.hasOwn(next.state, key)) {
          changes.set(key, next.state[key]);
          removed.delete(key);
        } else {
          changes.delete(key);
          removed.add(key);
        }
      }
      snapshot = next;
      if (changes.size === 0 && removed.size === 0 && !versionChanged) return;
      pendingName = name;
      if (!timer) timer = setTimeout(flush, THROTTLE_MS);
    },
    removeItem: (name) => {
      if (timer) clearTimeout(timer);
      timer = null;
      pendingName = null;
      changes.clear();
      removed.clear();
      snapshot = null;
      lastKnownDisk = null;
      try {
        storage?.removeItem(name);
      } catch {
        // 忽略
      }
    },
  };
}
