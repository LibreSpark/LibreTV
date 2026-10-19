import { tr } from '@/lib/i18n-core';

export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return tr('刚刚');
  if (diff < 3_600_000) return tr('{n}分钟前', { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return tr('{n}小时前', { n: Math.floor(diff / 3_600_000) });
  if (diff < 604_800_000) return tr('{n}天前', { n: Math.floor(diff / 86_400_000) });
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 停用时长的可读文案：不足 1 小时按分钟，超过按小时（按剩余时间展示时向上取整） */
export function formatDisableTtl(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return minutes >= 60 ? tr('{n} 小时', { n: Math.round(minutes / 60) }) : tr('{n} 分钟', { n: minutes });
}

/**
 * 封面图加载地址：direct 直连 / proxy 内置代理 / custom 自定义模板（{url} 占位符或直接拼接）。
 * 默认 proxy（内置代理），规避豆瓣防盗链与部分采集站图床直连失败。
 * 代理走查询串形式（/api/proxy?url=…）：路径里的 %2F 会被 EdgeOne 等网关
 * 在路由匹配前解码成 /，查询串不受影响，全平台行为一致。
 */
export function buildImageUrl(
  url: string | undefined,
  mode: 'direct' | 'proxy' | 'custom',
  customTemplate: string
): string | undefined {
  if (!url) return undefined;
  if (mode === 'proxy') return `/api/proxy?url=${encodeURIComponent(url)}`;
  if (mode === 'custom' && customTemplate) {
    return customTemplate.includes('{url}')
      ? customTemplate.replace('{url}', encodeURIComponent(url))
      : customTemplate + encodeURIComponent(url);
  }
  return url;
}

/**
 * 封面图降级候选链，各模式首选地址失败后由 SmartImage 按序回退（onError 逐级尝试）：
 * - direct 模式：原站直连 → cmliussss 公共镜像（腾讯 / 阿里，仅豆瓣图）→ 内置代理。
 *   doubanio 反爬对外域与空 Referer 分别返回 403 / 418，纯前端无法绕过；
 *   公共镜像实测直连可用，置于自家代理之前以节省服务器流量。
 * - proxy 模式：内置代理 → 公共镜像（仅豆瓣图）→ 原站直连。
 *   代理是全站封面的公共依赖，不能单点——代理故障时自动落到直连/镜像。
 * - custom 模式为单一地址：模板错误应显式暴露，不被静默回退掩盖。
 */
export function buildImageCandidates(
  url: string | undefined,
  mode: 'direct' | 'proxy' | 'custom',
  customTemplate: string
): string[] {
  const built = buildImageUrl(url, mode, customTemplate);
  if (!built || !url) return [];
  const mirrors = url.includes('doubanio.com')
    ? [
        url.replace(/img\d+\.doubanio\.com/g, 'img.doubanio.cmliussss.net'),
        url.replace(/img\d+\.doubanio\.com/g, 'img.doubanio.cmliussss.com'),
      ]
    : [];
  if (mode === 'proxy') {
    return [...new Set([built, ...mirrors, url])];
  }
  if (mode !== 'direct') return [built];
  return [...new Set([built, ...mirrors, `/api/proxy?url=${encodeURIComponent(url)}`])];
}

export function validateSourceUrl(url: string): boolean {
  return /^https?:\/\/.+/.test(url);
}

/** 取 hostname 作为名称兜底；地址非法时原样返回 */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** 为分享链接等场景构造观看页 URL */
export function buildWatchUrl(params: {
  sourceKey: string;
  vodId?: string;
  index?: number;
  title?: string;
  episodeUrl?: string;
  sourceUrl?: string;
  detail?: string;
}): string {
  const sp = new URLSearchParams();
  sp.set('source', params.sourceKey);
  if (params.vodId) sp.set('id', params.vodId);
  if (typeof params.index === 'number') sp.set('index', String(params.index));
  if (params.title) sp.set('title', params.title);
  if (params.episodeUrl) sp.set('url', params.episodeUrl);
  if (params.sourceUrl) sp.set('sourceUrl', params.sourceUrl);
  if (params.detail) sp.set('detail', params.detail);
  return `/watch?${sp.toString()}`;
}
