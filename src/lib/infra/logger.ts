export const log = {
  info: (msg: string, meta?: any) => console.log(`[INFO] ${msg}`, meta || ''),
  warn: (msg: string, meta?: any) => console.warn(`[WARN] ${msg}`, meta || ''),
  error: (msg: string, meta?: any) => console.error(`[ERROR] ${msg}`, meta || ''),
};

export const counters = new Map<string, number>();
const MAX_COUNTER_KEYS = 2000;

// 序列化 labels，防止内存泄漏
function keyOf(name: string, labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) return name;
  const sorted = Object.keys(labels).sort().map(k => [k, labels[k]]);
  return `${name}#${JSON.stringify(sorted)}`;
}

export function metricCounter(name: string, labels: Record<string, string> = {}) {
  const k = keyOf(name, labels);
  if (!counters.has(k) && counters.size >= MAX_COUNTER_KEYS) return;
  counters.set(k, (counters.get(k) || 0) + 1);
}
