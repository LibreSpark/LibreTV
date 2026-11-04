import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isWebAudioSafeForVideo, VOLUME_BOOST_GAIN } from './volume-boost';

/**
 * 纯逻辑单测：CORS 安全判定。音频图本身依赖真实浏览器 AudioContext，
 * 由 headless 浏览器实测覆盖，这里只验证「哪些源允许接入」的守卫。
 */
describe('isWebAudioSafeForVideo', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      location: { href: 'http://localhost:37674/watch', origin: 'http://localhost:37674' },
    });
  });

  const video = (src: string, crossOrigin = '') =>
    ({ currentSrc: src, src, crossOrigin }) as unknown as HTMLVideoElement;

  it('空 src 不安全', () => {
    expect(isWebAudioSafeForVideo(video(''))).toBe(false);
  });

  it('blob: / data: 源（hls.js MSE 产物）安全', () => {
    expect(isWebAudioSafeForVideo(video('blob:http://localhost:37674/abc'))).toBe(true);
    expect(isWebAudioSafeForVideo(video('data:audio/wav;base64,AAAA'))).toBe(true);
  });

  it('同源直连与本站代理路径安全', () => {
    expect(isWebAudioSafeForVideo(video('http://localhost:37674/api/proxy?url=x'))).toBe(true);
    expect(isWebAudioSafeForVideo(video('/api/live/stream?url=x'))).toBe(true);
  });

  it('跨域且未开 CORS 的直连流不安全（接入会被浏览器静音）', () => {
    expect(isWebAudioSafeForVideo(video('http://1.2.3.4/live.ts'))).toBe(false);
  });

  it('跨域但已设 crossOrigin=anonymous 安全（点播源）', () => {
    expect(isWebAudioSafeForVideo(video('https://cdn.example.com/a.m3u8', 'anonymous'))).toBe(true);
  });

  it('放大倍数在用户要求的 1.5~2 倍区间内', () => {
    expect(VOLUME_BOOST_GAIN).toBeGreaterThanOrEqual(1.5);
    expect(VOLUME_BOOST_GAIN).toBeLessThanOrEqual(2);
  });
});
