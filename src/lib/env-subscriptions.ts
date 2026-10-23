/**
 * 部署者通过 DEFAULT_SUBSCRIPTIONS 环境变量预置的数据源订阅链接。
 * 格式为 JSON 数组，元素为 URL 字符串或 {url, name} 对象：
 *   ["https://.../sources.json", {"url":"https://.../list.json","name":"名称"}]
 * 与 DEFAULT_SOURCES / DEFAULT_LIVE_SOURCES 的容错策略一致：解析失败整体忽略。
 */
export interface EnvSubscription {
  url: string;
  name?: string;
  refreshDays?: number;
}

const BUILTIN_SUBSCRIPTIONS: EnvSubscription[] = [
  {
    url: 'https://raw.githubusercontent.com/rapier15sapper/ew/refs/heads/main/test.json',
    name: '影视接口源列表',
    refreshDays: 10,
  },
  {
    url: 'https://tv.203511.xyz/0821.json',
    name: 'Zoo 导航 · 荐片',
    refreshDays: 10,
  },
  {
    url: 'http://550.3vcn.work/wdjyys.json',
    name: 'Zoo 导航 · 金鹰',
    refreshDays: 10,
  },
  {
    url: 'https://9280.kstore.space/newwex.json',
    name: 'Zoo 导航 · 牛二',
    refreshDays: 10,
  },
];

export function getEnvSubscriptions(): EnvSubscription[] {
  const raw = process.env.DEFAULT_SUBSCRIPTIONS;
  if (raw === undefined) return BUILTIN_SUBSCRIPTIONS;
  if (!raw.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('必须是 JSON 数组');
    const list: EnvSubscription[] = parsed.map((item, i) => {
      const config = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : undefined;
      const url = typeof item === 'string' ? item.trim() : typeof config?.url === 'string' ? config.url.trim() : '';
      if (!url || !/^https?:\/\//.test(url)) {
        throw new Error(`第 ${i + 1} 项不是合法的 http(s) 订阅地址`);
      }
      const name = typeof config?.name === 'string' ? config.name.trim() || undefined : undefined;
      const rawRefreshDays = config?.refreshDays;
      const refreshDays =
        typeof rawRefreshDays === 'number' && Number.isFinite(rawRefreshDays) && rawRefreshDays > 0
          ? Math.max(1, Math.min(Math.floor(rawRefreshDays), 365))
          : undefined;
      return { url: url.replace(/\/+$/, ''), name, refreshDays };
    });
    const seen = new Set<string>();
    return list.filter((subscription) => {
      if (seen.has(subscription.url)) return false;
      seen.add(subscription.url);
      return true;
    });
  } catch (err) {
    console.warn('[LibreTV] DEFAULT_SUBSCRIPTIONS 解析失败，已忽略：', err instanceof Error ? err.message : err);
    return [];
  }
}
