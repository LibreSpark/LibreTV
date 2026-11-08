import { beforeEach, describe, expect, it, vi } from 'vitest';

// store.ts 运行时引用 db.ts（IndexedDB），node 测试环境下 mock 掉
vi.mock('./db', () => ({
  db: {},
  clearLiveProbeResultsDb: vi.fn(async () => {}),
  loadLiveProbeResults: vi.fn(async () => ({})),
  saveLiveProbeResults: vi.fn(async () => {}),
}));

import { isInDisabledSubscription, isSourceDisabled, keyBelongsToSubscription, SOURCE_DISABLE_LADDER, subKeyPrefix, useAppStore } from './store';
import type { SourceConfig } from './types';

const store = () => useAppStore.getState();

const list = (urls: string[]): Omit<SourceConfig, 'key'>[] => urls.map((url) => ({ name: url, url }));

beforeEach(() => {
  useAppStore.setState({
    customAPIs: [],
    selectedKeys: [],
    subscriptions: [],
    liveSubscriptions: [],
    liveSelectedUrls: [],
    liveFavorites: [],
    liveRecent: [],
    yellowFilter: false,
    skipMarks: {},
  });
});

describe('subKeyPrefix / keyBelongsToSubscription', () => {
  it('key 完整形态为 `${prefix}_${i}`，归属判断要求前缀后紧跟分隔符', () => {
    const prefix = subKeyPrefix('https://sub.example.com/list.json');
    expect(prefix.startsWith('sub_')).toBe(true);
    expect(keyBelongsToSubscription(`${prefix}_0`, prefix)).toBe(true);
    expect(keyBelongsToSubscription(prefix, prefix)).toBe(true);
    expect(keyBelongsToSubscription('manual_0', prefix)).toBe(false);
  });

  it('真实碰撞构造：hash 互为前缀的两个订阅互不误伤', () => {
    // hash 部分是 sub_ 之后的 36 进制串
    const hashOf = (url: string) => subKeyPrefix(url).slice(4);

    // 找一个 hash36 为 6 位的基准 URL
    let base = '';
    for (let i = 0; i < 10000 && !base; i++) {
      const p = hashOf(`https://base${i}.example.com/list.json`);
      if (p.length === 6) base = p;
    }
    expect(base).not.toBe('');

    // 暴力搜索一个 hash36 以 base 为前缀的 URL（djb2 32bit，7 位 hash 的前 6 位命中率约 1/36）
    let colliding: string | null = null;
    for (let i = 0; i < 200000 && !colliding; i++) {
      const p = hashOf(`https://collide${i}.example.com/list.json`);
      if (p !== base && p.startsWith(base)) colliding = `https://collide${i}.example.com/list.json`;
    }
    // 找不到说明碰撞概率假设不成立，测试失去意义但也证明当前集合内无碰撞
    if (!colliding) return;

    const collidingPrefix = subKeyPrefix(colliding);
    expect(collidingPrefix.startsWith(base)).toBe(true);
    // 修复前 startsWith(prefix) 会把碰撞订阅的源误判为 base 订阅所有
    expect(keyBelongsToSubscription(`${collidingPrefix}_0`, base)).toBe(false);
    expect(keyBelongsToSubscription(`${base}_0`, base)).toBe(true);
  });
});

