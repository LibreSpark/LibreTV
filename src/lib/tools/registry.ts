import { type MovieItem, TOOL_TIMEOUT_MS } from '@/types/chat';
import { searchMovies } from './providers/movies';
import { log } from '@/lib/infra/logger';

function safeAbortSignalAny(signals: AbortSignal[]): AbortSignal {
  const ctrl = new AbortController();
  for (const s of signals) if (s.aborted) { ctrl.abort(s.reason); return ctrl.signal; }
  const onAbort = (e: Event) => ctrl.abort((e.target as AbortSignal).reason);
  for (const s of signals) s.addEventListener('abort', onAbort, { once: true });
  return ctrl.signal;
}

export const toolsDefinition = [
  { type: "function", function: { name: "search_movies", description: "根据电影名搜索影片。", parameters: { type: "object", properties: { keyword: { type: "string" } }, required: ["keyword"] } } }
];

export async function executeTool(name: string, args: any, userId: string, parentSignal?: AbortSignal): Promise<{ items: MovieItem[], degraded: boolean, errorCode?: string }> {
  if (!userId) return { items: [], degraded: true, errorCode: 'TOOL_FAILED' };
  const timeoutSignal = AbortSignal.timeout(TOOL_TIMEOUT_MS);
  const signal = parentSignal ? safeAbortSignalAny([parentSignal, timeoutSignal]) : timeoutSignal;
  
  try {
    if (name === 'search_movies') return await searchMovies(args, { signal, userId });
    return { items: [], degraded: true, errorCode: 'TOOL_FAILED' };
  } catch (e: any) {
    const isAbort = !!parentSignal?.aborted;
    const isTimeout = timeoutSignal.aborted && !isAbort;
    if (isAbort) log.info(`[Tool Aborted] ${name}`);
    else log.error(`[Tool Error] ${name}`, { error: e.message, isTimeout });
    return { items: [], degraded: true, errorCode: isTimeout ? 'TOOL_TIMEOUT' : 'TOOL_FAILED' };
  }
}
