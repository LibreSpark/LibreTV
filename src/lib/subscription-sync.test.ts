import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// store.ts 运行时引用 db.ts（IndexedDB），node 测试环境下 mock 掉
vi.mock('./db', () => ({
  db: {},
  clearLiveProbeResultsDb: vi.fn(async () => {}),
  loadLiveProbeResults: vi.fn(async () => ({})),
  saveLiveProbeResults: vi.fn(async () => {}),
}));

// 订阅内容由服务端代理拉取（需登录），测试中直接 mock；
// ApiError 保留真实实现——自动刷新要按 401/503 区分「会话问题」与「源问题」
vi.mock('./client-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./client-api')>();
  return { ...actual, api: { fetchSourceList: vi.fn() } };
});

import { ApiError, api } from './client-api';
import {
  applyEnvPresets,
  autoRefreshSubscriptions,
  canAutoRefresh,
  DEFAULT_ENV_SUB_REFRESH_DAYS,
  isRefreshDue,
} from './subscription-sync';
import { DEFAULT_ENV_SUB_REFRESH_DAYS as ENV_DEFAULT_DAYS } from './env-subscriptions';
import { useAppStore, type SourceSubscription } from './store';
import type { AuthStatusResponse, SourceListPayload } from './types';

/**
 * applyEnvPresets 单测：覆盖「首屏未登录时预置订阅 401 静默失败，登录后补跑」这一修复路径。
 * 补跑是否发生由 auth.tsx 负责，这里保证补跑本身是幂等且安全的。
 */

const SUB_URL = 'https://paste.rs/JsI9D';

const status = (over: Partial<AuthStatusResponse> = {}): AuthStatusResponse => ({
  passwordRequired: true,
  verified: false,
  version: 'test',
  defaultSources: [],
  defaultLiveSources: [],
  defaultSubscriptions: [],
  defaultRecommendSource: null,
  defaultImageMode: null,
  miniProgressBar: true,
  ...over,
});

const payload: SourceListPayload = {
  name: 'LibreTV-List',
  sources: [
    { name: '非凡影视', url: 'https://cj.ffzyapi.com/api.php/provide/vod/from/ffm3u8' },
    { name: '如意资源', url: 'https://cj.rycjapi.com/api.php/provide/vod' },
  ],
  liveSources: [],
};

const fetchSourceList = vi.mocked(api.fetchSourceList);

beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState({
    customAPIs: [],
    selectedKeys: [],
    envSources: [],
    envKeysSeen: [],
    subscriptions: [],
    envSubsSeen: [],
    liveEnvSources: [],
    liveEnvKeysSeen: [],
    liveSubscriptions: [],
    liveSelectedUrls: [],
    yellowFilter: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('applyEnvPresets', () => {
  it('写入预置点播源与直播源，并自动勾选/启用', async () => {
    await applyEnvPresets(
      status({
        defaultSources: [{ key: 'env_0', name: '预置源', url: 'https://example.com/api.php/provide/vod' }],
        defaultLiveSources: [{ key: 'env_1', name: '预置直播', url: 'https://example.com/list.m3u' }],
      })
    );

    const s = useAppStore.getState();
    expect(s.envSources.map((x) => x.key)).toEqual(['env_0']);
    expect(s.selectedKeys).toContain('env_0');
    expect(s.liveEnvSources.map((x) => x.key)).toEqual(['env_1']);
    expect(s.liveSelectedUrls).toContain('https://example.com/list.m3u');
    // 没有预置订阅时不应触发订阅拉取
    expect(fetchSourceList).not.toHaveBeenCalled();
  });

  it('预置订阅：拉取并导入源，写入订阅条目与 seen 标记', async () => {
    fetchSourceList.mockResolvedValue(payload);

    await applyEnvPresets(status({ defaultSubscriptions: [{ url: SUB_URL, name: 'LibreTV-List' }] }));

    expect(fetchSourceList).toHaveBeenCalledWith(SUB_URL);
    const s = useAppStore.getState();
    expect(s.subscriptions.map((x) => x.url)).toEqual([SUB_URL]);
    expect(s.customAPIs.map((x) => x.url)).toEqual(payload.sources.map((x) => x.url));
    expect(s.customAPIs.map((x) => x.name)).toEqual(['非凡影视', '如意资源']);
    expect(s.envSubsSeen).toContain(SUB_URL);
  });

  it('幂等：已同步（24h 内）的预置订阅补跑时不会重复拉取', async () => {
    fetchSourceList.mockResolvedValue(payload);

    await applyEnvPresets(status({ defaultSubscriptions: [{ url: SUB_URL }] }));
    await applyEnvPresets(status({ defaultSubscriptions: [{ url: SUB_URL }] }));

    expect(fetchSourceList).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().customAPIs).toHaveLength(payload.sources.length);
  });

  it('登录前那次失败的典型形态（401）不会抛出，也不会留下半截数据', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchSourceList.mockRejectedValue(new Error('需要登录'));

    await expect(applyEnvPresets(status({ defaultSubscriptions: [{ url: SUB_URL }] }))).resolves.toBeUndefined();

    const s = useAppStore.getState();
    expect(s.subscriptions).toHaveLength(0);
    expect(s.customAPIs).toHaveLength(0);
    // 失败不写 seen：下次（登录成功后的补跑）仍会重试
    expect(s.envSubsSeen).not.toContain(SUB_URL);
    expect(warn).toHaveBeenCalled();
  });

  it('用户删除过的预置订阅不会被重新导入', async () => {
    useAppStore.setState({ envSubsSeen: [SUB_URL] });
    fetchSourceList.mockResolvedValue(payload);

    await applyEnvPresets(status({ defaultSubscriptions: [{ url: SUB_URL }] }));

    expect(fetchSourceList).not.toHaveBeenCalled();
  });
});