describe('订阅同步的 store 语义', () => {
  it('同步导入点播源并自动勾选；再次同步整体替换', () => {
    const url = 'https://a.example.com/list.json';
    expect(store().applySubscriptionSources(url, list(['https://x/api.php/provide/vod', 'https://y/api.php/provide/vod']))).toBe(2);
    expect(store().customAPIs).toHaveLength(2);
    expect(store().selectedKeys).toHaveLength(2);

    expect(store().applySubscriptionSources(url, list(['https://x/api.php/provide/vod', 'https://z/api.php/provide/vod']))).toBe(2);
    expect(store().customAPIs.map((a) => a.url)).toEqual(['https://x/api.php/provide/vod', 'https://z/api.php/provide/vod']);
  });

  it('用户取消勾选后，重新同步不会被反复勾回', () => {
    const url = 'https://a.example.com/list.json';
    store().applySubscriptionSources(url, list(['https://x/api.php/provide/vod']));
    store().toggleSourceSelected(store().customAPIs[0].key);
    expect(store().selectedKeys).toHaveLength(0);

    // 同步后 key 按序号重生成，勾选状态需按 url 对齐保留
    store().applySubscriptionSources(url, list(['https://x/api.php/provide/vod']));
    expect(store().customAPIs).toHaveLength(1);
    expect(store().selectedKeys).toHaveLength(0);
  });

  it('与订阅同 URL 的手动源视为重复，同步后不保留双份', () => {
    useAppStore.setState({
      customAPIs: [{ key: 'manual_0', name: '手动源', url: 'https://x/api.php/provide/vod' }],
      selectedKeys: ['manual_0'],
    });

    store().applySubscriptionSources('https://a.example.com/list.json', list(['https://x/api.php/provide/vod']));

    expect(store().customAPIs).toHaveLength(1);
    expect(store().customAPIs[0].key.startsWith('sub_')).toBe(true);
  });

  it('直播源：新导入自动启用、停用不勾回、消失的源清理启用状态但保留收藏', () => {
    const url = 'https://a.example.com/list.json';
    const m1 = 'https://live.example.com/1.m3u';
    const m2 = 'https://live.example.com/2.m3u';

    store().applySubscriptionLive(url, [
      { name: 'm1', url: m1 },
      { name: 'm2', url: m2 },
    ]);
    expect(store().liveSelectedUrls).toContain(m1);
    expect(store().liveSelectedUrls).toContain(m2);

    // 用户收藏 m2、并主动停用 m2
    useAppStore.setState({ liveFavorites: [m2] });
    store().toggleLiveSelected(m2);

    // 远端列表只剩 m2：m1 随消失清理启用状态；m2 维持用户的停用状态
    store().applySubscriptionLive(url, [{ name: 'm2', url: m2 }]);
    expect(store().liveSelectedUrls).not.toContain(m1);
    expect(store().liveSelectedUrls).not.toContain(m2);
    expect(store().liveFavorites).toContain(m2);
  });

  it('删除订阅：清点播/勾选/直播/启用状态，保留收藏的频道', () => {
    const url = 'https://a.example.com/list.json';
    const m1 = 'https://live.example.com/1.m3u';
    store().applySubscriptionSources(url, list(['https://x/api.php/provide/vod']));
    store().applySubscriptionLive(url, [{ name: 'm1', url: m1 }]);
    useAppStore.setState({ liveFavorites: [m1] });
    store().addSubscription(url, 'A');
    expect(store().subscriptions).toHaveLength(1);

    store().removeSubscription(url);
    expect(store().subscriptions).toHaveLength(0);
    expect(store().customAPIs).toHaveLength(0);
    expect(store().selectedKeys).toHaveLength(0);
    expect(store().liveSubscriptions).toHaveLength(0);
    expect(store().liveSelectedUrls).toHaveLength(0);
    expect(store().liveFavorites).toContain(m1);
  });

  it('同一 M3U 被两个订阅引用时共享归属，不重复导入，名称以首次导入为准', () => {
    const m1 = 'https://live.example.com/1.m3u';
    expect(store().applySubscriptionLive('https://a.example.com/list.json', [{ name: 'm1', url: m1 }])).toBe(1);
    // 第二个订阅也计入自己的引用（计数不再失真）
    expect(store().applySubscriptionLive('https://b.example.com/list.json', [{ name: 'm1 改名', url: m1 }])).toBe(1);
    expect(store().liveSubscriptions).toHaveLength(1);
    expect(store().liveSubscriptions[0].fromSubscriptions).toEqual([
      'https://a.example.com/list.json',
      'https://b.example.com/list.json',
    ]);
    expect(store().liveSubscriptions[0].name).toBe('m1');
  });

  it('手动添加的直播源不被订阅接管', () => {
    const m1 = 'https://live.example.com/1.m3u';
    store().addLiveSubscription(m1, '手动');
    expect(store().applySubscriptionLive('https://a.example.com/list.json', [{ name: '订阅名', url: m1 }])).toBe(0);
    expect(store().liveSubscriptions).toHaveLength(1);
    expect(store().liveSubscriptions[0].name).toBe('手动');
    expect(store().liveSubscriptions[0].fromSubscriptions).toEqual([]);
  });

  it('同步缺席即摘除归属：共享源降级为其他订阅的引用，双方都缺席才移除', () => {
    const shared = 'https://live.example.com/shared.m3u';
    store().applySubscriptionLive('https://a.example.com/list.json', [{ name: '共享', url: shared }]);
    store().applySubscriptionLive('https://b.example.com/list.json', [{ name: '共享', url: shared }]);
    useAppStore.setState({ liveSelectedUrls: [shared] });

    // A 的远端列表删掉了共享源：摘除 A 的引用，源保留给 B，A 的计数归 0
    expect(store().applySubscriptionLive('https://a.example.com/list.json', [])).toBe(0);
    expect(store().liveSubscriptions).toHaveLength(1);
    expect(store().liveSubscriptions[0].fromSubscriptions).toEqual(['https://b.example.com/list.json']);
    expect(store().liveSelectedUrls).toContain(shared);

    // B 也删掉后无人引用，源随同步移除并清理启用状态
    expect(store().applySubscriptionLive('https://b.example.com/list.json', [])).toBe(0);
    expect(store().liveSubscriptions).toHaveLength(0);
    expect(store().liveSelectedUrls).not.toContain(shared);
  });

  it('手动添加的直播源缺席同步时不被移除', () => {
    const m1 = 'https://live.example.com/1.m3u';
    store().addLiveSubscription(m1, '手动');
    store().applySubscriptionLive('https://a.example.com/list.json', []);
    expect(store().liveSubscriptions).toHaveLength(1);
    expect(store().liveSubscriptions[0].url).toBe(m1);
  });

  it('删除订阅：共享的直播源保留给其他订阅，独占的才移除', () => {
    const shared = 'https://live.example.com/shared.m3u';
    const exclusive = 'https://live.example.com/exclusive.m3u';
    store().applySubscriptionLive('https://a.example.com/list.json', [
      { name: '共享', url: shared },
      { name: '独占', url: exclusive },
    ]);
    store().applySubscriptionLive('https://b.example.com/list.json', [{ name: '共享', url: shared }]);
    useAppStore.setState({ liveSelectedUrls: [shared, exclusive], liveFavorites: [exclusive] });

    store().removeSubscription('https://a.example.com/list.json');
    // 共享源保留（归属只剩 B），独占源随订阅移除；启用状态相应清理，收藏保留
    expect(store().liveSubscriptions).toHaveLength(1);
    expect(store().liveSubscriptions[0].url).toBe(shared);
    expect(store().liveSubscriptions[0].fromSubscriptions).toEqual(['https://b.example.com/list.json']);
    expect(store().liveSelectedUrls).toEqual([shared]);
    expect(store().liveFavorites).toContain(exclusive);
  });
});

