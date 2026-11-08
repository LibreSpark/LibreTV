import { describe, it, expect } from 'vitest';
import {
  MINI_PROGRESS_BAR_CLASS,
  shouldKeepMiniProgressBar,
  syncMiniProgressBar,
  type ClassListLike,
} from './mini-progress-bar';

/**
 * 行为单测：驱动的是我们自己的 syncMiniProgressBar / shouldKeepMiniProgressBar。
 * 假 classList 只是记录调用的容器，不是被测对象——最后一个用例把「库插件先挂/摘类，
 * 我们再收敛」按 ArtPlayer 的真实事件顺序模拟出来，专门盯 PR #966 漏掉的那条路径：
 * 播放中把开关拨回「开」时类名不能常驻。
 */

/** 记录调用次数的最小 classList 替身 */
function fakeClassList(initial: string[] = []) {
  const set = new Set(initial);
  const calls: string[] = [];
  const list: ClassListLike = {
    contains: (token) => set.has(token),
    add: (token) => {
      calls.push(`add:${token}`);
      set.add(token);
    },
    remove: (token) => {
      calls.push(`remove:${token}`);
      set.delete(token);
    },
  };
  return { list, calls, has: () => set.has(MINI_PROGRESS_BAR_CLASS) };
}

describe('shouldKeepMiniProgressBar', () => {
  it('仅「开启 + 控制栏已收起」保留类名', () => {
    expect(shouldKeepMiniProgressBar({ enabled: true, controlsShown: false })).toBe(true);
    expect(shouldKeepMiniProgressBar({ enabled: true, controlsShown: true })).toBe(false);
    expect(shouldKeepMiniProgressBar({ enabled: false, controlsShown: false })).toBe(false);
    expect(shouldKeepMiniProgressBar({ enabled: false, controlsShown: true })).toBe(false);
  });
});

describe('syncMiniProgressBar', () => {
  it('收起 + 开启 → 挂上类名', () => {
    const { list, has, calls } = fakeClassList();
    expect(syncMiniProgressBar(list, { enabled: true, controlsShown: false })).toBe(true);
    expect(has()).toBe(true);
    expect(calls).toEqual([`add:${MINI_PROGRESS_BAR_CLASS}`]);
  });

  it('收起 + 关闭 → 摘掉类名（收起后什么都不该留）', () => {
    const { list, has, calls } = fakeClassList([MINI_PROGRESS_BAR_CLASS]);
    expect(syncMiniProgressBar(list, { enabled: false, controlsShown: false })).toBe(false);
    expect(has()).toBe(false);
    expect(calls).toEqual([`remove:${MINI_PROGRESS_BAR_CLASS}`]);
  });

  it('控制栏可见时一律不保留：常驻类名会让底部渐变遮罩与进度圆点消失', () => {
    const { list, has } = fakeClassList([MINI_PROGRESS_BAR_CLASS]);
    syncMiniProgressBar(list, { enabled: true, controlsShown: true });
    expect(has()).toBe(false);
  });

  it('幂等：已是目标态时不重复操作 DOM', () => {
    const on = fakeClassList([MINI_PROGRESS_BAR_CLASS]);
    expect(syncMiniProgressBar(on.list, { enabled: true, controlsShown: false })).toBe(true);
    expect(on.calls).toEqual([]);

    const off = fakeClassList();
    expect(syncMiniProgressBar(off.list, { enabled: false, controlsShown: true })).toBe(false);
    expect(off.calls).toEqual([]);
  });

  it('播放器未就绪（classList 为空）时安全返回，不抛异常', () => {
    expect(syncMiniProgressBar(null, { enabled: true, controlsShown: false })).toBe(false);
    expect(syncMiniProgressBar(undefined, { enabled: false, controlsShown: false })).toBe(false);
  });

  it('模拟完整事件序列：库插件先动、我们再收敛 → 播放中来回切不留残类', () => {
    const { list, has } = fakeClassList();
    const state = { enabled: true, shown: true };
    // 库的 miniProgressBar 插件（构造时恒传 true 才在位）：控制栏显示→摘类，收起→挂类。
    // 它不认识设置项，关闭态下照样会挂；由紧随其后的收敛把它摘掉。
    const plugin = () => {
      if (state.shown) list.remove(MINI_PROGRESS_BAR_CLASS);
      else list.add(MINI_PROGRESS_BAR_CLASS);
    };
    const sync = () => syncMiniProgressBar(list, { enabled: state.enabled, controlsShown: state.shown });
    const control = (show: boolean) => {
      state.shown = show;
      plugin();
      sync();
    };

    control(false); // 收起：开启态 → 细进度条出现
    expect(has()).toBe(true);

    state.enabled = false; // 播放中在设置里关掉（对应组件里那个 useEffect）
    sync();
    expect(has()).toBe(false);

    control(true); // 鼠标回来
    control(false); // 再次收起：关闭态不该出现细条
    expect(has()).toBe(false);

    state.enabled = true; // 再打开，此时控制栏已收起 → 立即恢复
    sync();
    expect(has()).toBe(true);

    control(true); // 控制栏显示 → 插件负责摘类；这里若还挂着就是残类缺陷
    expect(has()).toBe(false);
  });
});
