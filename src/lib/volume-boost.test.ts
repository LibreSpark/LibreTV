import { describe, expect, it, vi } from 'vitest';

/**
 * 音量放大（Web Audio 增益链）行为测试。
 *
 * vitest 跑在 node 环境，没有真实 AudioContext，这里用一份结构等价的假实现：
 * 记录「哪个节点连到哪个节点」，因为本模块唯一会伤害用户的地方就是接错线——
 * `createMediaElementSource` 之后元素的输出只走音频图，一旦拆链不接回去就是永久静音。
 *
 * 模块级状态（sharedCtx / attached / pending / 手势监听）会跨用例残留，
 * 所以每个用例都 resetModules() 后动态 import，拿一份干净实现。
 */

/** 归一化连线：去掉实例编号，只关心拓扑（mediaSource->gain 等） */
const norm = (edge: string) => edge.replace(/#\d+/g, '');

interface Harness {
  /** 当前生效的连线（已归一化） */
  edges: () => string[];
  rawEdges: () => string[];
  stats: { mediaSourceCalls: number; ctxCreations: number; added: string[]; removed: string[] };
  /** 关键参数读数：gain.value 与限幅器的 threshold/knee/ratio */
  nodes: () => { gain?: number; threshold?: number; knee?: number; ratio?: number };
}

type FakeNode = {
  __name: string;
  connect: (target: { __name: string }) => void;
  disconnect: () => void;
  gain?: { value: number };
  threshold?: { value: number };
  knee?: { value: number };
  ratio?: { value: number };
  attack?: { value: number };
  release?: { value: number };
};

function installFakeAudio(initialState: 'running' | 'suspended' = 'running'): Harness {
  const links = new Set<string>();
  const stats = { mediaSourceCalls: 0, ctxCreations: 0, added: [] as string[], removed: [] as string[] };
  let seq = 0;
  const created: Record<string, FakeNode> = {};

  const mk = (prefix: string, extra: Partial<FakeNode> = {}): FakeNode => {
    const name = `${prefix}#${seq++}`;
    const node: FakeNode = {
      __name: name,
      connect: (target: { __name: string }) => { links.add(`${name}->${target.__name}`); },
      disconnect: () => { for (const l of Array.from(links)) if (l.startsWith(`${name}->`)) links.delete(l); },
      ...extra,
    };
    created[prefix] = node;
    return node;
  };

  // destination 在建链前就存在，编号固定为 #0
  const destination = mk('destination');
  const seenElements = new WeakSet<object>();

  class FakeAudioContext {
    state: string = initialState;
    destination = destination;
    constructor() {
      stats.ctxCreations += 1;
    }
    resume = async () => { this.state = 'running'; };
    createMediaElementSource = (el: object) => {
      stats.mediaSourceCalls += 1;
      // 真实规范：同一元素只能调用一次，重复调用抛 InvalidStateError
      if (seenElements.has(el)) throw new Error('InvalidStateError');
      seenElements.add(el);
      return mk('mediaSource');
    };
    createGain = () => mk('gain', { gain: { value: 1 } });
    createDynamicsCompressor = () =>
      mk('compressor', {
        threshold: { value: -24 }, knee: { value: 30 }, ratio: { value: 12 },
        attack: { value: 0.003 }, release: { value: 0.25 },
      });
  }

  vi.stubGlobal('window', {
    location: { href: 'http://localhost:8080/watch', origin: 'http://localhost:8080' },
    AudioContext: FakeAudioContext,
  });
  vi.stubGlobal('document', {
    addEventListener: (name: string) => { stats.added.push(name); },
    removeEventListener: (name: string) => { stats.removed.push(name); },
  });

  return {
    rawEdges: () => Array.from(links),
    edges: () => Array.from(links).map(norm),
    stats,
    nodes: () => ({
      gain: created.gain?.gain?.value,
      threshold: created.compressor?.threshold?.value,
      knee: created.compressor?.knee?.value,
      ratio: created.compressor?.ratio?.value,
    }),
  };
}

/** 取一份干净的模块实现（模块级状态不跨用例） */
async function freshModule() {
  vi.resetModules();
  return await import('./volume-boost');
}

/** 造一个 video 元素替身：currentSrc 决定 CORS 安全性 */
const video = (currentSrc: string, crossOrigin = '') =>
  ({ currentSrc, src: currentSrc, crossOrigin }) as unknown as HTMLVideoElement;

const BOOSTED = ['mediaSource->gain', 'gain->compressor', 'compressor->destination'];

describe('isWebAudioSafeForVideo', () => {
  it('空 src 不安全', async () => {
    const mod = await freshModule();
    expect(mod.isWebAudioSafeForVideo(video(''))).toBe(false);
  });

  it('blob: / data: 源（hls.js MSE 产物）安全', async () => {
    installFakeAudio();
    const mod = await freshModule();
    expect(mod.isWebAudioSafeForVideo(video('blob:http://localhost:8080/abc'))).toBe(true);
    expect(mod.isWebAudioSafeForVideo(video('data:audio/wav;base64,AAAA'))).toBe(true);
  });

  it('同源直连与本站代理路径安全', async () => {
    installFakeAudio();
    const mod = await freshModule();
    expect(mod.isWebAudioSafeForVideo(video('http://localhost:8080/api/proxy?url=x'))).toBe(true);
    expect(mod.isWebAudioSafeForVideo(video('/api/live/stream?url=x'))).toBe(true);
  });

  it('跨域且未开 CORS 的直连流不安全（接入会被浏览器静音）', async () => {
    installFakeAudio();
    const mod = await freshModule();
    expect(mod.isWebAudioSafeForVideo(video('http://1.2.3.4/live.ts'))).toBe(false);
  });

  it('跨域但已设 crossOrigin=anonymous 安全（点播源）', async () => {
    installFakeAudio();
    const mod = await freshModule();
    expect(mod.isWebAudioSafeForVideo(video('https://cdn.example.com/a.m3u8', 'anonymous'))).toBe(true);
  });
});

describe('增益链接线', () => {
  it('接入后按 source → gain(1.8) → compressor(软限幅) → destination 接线', async () => {
    const h = installFakeAudio('running');
    const mod = await freshModule();
    const handle = mod.attachVolumeBoost(video('http://localhost:8080/api/proxy?url=x'));
    expect(handle).not.toBeNull();
    expect(h.edges().sort()).toEqual([...BOOSTED].sort());
    const nodes = h.nodes();
    expect(nodes.gain).toBe(mod.VOLUME_BOOST_GAIN);
    // 透明限幅：只在超过 0dBFS 时才压
    expect(nodes.threshold).toBe(0);
    expect(nodes.knee).toBe(0);
    expect(nodes.ratio).toBe(20);
  });

  it('setBoost(false) 走单位增益直通——关键回归：不能拆链留空，否则永久静音', async () => {
    const h = installFakeAudio('running');
    const mod = await freshModule();
    const handle = mod.attachVolumeBoost(video('blob:http://localhost:8080/x'))!;
    handle.setBoost(false);
    expect(h.edges()).toEqual(['mediaSource->destination']);
  });

  it('setBoost(false) 后再开回来，恢复增益 + 限幅链且不再直通', async () => {
    const h = installFakeAudio('running');
    const mod = await freshModule();
    const handle = mod.attachVolumeBoost(video('blob:http://localhost:8080/x'))!;
    handle.setBoost(false);
    handle.setBoost(true);
    expect(h.edges().sort()).toEqual([...BOOSTED].sort());
    expect(h.edges()).not.toContain('mediaSource->destination');
  });

  it('同一元素重复 attach 幂等：createMediaElementSource 只调一次、返回同一句柄', async () => {
    const h = installFakeAudio('running');
    const mod = await freshModule();
    const el = video('blob:http://localhost:8080/x');
    const first = mod.attachVolumeBoost(el);
    const second = mod.attachVolumeBoost(el);
    expect(second).toBe(first);
    expect(h.stats.mediaSourceCalls).toBe(1);
  });

  it('CORS 不安全时返回 null，且不创建 AudioContext（完全不碰音频链路）', async () => {
    const h = installFakeAudio('running');
    const mod = await freshModule();
    expect(mod.attachVolumeBoost(video('http://1.2.3.4/live.ts'))).toBeNull();
    expect(h.stats.ctxCreations).toBe(0);
    expect(h.stats.mediaSourceCalls).toBe(0);
  });

  it('dispose 断开全部节点（仅在播放器销毁时使用）', async () => {
    const h = installFakeAudio('running');
    const mod = await freshModule();
    mod.attachVolumeBoost(video('blob:http://localhost:8080/x'))!.dispose();
    expect(h.edges()).toEqual([]);
  });

  it('放大倍数是合理正增益', async () => {
    const mod = await freshModule();
    expect(mod.VOLUME_BOOST_GAIN).toBeGreaterThan(1);
    expect(mod.VOLUME_BOOST_GAIN).toBeLessThanOrEqual(3);
  });
});

describe('suspended 补挂与手势监听生命周期', () => {
  it('suspended 时不改道；resume 完成后自动补挂，并解绑手势监听', async () => {
    const h = installFakeAudio('suspended');
    const mod = await freshModule();
    const handle = mod.attachVolumeBoost(video('blob:http://localhost:8080/x'));
    expect(handle).not.toBeNull();
    // 未建链，避免 suspended 状态下改道造成无声
    expect(h.rawEdges()).toEqual([]);
    expect(h.stats.mediaSourceCalls).toBe(0);
    // 只有存在待补挂项时才绑手势
    expect(h.stats.added.sort()).toEqual(['keydown', 'pointerdown', 'touchstart']);

    await Promise.resolve();
    await Promise.resolve();

    expect(h.edges().sort()).toEqual([...BOOSTED].sort());
    expect(h.stats.removed.sort()).toEqual(['keydown', 'pointerdown', 'touchstart']);
  });

  it('running 状态下不绑任何 document 手势监听', async () => {
    const h = installFakeAudio('running');
    const mod = await freshModule();
    mod.attachVolumeBoost(video('blob:http://localhost:8080/x'));
    expect(h.stats.added).toEqual([]);
  });

  it('suspended 期间关掉放大：从待办撤掉，不建链也不留监听', async () => {
    const h = installFakeAudio('suspended');
    const mod = await freshModule();
    const handle = mod.attachVolumeBoost(video('blob:http://localhost:8080/x'))!;
    handle.setBoost(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.rawEdges()).toEqual([]);
    expect(h.stats.mediaSourceCalls).toBe(0);
    expect(h.stats.removed.sort()).toEqual(['keydown', 'pointerdown', 'touchstart']);
  });
});