describe('可撤销删除与订阅同步状态', () => {
  it('删除点播源返回快照，撤销后恢复条目与勾选状态', () => {
    useAppStore.setState({
      customAPIs: [{ key: 'manual_0', name: '源A', url: 'https://x/api.php/provide/vod' }],
      selectedKeys: ['manual_0'],
    });

    const snapshot = store().removeCustomApi('manual_0');
    expect(snapshot).not.toBeNull();
    expect(store().customAPIs).toHaveLength(0);
    expect(store().selectedKeys).toHaveLength(0);

    expect(store().restoreCustomApi(snapshot!)).toBe(true);
    expect(store().customAPIs.map((a) => a.key)).toEqual(['manual_0']);
    expect(store().selectedKeys).toEqual(['manual_0']);
  });

  it('原 key 被重新占用时放弃撤销，避免出现重复条目', () => {
    useAppStore.setState({
      customAPIs: [{ key: 'manual_0', name: '源A', url: 'https://x/api.php/provide/vod' }],
      selectedKeys: [],
    });
    const snapshot = store().removeCustomApi('manual_0')!;
    // 期间同 key 的源又出现（如订阅重新同步生成）
    useAppStore.setState({
      customAPIs: [{ key: 'manual_0', name: '新源', url: 'https://y/api.php/provide/vod' }],
    });

    expect(store().restoreCustomApi(snapshot)).toBe(false);
    expect(store().customAPIs).toHaveLength(1);
    expect(store().customAPIs[0].name).toBe('新源');
  });

  it('删除不存在的点播源返回 null', () => {
    expect(store().removeCustomApi('nope')).toBeNull();
  });

  it('删除直播源返回快照，撤销后恢复条目与启用状态', () => {
    store().addLiveSubscription('https://live.example.com/1.m3u', '手动');
    const snapshot = store().removeLiveSubscription('https://live.example.com/1.m3u');
    expect(snapshot).not.toBeNull();
    expect(store().liveSubscriptions).toHaveLength(0);
    expect(store().liveSelectedUrls).toHaveLength(0);

    store().restoreLiveSubscription(snapshot!);
    expect(store().liveSubscriptions.map((s) => s.url)).toEqual(['https://live.example.com/1.m3u']);
    expect(store().liveSelectedUrls).toEqual(['https://live.example.com/1.m3u']);
  });

  it('同步成功记录状态与数量；同步失败记录原因且保留上次数量', () => {
    const url = 'https://a.example.com/list.json';
    store().addSubscription(url, 'A');
    store().markSubscriptionSynced(url, 'A', { vod: 3, live: 1 });
    expect(store().subscriptions[0]).toMatchObject({ lastStatus: 'ok', lastCounts: { vod: 3, live: 1 } });
    expect(typeof store().subscriptions[0].lastSync).toBe('number');

    store().markSubscriptionFailed(url, '网络错误');
    expect(store().subscriptions[0]).toMatchObject({ lastStatus: 'error', lastError: '网络错误' });
    expect(store().subscriptions[0].lastCounts).toEqual({ vod: 3, live: 1 });
  });
});

