/**
 * 画质工具：缓存键、展示标签、高度推断、缓存合并。
 *
 * 画质信息不在 CMS 搜索接口里，只存在于 m3u8 内部（#EXT-X-STREAM-INF 的 RESOLUTION），
 * 因此只能「探测」（拉 m3u8 解析）或「实测」（播放器解码后读 videoHeight）。
 * 本模块只负责这两个来源产出的高度值如何命名与存放，不负责获取。
 */

import type { QualityEntry } from './types';
import { tr } from '@/lib/i18n-core';

/** 画质缓存有效期：源站换片源的概率低，30 天内直接复用 */
export const QUALITY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 探测失败结果的缓存有效期。
 * 失败原因多为瞬时（超时/限流/防盗链偶发拒绝），不能像成功结果那样存 30 天，
 * 否则偶发失败会被当成永久结论，用户再也看不到画质。
 */
export const QUALITY_FAIL_TTL_MS = 2 * 60 * 1000;

/**
 * 失败原因短标签：徽章上直接显示「未测到·超时」比只藏在 tooltip 里有用，
 * 触屏没有 hover，用户更需要一眼看出「该重试」还是「该换源」。
 */
export function failureReasonLabel(error?: string): string | undefined {
  if (!error) return undefined;
  // 传输层失败（请求没送达 / 流中途断）要排在「超时」之前：
  // 这类文案本身就带「多为网关超时」的解释，先匹配超时会把归因指错
  if (/中断|断开|送达|网关拦截/.test(error)) return '连接中断';
  if (error.includes('超时')) return '超时';
  if (/HTTP (401|403)/.test(error)) return '防盗链';
  // 5xx 多为反代/网关回的错误页，和「源站不给画质」完全不是一回事
  if (/HTTP 5\d\d|\(5\d\d\)/.test(error)) return '网关异常';
  if (error.includes('未找到播放资源')) return '无资源';
  if (error.includes('无效')) return '源无效';
  return undefined;
}

/** 超时是唯一值得自动重试的失败：冷启动/CDN 抖动，同一条请求再打一次常能成 */
export function isRetryableTimeout(error?: string): boolean {
  return !!error && error.includes('超时');
}

/**
 * 条目是否仍在有效期内（唯一判定入口，写入与读取都走这里）。
 *
 * 读取路径也必须过滤：qualityMap 是持久化的，刷新页面后旧条目直接从 localStorage
 * 回到内存；而写入路径（mergeQualityEntries）只有在下次写入时才顺带清理。
 * 只清理不过滤的话，过期条目会被当成终态显示，且因为「已有结论就不再探」而永不过期。
 */
export function isQualityEntryFresh(entry: QualityEntry, now = Date.now()): boolean {
  const ttl = entry.error ? QUALITY_FAIL_TTL_MS : QUALITY_TTL_MS;
  return now - entry.timestamp < ttl;
}

/** 缓存键：按「源 + 影片」，同一源的不同剧画质不同，不能按源整体记录 */
export function qualityKey(sourceKey: string, vodId: string): string {
  return `${sourceKey}:${vodId}`;
}

/**
 * 档位容差：与档位值的偏差在此比例内才算同一档。
 *
 * 采集站普遍对片源做裁切（1920×1080 → 1924×1040、1920×960 这类），
 * 严格「必须 ≥ 档位值」会把 1040、960 都打成 720P，与用户观感相反。
 * 15% 覆盖常见的裁边与等比缩放（960 距 1080 差 11%），
 * 又足以挡住反向误判：144 不会被抬成 360P。
 */
const TIER_TOLERANCE = 0.15;

/** 档位表：高度 → 标签 */
const TIERS: ReadonlyArray<readonly [number, string]> = [
  [2160, '4K'],
  [1440, '2K'],
  [1080, '1080P'],
  [720, '720P'],
  [540, '540P'],
  [480, '480P'],
  [360, '360P'],
];

/**
 * 高度 → 展示标签：就近取档。
 * 2160 及以上统称 4K（2K/1440 单独一档，避免 1440 被误标成 1080P）。
 * 偏差超过 15% 的按原样展示（如 144 → 144P、240 → 240P）。
 */
export function qualityLabel(height?: number): string | undefined {
  if (!height || height <= 0) return undefined;
  let best: readonly [number, string] | undefined;
  for (const tier of TIERS) {
    const [value] = tier;
    if (Math.abs(value - height) > value * TIER_TOLERANCE) continue;
    if (!best || Math.abs(value - height) < Math.abs(best[0] - height)) best = tier;
  }
  return best ? best[1] : `${height}P`;
}

/** 缓存条目上限（按「源 + 影片」计）：每部剧 × 每个源一条，需防无上限膨胀 */
export const QUALITY_MAX_ENTRIES = 400;

/**
 * 把新结果合并进画质缓存（纯函数，便于单测）。
 *
 * 三条优先级规则，缺一都会让用户看到错误结论：
 * 1. 实测（play）压过探测（probe）——m3u8 里写的是源站「声明」的档位，解码出来的才是真的；
 * 2. 实测之间取较大值——ABR 起播常先选低档再升档，取最大才不会被起播档位低估；
 * 3. 探测之间，已有明确档位时不被「测不出」抹掉——否则一次偶发失败会毁掉已知的好结果。
 */
