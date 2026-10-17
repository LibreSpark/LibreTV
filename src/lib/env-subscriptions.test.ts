import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEnvSubscriptions } from './env-subscriptions';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getEnvSubscriptions', () => {
  it('未配置时启用默认接口源订阅，并设置 10 天刷新周期', () => {
    vi.stubEnv('DEFAULT_SUBSCRIPTIONS', undefined);

    const subscriptions = getEnvSubscriptions();
    expect(subscriptions).toEqual([
      {
        url: 'https://raw.githubusercontent.com/rapier15sapper/ew/refs/heads/main/test.json',
        name: '影视接口源列表',
        refreshDays: 10,
      },
      { url: 'https://tv.203511.xyz/0821.json', name: 'Zoo 导航 · 荐片', refreshDays: 10 },
      { url: 'http://550.3vcn.work/wdjyys.json', name: 'Zoo 导航 · 金鹰', refreshDays: 10 },
      { url: 'https://9280.kstore.space/newwex.json', name: 'Zoo 导航 · 牛二', refreshDays: 10 },
    ]);
    expect(new Set(subscriptions.map((subscription) => subscription.url)).size).toBe(subscriptions.length);
  });

  it('允许通过环境变量覆盖默认订阅并指定刷新周期', () => {
    vi.stubEnv(
      'DEFAULT_SUBSCRIPTIONS',
      JSON.stringify([{ url: 'https://example.com/list.json/', name: '自定义源', refreshDays: 10 }])
    );

    expect(getEnvSubscriptions()).toEqual([
      { url: 'https://example.com/list.json', name: '自定义源', refreshDays: 10 },
    ]);
  });

  it('移除环境变量订阅中的重复 URL', () => {
    vi.stubEnv(
      'DEFAULT_SUBSCRIPTIONS',
      JSON.stringify(['https://example.com/list.json', { url: 'https://example.com/list.json', name: 'duplicate' }])
    );

    expect(getEnvSubscriptions()).toEqual([{ url: 'https://example.com/list.json', name: undefined, refreshDays: undefined }]);
  });

  it('显式空数组可禁用默认订阅', () => {
    vi.stubEnv('DEFAULT_SUBSCRIPTIONS', '[]');
    expect(getEnvSubscriptions()).toEqual([]);
  });
});