describe('点播源自动停用阶梯', () => {
  const fail = (key: string) => ({ sourceKey: key, ok: false, error: '超时', list: [] });
  const okOutcome = (key: string) => ({ sourceKey: key, ok: true, ms: 12, list: [] });
  /** 连续两次搜索失败（每次搜索各记录一次），返回两次调用产生的停用事件合集 */
  const failTwice = (key: string) => [
    ...store().recordSourceHealth([fail(key)]),
    ...store().recordSourceHealth([fail(key)]),
  ];
  /** 模拟停用到期：把截止时间挪到过去 */
  const expire = (key: string) => {
    const entry = store().sourceHealth[key];
    useAppStore.setState({
      sourceHealth: { ...store().sourceHealth, [key]: { ...entry, disabledUntil: Date.now() - 1 } },
    });
  };

  beforeEach(() => useAppStore.setState({ sourceHealth: {} }));

  it('达到阈值才停用，首次为 30 分钟', () => {
    expect(store().recordSourceHealth([fail('a')])).toEqual([]);
    expect(isSourceDisabled(store(), 'a')).toBe(false);

    const events = failTwice('a');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ key: 'a', level: 1, permanent: false, ttlMs: SOURCE_DISABLE_LADDER[0] });
    expect(isSourceDisabled(store(), 'a')).toBe(true);
  });

  it('到期恢复后再次连续失败 → 升级为 24 小时', () => {
    failTwice('a');
    expire('a');
    // 到期即恢复参与搜索（懒判断，无需清理标记）
    expect(isSourceDisabled(store(), 'a')).toBe(false);

    const events = failTwice('a');
    expect(events[0]).toMatchObject({ level: 2, permanent: false, ttlMs: SOURCE_DISABLE_LADDER[1] });
  });

  it('阶梯用尽 → 长期停用，不随到期恢复，须手动清除', () => {
    failTwice('a');
    expire('a');
    failTwice('a');
    expire('a');
    const events = failTwice('a');
    expect(events[0]).toMatchObject({ level: 3, permanent: true });
    expect(events[0].ttlMs).toBeUndefined();

    // 即便把停用时间挪到过去也不会自动恢复
    expire('a');
    expect(isSourceDisabled(store(), 'a')).toBe(true);

    store().clearSourceHealth('a');
    expect(isSourceDisabled(store(), 'a')).toBe(false);
  });

  it('成功一次降一级：偶发抽风的源不会一路升到长期停用', () => {
    failTwice('a'); // 第 1 级
    expire('a');
    failTwice('a'); // 第 2 级
    expire('a');

    store().recordSourceHealth([okOutcome('a')]);
    expect(store().sourceHealth['a'].disableCount).toBe(1);

    const events = failTwice('a');
    expect(events[0]).toMatchObject({ level: 2, permanent: false });
  });

  it('成功后立即清除停用标记与失败连击', () => {
    failTwice('a');
    expect(isSourceDisabled(store(), 'a')).toBe(true);

    store().recordSourceHealth([okOutcome('a')]);
    expect(isSourceDisabled(store(), 'a')).toBe(false);
    expect(store().sourceHealth['a'].failStreak).toBe(0);
  });
});