export function mergeQualityEntries(
  current: Record<string, QualityEntry>,
  incoming: Record<string, QualityEntry>,
  now = Date.now()
): Record<string, QualityEntry> {
  const next: Record<string, QualityEntry> = {};
  // 过期条目顺带清理。「测不出」（无 error）是有效结论，按长 TTL 保留，
  // 否则每次展开来源面板都会白探测一遍同一个源；失败按短 TTL 淘汰，给重试留机会
  for (const [key, entry] of Object.entries(current)) {
    if (isQualityEntryFresh(entry, now)) next[key] = entry;
  }

  for (const [key, value] of Object.entries(incoming)) {
    const prev = next[key];
    if (prev?.from === 'play') {
      if (value.from !== 'play') continue;
      const best = Math.max(prev.height ?? 0, value.height ?? 0);
      next[key] = { from: 'play', height: best || undefined, timestamp: now };
      continue;
    }
    if (prev?.from === 'probe' && value.from === 'probe' && prev.height !== undefined && value.height === undefined) {
      continue;
    }
    next[key] = value;
  }

  const overflow = Object.keys(next).length - QUALITY_MAX_ENTRIES;
  if (overflow > 0) {
    const oldest = Object.entries(next)
      .sort((a, b) => a[1].timestamp - b[1].timestamp)
      .slice(0, overflow)
      .map(([key]) => key);
    for (const key of oldest) delete next[key];
  }
  return next;
}

// —— 反馈层：徽章状态与汇总 ——
// 纯函数放这里（而非组件里）的原因：测试环境是 node（无 jsdom），
// 把「该显示什么」和「怎么画」分开，四态与汇总口径才能被单测覆盖。

export type QualityBadgeKind = 'loading' | 'value' | 'unknown' | 'failed';

export interface QualityBadgeView {
  kind: QualityBadgeKind;
  /** 有档位时的展示文本（4K / 1080P / 720P…）；失败时为「未测到」 */
  label?: string;
  /** 失败原因短标签（超时 / 防盗链 / 无资源），供徽章就地展示 */
  reason?: string;
  /** tooltip：说明数据来源，或失败原因与下一步该做什么 */
  title: string;
  /** 只有「没够着」值得重试；源站本来就不给画质信息，重试多少次都一样 */
  retryable: boolean;
}

/**
 * 画质徽章四态。返回 undefined 表示「尚未探测过」——不渲染，
 * 避免把「还没探」画成「未知」，两者对用户的含义完全不同。
 */
export function describeQualityBadge(
  entry: QualityEntry | undefined,
  loading = false
): QualityBadgeView | undefined {
  if (loading) return { kind: 'loading', title: tr('正在探测画质…'), retryable: false };
  if (!entry) return undefined;
  const label = qualityLabel(entry.height);
  if (label) {
    return {
      kind: 'value',
      label,
      title:
        entry.from === 'play'
          ? tr('播放实测的真实分辨率（{h}P）', { h: entry.height })
          : tr('解析播放列表得到的档位（{h}P）', { h: entry.height }),
      retryable: false,
    };
  }
  if (entry.error) {
    const reason = failureReasonLabel(entry.error);
    // 不用「失败/不可用」这类否定结论：探测失败只代表这次没测到，
    // 同一个源换个时刻常常能测到（实测也证明了源是可用的）
    return {
      kind: 'failed',
      label: '未测到',
      reason,
      title: tr('本次没测到画质：{error}。{hint}', {
        error: entry.error,
        hint:
          reason === '超时'
            ? tr('多半是网络抖动或源站响应慢，点击重试')
            : tr('点击可重试，也可以直接播放，播放后会自动记录实测分辨率'),
      }),
      retryable: true,
    };
  }
  return {
    kind: 'unknown',
    title: tr('单码率或直链，播放列表里没有画质信息；播放一次后会记录实测分辨率'),
    retryable: false,
  };
}

export interface QualitySummary {
  /** 最高档位标签；没有任何可用高度时为 undefined */
  best?: string;
  /** 拿到分辨率的条数（探测或实测） */
  known: number;
  /** 探测失败的条数 */
  failed: number;
  /** 参与统计的条目总数（含「未知」） */
  total: number;
}

/**
 * 一组来源的画质汇总：卡片收起时给一个「最高 1080P」的结论，
 * 展开时用 known/total 表达「8 个源里探到 5 个」，比逐个徽章更容易决策。
 * 传入 undefined 的条目（尚未探测）不计入 total，避免进度分母虚高。
 */
export function summarizeQuality(entries: Array<QualityEntry | undefined>): QualitySummary {
  let bestHeight: number | undefined;
  let known = 0;
  let failed = 0;
  let total = 0;
  for (const entry of entries) {
    if (!entry) continue;
    total += 1;
    if (entry.height !== undefined && entry.height > 0) {
      known += 1;
      if (bestHeight === undefined || entry.height > bestHeight) bestHeight = entry.height;
    } else if (entry.error) {
      failed += 1;
    }
  }
  return { best: qualityLabel(bestHeight), known, failed, total };
}

/**
 * 码率 → 推断高度：部分源站的 master playlist 只给 BANDWIDTH 不给 RESOLUTION。
 * 分层取自常见转码参数，仅供档位标识使用（与 m3u8-parse 的推断表保持一致）。
 */
export function inferHeightFromBitrate(bandwidth: number): number {
  const tiers: Array<[number, number]> = [
    [20_000_000, 4320],
    [10_000_000, 2160],
    [5_000_000, 1080],
    [3_000_000, 720],
    [1_500_000, 540],
    [800_000, 480],
    [400_000, 360],
  ];
  for (const [bps, height] of tiers) {
    if (bandwidth >= bps) return height;
  }
  return 240;
}