describe('applyEnvPresets · DEFAULT_RECOMMEND_SOURCE（issue #918）', () => {
  it('未配置时不改动推荐数据源', async () => {
    useAppStore.setState({ recommendSource: 'hot-list', recommendSourceTouched: false });
    await applyEnvPresets(status());
    expect(useAppStore.getState().recommendSource).toBe('hot-list');
  });

  it('对未主动选择过的用户应用部署者默认值，且不打「已选择」标记', async () => {
    useAppStore.setState({ recommendSource: 'hot-list', recommendSourceTouched: false });
    await applyEnvPresets(status({ defaultRecommendSource: 'douban' }));
    expect(useAppStore.getState().recommendSource).toBe('douban');
    // 自动预置不算用户主动选择：部署者日后调整默认值时该用户应跟随
    expect(useAppStore.getState().recommendSourceTouched).toBe(false);
  });

  it('已主动选择过的用户（如 bangumi）不被覆盖', async () => {
    useAppStore.setState({ recommendSource: 'bangumi', recommendSourceTouched: true });
    await applyEnvPresets(status({ defaultRecommendSource: 'douban' }));
    expect(useAppStore.getState().recommendSource).toBe('bangumi');
  });

  it('显式选回 hot-list 的用户（带「已选择」标记）不被覆盖', async () => {
    useAppStore.setState({ recommendSource: 'hot-list', recommendSourceTouched: true });
    await applyEnvPresets(status({ defaultRecommendSource: 'douban' }));
    expect(useAppStore.getState().recommendSource).toBe('hot-list');
  });

  it('存量用户：从未打过标记但偏好已不是出厂默认值的（老版本手动改过）不被覆盖', async () => {
    useAppStore.setState({ recommendSource: 'bangumi', recommendSourceTouched: false });
    await applyEnvPresets(status({ defaultRecommendSource: 'douban' }));
    expect(useAppStore.getState().recommendSource).toBe('bangumi');
  });

  it('重复调用幂等：应用一次后再调用不改变结果', async () => {
    useAppStore.setState({ recommendSource: 'hot-list', recommendSourceTouched: false });
    await applyEnvPresets(status({ defaultRecommendSource: 'douban' }));
    await applyEnvPresets(status({ defaultRecommendSource: 'douban' }));
    expect(useAppStore.getState().recommendSource).toBe('douban');
    expect(useAppStore.getState().recommendSourceTouched).toBe(false);
  });
});