describe('订阅整体开关', () => {
  const subUrl = 'https://sub.example.com/list.json';
  const otherUrl = 'https://other.example.com/list.json';

  beforeEach(() => {
    useAppStore.setState({ customAPIs: [], selectedKeys: [], subscriptions: [], sourceHealth: {} });
  });

  it('未设置 enabled 的订阅视为启用，不影响其源', () => {
    store().addSubscription(subUrl, 'S');
    expect(store().subscriptions[0].enabled).toBeUndefined();
    expect(isInDisabledSubscription(store(), `${subKeyPrefix(subUrl)}_0`)).toBe(false);
  });

  it('停用订阅仅影响搜索采用：源数据与勾选状态都保留，可无损恢复', () => {
    store().addSubscription(subUrl, 'S');
    const key = `${subKeyPrefix(subUrl)}_0`;
    store().addCustomApi({ key, name: 'A', url: 'https://a.example.com/api.php/provide/vod' });
    store().setSelectedKeys([key]);

    store().setSubscriptionEnabled(subUrl, false);
    expect(isInDisabledSubscription(store(), key)).toBe(true);
    // 关键：无损——源还在、勾选也还在
    expect(store().customAPIs.map((a) => a.key)).toContain(key);
    expect(store().selectedKeys).toContain(key);

    store().setSubscriptionEnabled(subUrl, true);
    expect(isInDisabledSubscription(store(), key)).toBe(false);
  });

  it('只影响本订阅名下的源，其他订阅与手动添加的源不受牵连', () => {
    store().addSubscription(subUrl, 'S');
    store().addSubscription(otherUrl, 'O');
    store().setSubscriptionEnabled(subUrl, false);

    expect(isInDisabledSubscription(store(), `${subKeyPrefix(subUrl)}_1`)).toBe(true);
    expect(isInDisabledSubscription(store(), `${subKeyPrefix(otherUrl)}_1`)).toBe(false);
    expect(isInDisabledSubscription(store(), 'manual_0')).toBe(false);
  });
});

