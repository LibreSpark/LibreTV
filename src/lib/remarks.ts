import { tr } from '@/lib/i18n-core';

/**
 * 播放备注（CMS 的 vod_remarks）归一化。
 *
 * 这个字段由各采集源自由填写，同一部剧的不同源常常各写各的：
 * 「全34集」「完结」「已完结」「第34集已完结」说的是同一件事，
 * 直接原样显示，会让用户以为这些源的状态不一样。
 *
 * 只归一「集数」与「完结状态」两类信息，其余（HD国语 / 正片 / 年份等）
 * 原样返回——它们不是集数信息，强行改写只会把内容丢掉。
 */

/** 集数：「全34集」「第34集」「更新至12集」「共24集」都能取出数字 */
const EPISODE_COUNT = /(\d+)\s*集/;
/** 完结的明确表述。「剧终」而不单是「终」——否则「终极版」会被误判成已完结 */
const FINISHED_WORD = /完结|大结局|全集|剧终/;
/** 前置全称：「全34集」「共24集」 */
const FINISHED_PREFIX = /(?:全|共)\s*\d+\s*集/;
/** 后置全称：「34集全」 */
const FINISHED_SUFFIX = /\d+\s*集\s*全/;

function isFinished(text: string): boolean {
  return FINISHED_WORD.test(text) || FINISHED_PREFIX.test(text) || FINISHED_SUFFIX.test(text);
}

function episodeCount(text: string): number {
  return Number(EPISODE_COUNT.exec(text)?.[1] ?? 0);
}

/**
 * 展示用本地化：归一化后的文案仍以中文为内部表示（便于幂等与解析），仅在渲染时翻译。
 * 非集数备注（HD国语 / 正片 等）命中词典则翻译，否则原样返回。
 */
export function localizeRemarks(text?: string): string | undefined {
  if (!text) return text;
  const total = /^全(\d+)集$/.exec(text);
  if (total) return tr('全{n}集', { n: total[1] });
  const progress = /^更新至(\d+)集$/.exec(text);
  if (progress) return tr('更新至{n}集', { n: progress[1] });
  const compact = /^(\d+) 集$/.exec(text);
  if (compact) return tr('{n} 集', { n: compact[1] });
  return tr(text);
}

/**
 * 归一备注文案。输出只有三种形态：
 * - `全N集`：已完结且知道总集数
 * - `更新至N集`：连载中且知道当前集数
 * - `已完结`：完结但没有集数信息
 * 以及原样返回的非集数备注（如 `HD国语`、`正片`）。
 *
 * 幂等：已归一化的文案再跑一次结果不变，因此聚合阶段与渲染阶段都调它也不会变样。
 */
export function formatRemarks(raw?: string): string | undefined {
  const text = raw?.trim();
  if (!text) return undefined;

  const finished = isFinished(text);
  const count = episodeCount(text);
  if (count > 0) return finished ? `全${count}集` : `更新至${count}集`;
  // 没有集数时，只有「完结」类表述能归一，别的保持原样
  if (finished) return '已完结';
  return text;
}

/**
 * 选源列表里的紧凑备注。
 *
 * 「更新至1277集」在「源名 / 画质 / 集数」这一行里，前缀没有任何信息量，
 * 却吃掉三分之一宽度并挤掉画质的存在感——压成「1277 集」即可。
 * 非集数备注（HD国语 / 正片）剥掉无意义前缀后原样保留；
 * 单集影片不显示集数（没有「更新到第几集」这回事）。
 */
export function compactRemarks(raw?: string): string | undefined {
  const text = formatRemarks(raw);
  if (!text) return undefined;
  const episode = /^(?:全|更新至)(\d+)集$/.exec(text);
  if (episode) {
    const count = parseInt(episode[1], 10);
    return count > 1 ? `${count} 集` : undefined;
  }
  const prefixed = /^(?:全|更(?:新至|新|至))\s*(.+)$/.exec(text);
  if (prefixed) return prefixed[1].trim() || undefined;
  return text;
}

/**
 * 推断整组（同一部剧的所有来源）的统一备注。
 *
 * 单看一个源补不出集数：标「已完结」的源就是没写总集数。但同一部剧的总集数是客观的，
 * 组内只要有源写了「全34集」，就能确定这部剧是 34 集，把成果推到同组其他源上。
 * 这正是「有的是已完结、有的是全34集」的解法。
 *
 * 优先级：总集数 > 完结 > 进度。
 * 反过来（完结 > 总集数）会丢掉集数；而拿「更新至N集」当总集数是错的——
 * 那是进度，12 集的进度不代表这部只有 12 集。
 *
 * 注意这是**推断**：若某源实际只更到 20 集而组内已有源完结，它也会显示总集数。
 * 该源自己的原始标注保留在按钮 tooltip 里，信息不丢。
 */
export function inferGroupRemarks(raws: Array<string | undefined>): string | undefined {
  let total = 0;
  let progress = 0;
  let finished = false;
  let fallback: string | undefined;

  for (const raw of raws) {
    const text = formatRemarks(raw);
    if (!text) continue;
    fallback ??= text;

    const totalMatch = /^全(\d+)集$/.exec(text);
    if (totalMatch) {
      total = Math.max(total, Number(totalMatch[1]));
      continue;
    }
    const progressMatch = /^更新至(\d+)集$/.exec(text);
    if (progressMatch) {
      progress = Math.max(progress, Number(progressMatch[1]));
      continue;
    }
    if (text === '已完结') finished = true;
  }

  if (total > 0) return `全${total}集`;
  if (finished) return '已完结';
  if (progress > 0) return `更新至${progress}集`;
  return fallback;
}
