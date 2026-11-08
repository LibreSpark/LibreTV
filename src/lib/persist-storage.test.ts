import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({
  db: {},
  clearLiveProbeResultsDb: vi.fn(async () => {}),
  loadLiveProbeResults: vi.fn(async () => ({})),
  saveLiveProbeResults: vi.fn(async () => {}),
}));

const KEY = 'libretv-settings';
const sources = [
  { key: 'custom_0', name: '非凡', url: 'https://ff.example/api' },
  { key: 'custom_1', name: '量子', url: 'https://lz.example/api' },
];
const added = { name: '360', url: 'https://360.example/api' };
const disk = new Map<string, string>();

function makeStorage(): Storage {
  return {
    get length() { return disk.size; },
    key: (index) => [...disk.keys()][index] ?? null,
    clear: () => disk.clear(),
    getItem: (key) => disk.get(key) ?? null,
    setItem: (key, value) => { disk.set(key, value); },
    removeItem: (key) => { disk.delete(key); },
  };
}

/** 每次加载真实 store 和 adapter 的独立模块副本，模拟共享磁盘的独立标签页。 */
async function openTab() {
  const target = new EventTarget();
  const storage = makeStorage();
  vi.stubGlobal('window', target);
  vi.stubGlobal('document', { visibilityState: 'visible' });
  vi.stubGlobal('localStorage', storage);
  vi.resetModules();
  const { useAppStore } = await import('./store');
  const { flushPendingPersist } = await import('./persist-storage');
  await useAppStore.persist.rehydrate();
  return {
    store: useAppStore,
    flush: flushPendingPersist,
    notify: () => target.dispatchEvent(Object.assign(new Event('storage'), {
      key: KEY, storageArea: storage, newValue: storage.getItem(KEY),
    })),
    unload: () => target.dispatchEvent(new Event('beforeunload')),
    storage,
  };
}

function saved() {
  return JSON.parse(disk.get(KEY)!).state;
}

