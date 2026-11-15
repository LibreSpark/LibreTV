import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlaybackRecovery, describeHlsError } from './playback-recovery';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PlaybackRecovery 决策表', () => {
  it('格式硬失败直接换源，重试无意义', () => {
    const r = new PlaybackRecovery();
    for (const details of [
      'manifestParsingError',
      'manifestIncompatibleCodecsError',
      'levelEmptyError',
    ]) {
      expect(r.onFatal('networkError', details).action).toBe('switch-source');
    }
  });

  it('networkError：指数退避，超过上限换源', () => {
    const r = new PlaybackRecovery();
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      const d = r.onFatal('networkError', 'fragLoadError');
      if (d.action === 'retry') {
        delays.push(d.delayMs);
        expect(d.attempt).toBe(i + 1);
      } else {
        expect(d).toMatchObject({ action: 'switch-source' });
        expect(d.action === 'switch-source' && d.reason).toContain('3 次');
      }
    }
    expect(delays).toEqual([800, 1600, 3200]);
  });

  it('mediaError：先 recoverMediaError，第 2 次追加 swapAudio，再失败换源', () => {
    const r = new PlaybackRecovery();
    expect(r.onFatal('mediaError', 'bufferAppendError')).toMatchObject({
      action: 'recover-media',
      swapAudio: false,
      attempt: 1,
    });
    expect(r.onFatal('mediaError', 'bufferAppendError')).toMatchObject({
      action: 'recover-media',
      swapAudio: true,
      attempt: 2,
    });
    expect(r.onFatal('mediaError', 'bufferAppendError').action).toBe('switch-source');
  });

  it('密钥加载失败按网络错误退避，超过重试上限后换源', () => {
    const r = new PlaybackRecovery();
    expect(r.onFatal('networkError', 'keyLoadError')).toMatchObject({
      action: 'retry', attempt: 1, delayMs: 800,
    });
    r.onFatal('networkError', 'keyLoadError');
    r.onFatal('networkError', 'keyLoadError');
    expect(r.onFatal('networkError', 'keyLoadError').action).toBe('switch-source');
  });

  it('直播滑动窗口刷新失败（levelLoadError）按网络错误退避', () => {
    const r = new PlaybackRecovery();
    expect(r.onFatal('networkError', 'levelLoadError')).toMatchObject({
      action: 'retry', attempt: 1, delayMs: 800,
    });
  });

  it('未知致命类型换源', () => {
    const r = new PlaybackRecovery();
    expect(r.onFatal('someWeirdError', 'whatever').action).toBe('switch-source');
  });

  it('dispose 后一律忽略', () => {
    const r = new PlaybackRecovery();
    r.dispose();
    expect(r.onFatal('networkError', 'fragLoadError').action).toBe('ignore');
  });
});

describe('markHealthy 静默窗', () => {
  it('静默窗外的成功清零计数，重新开始退避', () => {
    const r = new PlaybackRecovery();
    r.onFatal('networkError', 'fragLoadError'); // attempt 1
    r.onFatal('networkError', 'fragLoadError'); // attempt 2
    vi.advanceTimersByTime(3001); // 出静默窗
    r.markHealthy();
    const d = r.onFatal('networkError', 'fragLoadError');
    expect(d.action === 'retry' && d.attempt).toBe(1);
  });

  it('静默窗内的成功不清零（防重试成功瞬间的噪声），计数继续累积', () => {
    const r = new PlaybackRecovery();
    r.onFatal('networkError', 'fragLoadError'); // attempt 1
    r.markHealthy(); // 动作后 3s 内：忽略
    const d = r.onFatal('networkError', 'fragLoadError');
    expect(d.action === 'retry' && d.attempt).toBe(2);
  });
});

describe('schedule', () => {
  it('按延迟执行任务', () => {
    const r = new PlaybackRecovery();
    const task = vi.fn();
    r.schedule(1000, task);
    expect(task).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('dispose 取消未执行的任务', () => {
    const r = new PlaybackRecovery();
    const task = vi.fn();
    r.schedule(1000, task);
    r.dispose();
    vi.advanceTimersByTime(2000);
    expect(task).not.toHaveBeenCalled();
  });
});

describe('describeHlsError', () => {
  it('常见 details 映射中文文案', () => {
    expect(describeHlsError('networkError', 'manifestLoadError')).toBe('播放列表加载失败');
    expect(describeHlsError('networkError', 'fragLoadError')).toBe('视频分片加载失败');
    expect(describeHlsError('networkError', 'keyLoadError')).toBe('解密密钥加载失败');
    expect(describeHlsError('mediaError', '')).toBe('媒体解码错误');
    expect(describeHlsError('otherError', 'xyz')).toBe('播放错误（xyz）');
  });
});