describe('applyEnvPresets · DEFAULT_IMAGE_MODE', () => {
  it('未配置时不改动封面图加载方式', async () => {
    useAppStore.setState({ imageProxyMode: 'direct', imageProxyModeTouched: false });
    await applyEnvPresets(status());
    expect(useAppStore.getState().imageProxyMode).toBe('direct');
  });

  it('对未主动选择过的用户应用部署者默认值，且不打「已选择」标记', async () => {
    useAppStore.setState({ imageProxyMode: 'direct', imageProxyModeTouched: false });
    await applyEnvPresets(status({ defaultImageMode: 'proxy' }));
    expect(useAppStore.getState().imageProxyMode).toBe('proxy');
    // 自动预置不算用户主动选择：部署者日后调整默认值时该用户应跟随
    expect(useAppStore.getState().imageProxyModeTouched).toBe(false);
  });

  it('已主动选择过的用户（如 proxy）不被覆盖', async () => {
    useAppStore.setState({ imageProxyMode: 'proxy', imageProxyModeTouched: true });
    await applyEnvPresets(status({ defaultImageMode: 'proxy' }));
    expect(useAppStore.getState().imageProxyMode).toBe('proxy');
  });

  it('显式选回 direct 的用户（带「已选择」标记）不被覆盖', async () => {
    useAppStore.setState({ imageProxyMode: 'direct', imageProxyModeTouched: true });
    await applyEnvPresets(status({ defaultImageMode: 'proxy' }));
    expect(useAppStore.getState().imageProxyMode).toBe('direct');
  });

  it('存量用户：从未打过标记但偏好已不是出厂默认值的（老版本手动改过）不被覆盖', async () => {
    useAppStore.setState({ imageProxyMode: 'proxy', imageProxyModeTouched: false });
    await applyEnvPresets(status({ defaultImageMode: 'direct' }));
    expect(useAppStore.getState().imageProxyMode).toBe('proxy');
  });

  it('custom 模式（需手填模板，视为明确选择）不被覆盖', async () => {
    useAppStore.setState({ imageProxyMode: 'custom', imageProxyModeTouched: false });
    await applyEnvPresets(status({ defaultImageMode: 'direct' }));
    expect(useAppStore.getState().imageProxyMode).toBe('custom');
  });

  it('重复调用幂等：应用一次后再调用不改变结果', async () => {
    useAppStore.setState({ imageProxyMode: 'direct', imageProxyModeTouched: false });
    await applyEnvPresets(status({ defaultImageMode: 'proxy' }));
    await applyEnvPresets(status({ defaultImageMode: 'proxy' }));
    expect(useAppStore.getState().imageProxyMode).toBe('proxy');
    expect(useAppStore.getState().imageProxyModeTouched).toBe(false);
  });
});

describe('applyEnvPresets · DEFAULT_SUBSCRIPTIONS 的 refreshDays', () => {
  const subs = (refreshDays?: number) => status({ defaultSubscriptions: [{ url: SUB_URL, refreshDays }] });
  const at = (iso: string) => vi.setSystemTime(new Date(iso));

  it('未满周期不刷新，满周期即刷新', async () => {
    vi.useFakeTimers();
    fetchSourceList.mockResolvedValue(payload);

    at('2026-01-01T00:00:00Z');
    await applyEnvPresets(subs(10));
    expect(fetchSourceList).toHaveBeenCalledTimes(1);

    // 差 1 秒满 10 天：仍按缓存跳过
    at('2026-01-10T23:59:59Z');
    await applyEnvPresets(subs(10));
    expect(fetchSourceList).toHaveBeenCalledTimes(1);

    // 满 10 天：静默刷新
    at('2026-01-11T00:00:00Z');
    await applyEnvPresets(subs(10));
    expect(fetchSourceList).toHaveBeenCalledTimes(2);
  });

  it('未配置 refreshDays 时按 1 天', async () => {
    vi.useFakeTimers();
    fetchSourceList.mockResolvedValue(payload);

    at('2026-01-01T00:00:00Z');
    await applyEnvPresets(subs());
    expect(fetchSourceList).toHaveBeenCalledTimes(1);

    at('2026-01-01T23:00:00Z');
    await applyEnvPresets(subs());
    expect(fetchSourceList).toHaveBeenCalledTimes(1);

    at('2026-01-02T00:00:00Z');
    await applyEnvPresets(subs());
    expect(fetchSourceList).toHaveBeenCalledTimes(2);
  });

  it('改小 refreshDays 后按新周期判断（不因上次同步于旧周期内而永久跳过）', async () => {
    vi.useFakeTimers();
    fetchSourceList.mockResolvedValue(payload);

    at('2026-01-01T00:00:00Z');
    await applyEnvPresets(subs(30));
    expect(fetchSourceList).toHaveBeenCalledTimes(1);

    // 部署者把周期从 30 天改成 1 天：已过 2 天，应立即刷新
    at('2026-01-03T00:00:00Z');
    await applyEnvPresets(subs(1));
    expect(fetchSourceList).toHaveBeenCalledTimes(2);
  });
});