beforeEach(() => {
  vi.useFakeTimers();
  disk.clear();
  disk.set(KEY, JSON.stringify({ version: 8, state: {
    customAPIs: sources,
    selectedKeys: sources.map((source) => source.key),
    sourceHealth: {},
    adFilter: true,
  } }));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('多标签配置持久化', () => {
  it('未收到 storage 通知的旧标签更新健康度，不覆盖另一标签新增的源', async () => {
    const a = await openTab();
    const b = await openTab();
    b.store.getState().addCustomApi(added);
    b.flush();
    a.store.getState().recordSourceHealth([{ sourceKey: 'custom_0', ok: true, ms: 100, list: [] }]);
    a.flush();
    expect(saved().customAPIs.map((source: { name: string }) => source.name)).toEqual(['非凡', '量子', '360']);
    expect(saved().sourceHealth.custom_0.ok).toBe(true);
  });

  it.each(['新增', '删除', '停用'] as const)('旧标签已排队的延迟写不能覆盖另一标签的%s操作', async (operation) => {
    const a = await openTab();
    const b = await openTab();
    a.store.getState().recordSourceHealth([{ sourceKey: 'custom_0', ok: true, ms: 100, list: [] }]);
    if (operation === '新增') b.store.getState().addCustomApi(added);
    if (operation === '删除') b.store.getState().removeCustomApi('custom_0');
    if (operation === '停用') b.store.getState().toggleSourceSelected('custom_0');
    b.flush();
    const expectedSources = saved().customAPIs;
    const expectedSelected = saved().selectedKeys;
    vi.advanceTimersByTime(800);
    expect(saved().customAPIs).toEqual(expectedSources);
    expect(saved().selectedKeys).toEqual(expectedSelected);
    expect(saved().sourceHealth.custom_0.ok).toBe(true);
  });

  it('页面卸载前的 flush 也不能复活另一标签已删除的源', async () => {
    const a = await openTab();
    const b = await openTab();
    a.store.getState().updateSettings({ adFilter: false });
    b.store.getState().removeCustomApi('custom_0');
    b.flush();
    a.unload();
    expect(saved().customAPIs).toEqual([sources[1]]);
    expect(saved().adFilter).toBe(false);
  });

  it('外部 storage 通知恢复内存配置，且不会触发回写循环', async () => {
    const a = await openTab();
    const b = await openTab();
    b.store.getState().addCustomApi(added);
    b.flush();
    const persisted = disk.get(KEY);
    a.notify();
    expect(a.store.getState().customAPIs.map((source) => source.name)).toEqual(['非凡', '量子', '360']);
    vi.advanceTimersByTime(800);
    expect(disk.get(KEY)).toBe(persisted);
  });

  it('收到外部配置时保留本标签尚未落盘的修改', async () => {
    const a = await openTab();
    const b = await openTab();
    a.store.getState().updateSettings({ adFilter: false });
    b.store.getState().addCustomApi(added);
    b.flush();
    a.notify();
    expect(a.store.getState().adFilter).toBe(false);
    expect(a.store.getState().customAPIs).toHaveLength(3);
    a.flush();
    expect(saved().adFilter).toBe(false);
    expect(saved().customAPIs).toHaveLength(3);
  });

  it('导入直接覆盖快照后，旧标签普通状态更新不回退导入配置', async () => {
    const a = await openTab();
    a.storage.setItem(KEY, JSON.stringify({ version: 8, state: {
      customAPIs: [{ key: 'imported', name: '导入源', url: 'https://import.example/api' }],
      selectedKeys: ['imported'],
      adFilter: true,
      sourceHealth: {},
    } }));
    a.store.getState().recordSourceHealth([{ sourceKey: 'custom_0', ok: true, ms: 100, list: [] }]);
    a.flush();
    expect(saved().customAPIs[0].key).toBe('imported');
    expect(saved().selectedKeys).toEqual(['imported']);
  });

  it('本标签连续新增、停用、删除仍按用户操作保存', async () => {
    const a = await openTab();
    a.store.getState().addCustomApi(added);
    a.store.getState().toggleSourceSelected('custom_1');
    a.store.getState().removeCustomApi('custom_0');
    a.flush();
    const restored = await openTab();
    expect(restored.store.getState().customAPIs.map((source) => source.name)).toEqual(['量子', '360']);
    expect(restored.store.getState().selectedKeys).toEqual(['custom_2']);
  });

  it('两标签分别修改不同偏好时，两项操作都持久化', async () => {
    const a = await openTab();
    const b = await openTab();
    a.store.getState().updateSettings({ adFilter: false });
    b.store.getState().updateSettings({ autoplayNext: false });
    b.flush();
    a.flush();
    expect(saved().adFilter).toBe(false);
    expect(saved().autoplayNext).toBe(false);
    expect(a.store.getState().autoplayNext).toBe(false);
  });

  it('空存储首次打开的旧标签无关更新，不覆盖另一标签新配置', async () => {
    disk.clear();
    const a = await openTab();
    const b = await openTab();
    b.store.getState().addCustomApi(added);
    b.store.getState().updateSettings({ autoplayNext: false });
    b.flush();
    a.store.getState().recordSourceHealth([{ sourceKey: 'custom_0', ok: true, ms: 100, list: [] }]);
    a.flush();
    expect(saved().customAPIs.map((source: { name: string }) => source.name)).toEqual(['360']);
    expect(saved().autoplayNext).toBe(false);
  });

  it('旧版配置迁移产生的待写默认值不回退另一标签的新偏好', async () => {
    disk.set(KEY, JSON.stringify({ ...JSON.parse(disk.get(KEY)!), version: 7 }));
    const a = await openTab();
    const b = await openTab();
    b.store.getState().updateSettings({ autoplayNext: false });
    b.flush();
    a.flush();
    expect(saved().autoplayNext).toBe(false);
    expect(saved().customAPIs).toEqual(sources);
    expect(JSON.parse(disk.get(KEY)!).version).toBe(8);
  });

  it('本标签 flush 同步新基线后，后续普通更新仍保留远端源', async () => {
    const a = await openTab();
    const b = await openTab();
    b.store.getState().addCustomApi(added);
    b.flush();
    a.store.getState().updateSettings({ adFilter: false });
    a.flush();
    a.store.getState().updateSettings({ autoplayNext: false });
    a.flush();
    expect(saved().customAPIs).toHaveLength(3);
    expect(a.store.getState().customAPIs).toHaveLength(3);
  });

  it('重复 rehydrate 不丢待写偏好，也不把远端源误判为本地删除', async () => {
    const a = await openTab();
    const b = await openTab();
    a.store.getState().updateSettings({ adFilter: false });
    b.store.getState().addCustomApi(added);
    b.flush();
    await a.store.persist.rehydrate();
    await a.store.persist.rehydrate();
    a.store.getState().updateSettings({ autoplayNext: false });
    a.flush();
    expect(saved().customAPIs).toHaveLength(3);
    expect(saved().adFilter).toBe(false);
    expect(saved().autoplayNext).toBe(false);
  });

  it('清除持久化存储会取消本标签已经排队的旧写入', async () => {
    const a = await openTab();
    a.store.getState().addCustomApi(added);
    a.store.persist.clearStorage();
    vi.advanceTimersByTime(800);
    a.unload();
    expect(disk.has(KEY)).toBe(false);
  });

  it('写入失败后内存操作仍可用，显式重试成功保存', async () => {
    const a = await openTab();
    a.store.getState().addCustomApi(added);
    const fail = vi.spyOn(a.storage, 'setItem').mockImplementationOnce(() => { throw new Error('quota'); });
    expect(() => a.flush()).not.toThrow();
    expect(a.store.getState().customAPIs).toHaveLength(3);
    expect(saved().customAPIs).toHaveLength(2);
    a.flush();
    expect(saved().customAPIs).toHaveLength(3);
    fail.mockRestore();
  });

  it('无法读取最新存储时不使用不完整差异覆盖原配置', async () => {
    const a = await openTab();
    a.store.getState().updateSettings({ adFilter: false });
    const fail = vi.spyOn(a.storage, 'getItem').mockImplementationOnce(() => { throw new Error('denied'); });
    expect(() => a.flush()).not.toThrow();
    expect(saved().customAPIs).toEqual(sources);
    expect(saved().adFilter).toBe(true);
    a.flush();
    expect(saved().adFilter).toBe(false);
    fail.mockRestore();
  });

  /**
   * 明确记录该 PR **没有**解决的部分：数组不做并集，同一个顶层字段仍是 last-flush-wins。
   * 标题是 "preserve settings across browser tabs"，用户会读成「不再丢配置」，
   * 所以这条边界要有用例钉住，而不是只写在 PR 描述里。
   */
  it('两个标签各自新增源时仍按后落盘者覆盖（数组不并集）', async () => {
    const a = await openTab();
    const b = await openTab();
    a.store.getState().addCustomApi({ name: 'A 标签加的', url: 'https://a.example/api' });
    a.flush();
    b.store.getState().addCustomApi({ name: 'B 标签加的', url: 'https://b.example/api' });
    b.flush();
    // B 的内存里没有 A 的新源（storage 事件未送达），落盘后 A 的那条被覆盖
    expect(saved().customAPIs.map((source: { name: string }) => source.name)).toEqual(['非凡', '量子', 'B 标签加的']);
  });

  /**
   * 单标签场景下，本标签自己的落盘不应再触发一次 rehydrate：
   * 那会在每个 800ms 窗口多一轮全应用订阅者通知，而值并没有任何变化。
   * 直接盯 rehydrate 的调用次数，比数订阅者通知更准（后者会被异步调度干扰）。
   */
  it('本标签自己落盘不再自我 rehydrate，只有磁盘真有外部改动才通知', async () => {
    const a = await openTab();
    const rehydrate = vi.spyOn(a.store.persist, 'rehydrate');

    a.store.getState().recordSourceHealth([{ sourceKey: 'custom_0', ok: true, ms: 100, list: [] }]);
    a.flush();
    expect(rehydrate).not.toHaveBeenCalled();
    expect(saved().sourceHealth.custom_0.ok).toBe(true);

    // 对照：另一标签真的写了盘，本标签收到 storage 事件时才恢复内存基线
    const b = await openTab();
    b.store.getState().addCustomApi(added);
    b.flush();
    a.notify();
    expect(rehydrate).toHaveBeenCalled();
    await a.store.persist.rehydrate();
    expect(a.store.getState().customAPIs).toHaveLength(3);
    rehydrate.mockRestore();
  });
});
