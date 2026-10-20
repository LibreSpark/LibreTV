import { describe, expect, it } from 'vitest';
import {
  MAX_CONTINUOUS_STEP_SECONDS,
  MIN_MARK_GAP_SECONDS,
  hasCrossedOutro,
  isIntroActive,
  resolveSkipWindow,
  skipMarkKey,
  validateIntroEnd,
  validateOutroStart,
  type SkipMark,
} from './skip-marks';

const mark = (introEnd?: number, outroStart?: number): SkipMark => ({
  introEnd,
  outroStart,
  updatedAt: 0,
});

describe('skipMarkKey', () => {
  it('空白、标点、大小写归一后指向同一个标记', () => {
    expect(skipMarkKey('摔跤吧！爸爸', 'a:1')).toBe(skipMarkKey(' 摔跤吧!爸爸 ', 'b:2'));
    expect(skipMarkKey('Hello, World!', 'a:1')).toBe(skipMarkKey('hello world', 'b:2'));
  });

  it('同剧换源共享标记：标题相同、兜底键不同也得到同一个键', () => {
    expect(skipMarkKey('庆余年', 'custom_0:123')).toBe(skipMarkKey('庆余年', 'sub_ab_1:456'));
  });

  it('标题缺失或为占位文案时退回 source:vod 兜底键', () => {
    expect(skipMarkKey(undefined, 'custom_0:123')).toBe('f:custom_0:123');
    expect(skipMarkKey('', 'custom_0:123')).toBe('f:custom_0:123');
    expect(skipMarkKey('未知视频', 'custom_0:123')).toBe('f:custom_0:123');
  });

  it('不同的剧不会互相串标记', () => {
    expect(skipMarkKey('庆余年', 'a')).not.toBe(skipMarkKey('庆余年2', 'a'));
  });
});

describe('resolveSkipWindow', () => {
  it('合法标记原样返回', () => {
    expect(resolveSkipWindow(mark(45, 1200), 2400)).toEqual({ introEnd: 45, outroStart: 1200 });
  });

  it('无标记、时长缺失或非有限时返回空窗口', () => {
    expect(resolveSkipWindow(undefined, 2400)).toEqual({});
    expect(resolveSkipWindow(mark(45, 1200), 0)).toEqual({});
    expect(resolveSkipWindow(mark(45, 1200), Number.NaN)).toEqual({});
    expect(resolveSkipWindow(mark(45, 1200), Number.POSITIVE_INFINITY)).toEqual({});
  });

  it('越界/过小的字段被逐项剔除', () => {
    // 片头 >= 总时长 - 2、片尾 >= 总时长 - 2、片头 < 3、片尾 < 5
    expect(resolveSkipWindow(mark(2399), 2400)).toEqual({});
    expect(resolveSkipWindow(mark(undefined, 2399), 2400)).toEqual({});
    expect(resolveSkipWindow(mark(2), 2400)).toEqual({});
    expect(resolveSkipWindow(mark(undefined, 4), 2400)).toEqual({});
  });

  it('片头与片尾间隔不足时保留片头、丢弃片尾', () => {
    expect(resolveSkipWindow(mark(45, 45 + MIN_MARK_GAP_SECONDS - 1), 2400)).toEqual({ introEnd: 45 });
    expect(resolveSkipWindow(mark(45, 45 + MIN_MARK_GAP_SECONDS), 2400)).toEqual({
      introEnd: 45,
      outroStart: 45 + MIN_MARK_GAP_SECONDS,
    });
  });

  it('损坏的持久化数据（负数/NaN）不会抛错', () => {
    expect(resolveSkipWindow(mark(-5, Number.NaN), 2400)).toEqual({});
  });
});

describe('isIntroActive', () => {
  const window = { introEnd: 45 };

  it('片头区间内为真，收尾余量内为假', () => {
    expect(isIntroActive(0, window)).toBe(true);
    expect(isIntroActive(43.5, window)).toBe(true);
    expect(isIntroActive(44.5, window)).toBe(false);
    expect(isIntroActive(45, window)).toBe(false);
    expect(isIntroActive(46, window)).toBe(false);
  });

  it('没有片头标记或位置非法时为假', () => {
    expect(isIntroActive(10, {})).toBe(false);
    expect(isIntroActive(Number.NaN, window)).toBe(false);
    expect(isIntroActive(-1, window)).toBe(false);
  });
});

describe('hasCrossedOutro', () => {
  const window = { outroStart: 1200 };

  it('连续小步前进越过片尾起点才触发', () => {
    expect(hasCrossedOutro(1199.5, 1200.25, window)).toBe(true);
    expect(hasCrossedOutro(1200.2, 1201, window)).toBe(false); // 已经越过
    expect(hasCrossedOutro(1199.5, 1199.9, window)).toBe(false); // 尚未到达
    expect(hasCrossedOutro(1201, 1200.5, window)).toBe(false); // 倒退
  });

  it('大跨度拖动/进度恢复不触发自动跳', () => {
    expect(hasCrossedOutro(0, 1300, window)).toBe(false);
    expect(hasCrossedOutro(1190, 1200 + MAX_CONTINUOUS_STEP_SECONDS, window)).toBe(false);
    expect(
      hasCrossedOutro(1200 - MAX_CONTINUOUS_STEP_SECONDS / 2, 1200 + MAX_CONTINUOUS_STEP_SECONDS / 2, window)
    ).toBe(true);
  });

  it('没有片尾标记或时间非法时为假', () => {
    expect(hasCrossedOutro(1199, 1201, {})).toBe(false);
    expect(hasCrossedOutro(Number.NaN, 1201, window)).toBe(false);
    expect(hasCrossedOutro(1199, Number.NaN, window)).toBe(false);
  });
});

describe('validateIntroEnd', () => {
  it('接受合理值', () => {
    expect(validateIntroEnd(30, 2400)).toBeNull();
    expect(validateIntroEnd(MIN_MARK_GAP_SECONDS, 0, mark(undefined, MIN_MARK_GAP_SECONDS * 2))).toBeNull();
  });

  it('拒绝过早、非法与贴近结尾的值', () => {
    expect(validateIntroEnd(Number.NaN, 2400)).not.toBeNull();
    expect(validateIntroEnd(0, 2400)).not.toBeNull();
    expect(validateIntroEnd(2, 2400)).not.toBeNull();
    expect(validateIntroEnd(2399, 2400)).not.toBeNull();
  });

  it('与已有片尾标记间隔不足时拒绝', () => {
    expect(validateIntroEnd(30, 2400, mark(undefined, 35))).toContain(String(MIN_MARK_GAP_SECONDS));
    expect(validateIntroEnd(25, 2400, mark(undefined, 35))).toBeNull();
  });
});

describe('validateOutroStart', () => {
  it('接受合理值', () => {
    expect(validateOutroStart(1200, 2400)).toBeNull();
    expect(validateOutroStart(MIN_MARK_GAP_SECONDS + 5, 0, mark(5))).toBeNull();
  });

  it('拒绝过早、非法与贴近结尾的值', () => {
    expect(validateOutroStart(Number.NaN, 2400)).not.toBeNull();
    expect(validateOutroStart(0, 2400)).not.toBeNull();
    expect(validateOutroStart(4, 2400)).not.toBeNull();
    expect(validateOutroStart(2399, 2400)).not.toBeNull();
  });

  it('与已有片头标记间隔不足时拒绝', () => {
    expect(validateOutroStart(35, 2400, mark(30))).toContain(String(MIN_MARK_GAP_SECONDS));
    expect(validateOutroStart(40, 2400, mark(30))).toBeNull();
  });
});