describe('自动刷新周期判定', () => {
  const base: SourceSubscription = { url: SUB_URL };
  const DAY = 86_400_000;

  it('未设周期一律不自动刷新（默认仍是纯手动）', () => {
    expect(canAutoRefresh({ ...base, lastSync: 0 })).toBe(false);
    expect(isRefreshDue(0, undefined)).toBe(false);
  });

  it('从未同步过视为该刷新', () => {
    expect(isRefreshDue(undefined, 1)).toBe(true);
    expect(canAutoRefresh({ ...base, refreshDays: 1 })).toBe(true);
  });

  it('满周期才刷新，边界与旧版 24h 语义一致', () => {
    const now = 1_700_000_000_000;
    expect(isRefreshDue(now - DAY + 1, 1, now)).toBe(false);
    expect(isRefreshDue(now - DAY, 1, now)).toBe(true);
    expect(isRefreshDue(now - 7 * DAY, 7, now)).toBe(true);
  });

  it('连续失败触顶后暂停，未触顶仍刷新', () => {
    const stale = { ...base, refreshDays: 1, lastSync: 0 };
    expect(canAutoRefresh({ ...stale, failStreak: 2 })).toBe(true);
    expect(canAutoRefresh({ ...stale, failStreak: 3 })).toBe(false);
  });

  it('客户端缺省周期与服务端常量一致（两处重复定义，防漂移）', () => {
    expect(DEFAULT_ENV_SUB_REFRESH_DAYS).toBe(ENV_DEFAULT_DAYS);
  });
});

describe('autoRefreshSubscriptions', () => {
  const now = Date.now();
  const DAY = 86_400_000;

  it('只刷新「设了周期且已到期」的订阅', async () => {
    useAppStore.setState({
      subscriptions: [
        { url: 'https://a.example.com/due.json', refreshDays: 1, lastSync: now - 2 * DAY },
        { url: 'https://b.example.com/fresh.json', refreshDays: 1, lastSync: now - 1000 },
        { url: 'https://c.example.com/manual.json', lastSync: now - 30 * DAY },
      ],
    });
    fetchSourceList.mockResolvedValue(payload);

    await autoRefreshSubscriptions(now);

    expect(fetchSourceList).toHaveBeenCalledTimes(1);
    expect(fetchSourceList).toHaveBeenCalledWith('https://a.example.com/due.json');
  });

  it('失败计入连续失败次数，成功清零', async () => {
    useAppStore.setState({
      subscriptions: [{ url: 'https://a.example.com/x.json', refreshDays: 1, lastSync: 0, failStreak: 1 }],
    });
    fetchSourceList.mockRejectedValue(new Error('boom'));

    await autoRefreshSubscriptions(now);
    expect(useAppStore.getState().subscriptions[0].failStreak).toBe(2);

    fetchSourceList.mockResolvedValue(payload);
    await autoRefreshSubscriptions(now);
    expect(useAppStore.getState().subscriptions[0].failStreak).toBe(0);
  });

  it('鉴权失败不计入连续失败（会话问题不是源问题）', async () => {
    useAppStore.setState({
      subscriptions: [{ url: 'https://a.example.com/x.json', refreshDays: 1, lastSync: 0, failStreak: 1 }],
    });
    fetchSourceList.mockRejectedValue(new ApiError('需要登录', 401));

    await autoRefreshSubscriptions(now);

    const sub = useAppStore.getState().subscriptions[0];
    expect(sub.failStreak).toBe(1);
    expect(sub.lastStatus).toBe('error');
  });

  it('触顶的订阅不会再被自动刷新', async () => {
    useAppStore.setState({
      subscriptions: [{ url: 'https://a.example.com/x.json', refreshDays: 1, lastSync: 0, failStreak: 3 }],
    });

    await autoRefreshSubscriptions(now);

    expect(fetchSourceList).not.toHaveBeenCalled();
  });
});

describe('applyEnvPresets · 用户订阅自动刷新的触发条件', () => {
  const DAY = 86_400_000;

  const seedDue = () =>
    useAppStore.setState({
      subscriptions: [{ url: 'https://a.example.com/x.json', refreshDays: 1, lastSync: Date.now() - 2 * DAY }],
    });

  it('未登录（verified=false）时不触发，避免白打一串 401', async () => {
    seedDue();
    await applyEnvPresets(status());
    expect(fetchSourceList).not.toHaveBeenCalled();
  });

  it('已登录时触发', async () => {
    seedDue();
    fetchSourceList.mockResolvedValue(payload);
    await applyEnvPresets(status({ verified: true }));
    expect(fetchSourceList).toHaveBeenCalledTimes(1);
  });

  it('登录成功回调显式传 verified 可覆盖缓存里过期的 false', async () => {
    seedDue();
    fetchSourceList.mockResolvedValue(payload);
    await applyEnvPresets(status(), { verified: true });
    expect(fetchSourceList).toHaveBeenCalledTimes(1);
  });
});