describe('跳过片段标记', () => {
  beforeEach(() => {
    useAppStore.setState({ skipMarks: {} });
  });

  it('写入片段列表并刷新 updatedAt', () => {
    store().setSkipMark('t:abc', [{ type: 'opening', start: 0, end: 45 }]);
    expect(store().skipMarks['t:abc']?.segments).toEqual([{ type: 'opening', start: 0, end: 45 }]);
    const firstUpdatedAt = store().skipMarks['t:abc']?.updatedAt ?? 0;
    expect(firstUpdatedAt).toBeGreaterThan(0);

    store().setSkipMark('t:abc', [
      { type: 'opening', start: 0, end: 45 },
      { type: 'ending', start: 1200, end: -1 },
    ]);
    expect(store().skipMarks['t:abc']?.segments).toHaveLength(2);
    expect(store().skipMarks['t:abc']?.updatedAt).toBeGreaterThanOrEqual(firstUpdatedAt);
  });

  it('写入空数组删除整条，不创建空壳条目', () => {
    store().setSkipMark('t:abc', [{ type: 'opening', start: 0, end: 45 }]);
    store().setSkipMark('t:abc', []);
    expect(store().skipMarks['t:abc']).toBeUndefined();

    store().setSkipMark('t:missing', []);
    expect(store().skipMarks).toEqual({});
  });

  it('写入时默认开启本剧跳过，改片段不会重置已关闭状态', () => {
    store().setSkipMark('t:abc', [{ type: 'opening', start: 0, end: 45 }]);
    expect(store().skipMarks['t:abc']?.enabled).toBe(true);

    store().setSkipMarkEnabled('t:abc', false);
    expect(store().skipMarks['t:abc']?.enabled).toBe(false);

    // 修一条标错的边界后，用户"关掉本剧"的选择要保留
    store().setSkipMark('t:abc', [{ type: 'opening', start: 0, end: 30 }]);
    expect(store().skipMarks['t:abc']?.enabled).toBe(false);
  });

  it('setSkipMarkEnabled 对不存在的条目无副作用', () => {
    store().setSkipMarkEnabled('t:missing', false);
    expect(store().skipMarks).toEqual({});
  });

  it('clearSkipMark 只删指定条目，clearAllSkipMarks 清空全部', () => {
    store().setSkipMark('t:a', [{ type: 'opening', start: 0, end: 20 }]);
    store().setSkipMark('t:b', [{ type: 'ending', start: 200, end: -1 }]);

    store().clearSkipMark('t:a');
    expect(store().skipMarks).not.toHaveProperty('t:a');
    expect(store().skipMarks).toHaveProperty('t:b');

    store().clearAllSkipMarks();
    expect(store().skipMarks).toEqual({});
  });
});

