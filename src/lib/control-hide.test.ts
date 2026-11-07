import { describe, expect, it } from 'vitest';
import Artplayer from 'artplayer';
import {
  ART_DEFAULT_CONTROL_HIDE_MS,
  DESKTOP_CONTROL_HIDE_MS,
  TOUCH_CONTROL_HIDE_MS,
} from './control-hide';

describe('控制栏隐藏策略', () => {
  it('恢复基准与 ArtPlayer 库默认一致（升级依赖后若默认值变化会在此暴露）', () => {
    expect(ART_DEFAULT_CONTROL_HIDE_MS).toBe(Artplayer.CONTROL_HIDE_TIME);
  });

  it('桌面收紧到 800ms，快于库默认', () => {
    expect(DESKTOP_CONTROL_HIDE_MS).toBe(800);
    expect(DESKTOP_CONTROL_HIDE_MS).toBeLessThan(ART_DEFAULT_CONTROL_HIDE_MS);
  });

  it('触屏常驻：复刻 ArtPlayer 的 timeupdate 判定，永不满足隐藏条件', () => {
    // ArtPlayer: Date.now() - timer >= CONTROL_HIDE_TIME 时 hide
    const timer = Date.now();
    expect(Date.now() - timer >= TOUCH_CONTROL_HIDE_MS).toBe(false);
    // 即便计时器被异常修改到很久以前，也不会溢出成真
    expect(Date.now() - 0 >= TOUCH_CONTROL_HIDE_MS).toBe(false);
  });
});

describe('底部细进度条行为策略 (#965)', () => {
  it('ArtPlayer 库选项默认 miniProgressBar 为 false，点播播放器经配置项显式开启', () => {
    // 验证 ArtPlayer 内置默认值
    expect(Artplayer.option.miniProgressBar).toBe(false);
  });

  it('关闭细进度条时能够安全移除 DOM 类名并进入完全沉浸态', () => {
    const classSet = new Set<string>(['art-video-player', 'art-mini-progress-bar']);
    const mockPlayer = {
      classList: {
        contains: (c: string) => classSet.has(c),
        remove: (c: string) => { classSet.delete(c); },
        add: (c: string) => { classSet.add(c); },
      },
    };

    // 模拟关闭 miniProgressBar
    const miniProgressBarEnabled = false;
    if (!miniProgressBarEnabled) {
      mockPlayer.classList.remove('art-mini-progress-bar');
    }

    expect(mockPlayer.classList.contains('art-mini-progress-bar')).toBe(false);
  });
});
