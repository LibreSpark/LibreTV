import { describe, expect, it } from 'vitest';
import { LiveNetworkRecovery } from './live-playback-recovery';

describe('LiveNetworkRecovery', () => {
  it('连续网络错误超过上限才停止恢复', () => {
    const recovery = new LiveNetworkRecovery(5);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(recovery.onNetworkError()).toEqual({ action: 'retry', attempt });
    }
    expect(recovery.onNetworkError()).toEqual({ action: 'stop', attempt: 6 });
  });

  it('成功加载媒体分片后清零连续错误计数', () => {
    const recovery = new LiveNetworkRecovery(2);
    recovery.onNetworkError();
    recovery.onNetworkError();
    recovery.markFragmentLoaded();
    expect(recovery.consecutiveFailures).toBe(0);
    expect(recovery.onNetworkError()).toEqual({ action: 'retry', attempt: 1 });
  });

  it('仅刷新 level manifest 不会错误地清零分片故障次数', () => {
    const recovery = new LiveNetworkRecovery(1);
    recovery.onNetworkError();
    expect(recovery.consecutiveFailures).toBe(1);
    expect(recovery.onNetworkError()).toEqual({ action: 'stop', attempt: 2 });
  });
});