describe('订阅自动刷新状态', () => {
  const subUrl = 'https://sub.example.com/list.json';
  const otherUrl = 'https://other.example.com/list.json';

  beforeEach(() => {
    useAppStore.setState({ customAPIs: [], selectedKeys: [], subscriptions: [] });
    store().addSubscription(subUrl, 'S');
    store().addSubscription(otherUrl, 'O');
  });

  const find = (url: string) => store().subscriptions.find((s) => s.url === url);

  it('未设置刷新周期的订阅保持纯手动（refreshDays 为 undefined）', () => {
    expect(find(subUrl)?.refreshDays).toBeUndefined();
  });

  it('设置刷新周期只影响目标订阅，传 undefined 可退回手动', () => {
    store().setSubscriptionRefreshDays(subUrl, 7);
    expect(find(subUrl)?.refreshDays).toBe(7);
    expect(find(otherUrl)?.refreshDays).toBeUndefined();

    store().setSubscriptionRefreshDays(subUrl, undefined);
    expect(find(subUrl)?.refreshDays).toBeUndefined();
  });

  it('markSubscriptionFailed 记录错误并累加连续失败次数，不清空已导入的源', () => {
    store().addCustomApi({ key: `${subKeyPrefix(subUrl)}_0`, name: 'A', url: 'https://a.example.com/api.php/provide/vod' });

    store().markSubscriptionFailed(subUrl, 'boom');
    expect(find(subUrl)?.lastStatus).toBe('error');
    expect(find(subUrl)?.lastError).toBe('boom');
    expect(find(subUrl)?.failStreak).toBe(1);

    store().markSubscriptionFailed(subUrl, 'boom again');
    expect(find(subUrl)?.failStreak).toBe(2);
    // 关键：失败只是状态，源还在，用户可以继续用旧数据
    expect(store().customAPIs).toHaveLength(1);
    // 只影响本订阅
    expect(find(otherUrl)?.failStreak).toBeUndefined();
  });

  it('countFailure: false（鉴权失败）不计入连续失败，避免自动刷新被误暂停', () => {
    store().markSubscriptionFailed(subUrl, 'unauthorized');
    expect(find(subUrl)?.failStreak).toBe(1);

    // 401/503 属于会话问题，连续三次也不该把 failStreak 推高
    for (let i = 0; i < 3; i++) store().markSubscriptionFailed(subUrl, 'unauthorized', { countFailure: false });
    expect(find(subUrl)?.failStreak).toBe(1);
    // 但状态仍要如实反映失败
    expect(find(subUrl)?.lastStatus).toBe('error');
  });

  it('markSubscriptionSynced 清零连续失败次数，被暂停的自动刷新随之恢复', () => {
    for (let i = 0; i < 3; i++) store().markSubscriptionFailed(subUrl, 'boom');
    expect(find(subUrl)?.failStreak).toBe(3);

    store().markSubscriptionSynced(subUrl);
    expect(find(subUrl)?.failStreak).toBe(0);
    expect(find(subUrl)?.lastStatus).toBe('ok');
    expect(find(subUrl)?.lastError).toBeUndefined();
    expect(find(subUrl)?.lastSync).toBeGreaterThan(0);
  });

  it('改刷新周期不会重置失败计数，改完仍按原失败次数判断是否暂停', () => {
    for (let i = 0; i < 2; i++) store().markSubscriptionFailed(subUrl, 'boom');
    store().setSubscriptionRefreshDays(subUrl, 3);

    expect(find(subUrl)?.refreshDays).toBe(3);
    expect(find(subUrl)?.failStreak).toBe(2);
  });
});

describe('音量放大设置项', () => {
  it('volumeBoost 出厂默认关闭：增益与音量滑块相乘，会让所有档位响度整体抬高，必须用户显式开启', () => {
    expect(store().volumeBoost).toBe(false);
  });

  it('volumeBoost 可通过 updateSettings 切换（设置页与播放器共用同一份状态）', () => {
    store().updateSettings({ volumeBoost: true });
    expect(store().volumeBoost).toBe(true);
    store().updateSettings({ volumeBoost: false });
    expect(store().volumeBoost).toBe(false);
  });
});

describe('底部细进度条设置项', () => {
  it('miniProgressBar 出厂默认开启：多年既有行为，新增的只是可关闭的入口', () => {
    expect(store().miniProgressBar).toBe(true);
  });

  it('miniProgressBar 可通过 updateSettings 切换（设置页与播放器共用同一份状态）', () => {
    store().updateSettings({ miniProgressBar: false });
    expect(store().miniProgressBar).toBe(false);
    store().updateSettings({ miniProgressBar: true });
    expect(store().miniProgressBar).toBe(true);
  });

  it('partialize 会带上 miniProgressBar：漏写就只活在内存里，刷新即回默认', () => {
    const options = useAppStore.persist.getOptions() as unknown as {
      partialize: (s: unknown) => Record<string, unknown>;
    };
    expect(options.partialize(store()).miniProgressBar).toBe(true);
    store().updateSettings({ miniProgressBar: false });
    expect(options.partialize(store()).miniProgressBar).toBe(false);
    store().updateSettings({ miniProgressBar: true });
  });
});
