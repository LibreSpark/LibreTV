import { toolsDefinition, executeTool } from './tools';
import {
  ChatHistoryMessage, ChatFrame, ErrorCode, MAX_STEPS, 
  LLM_TIMEOUT_MS, HEARTBEAT_INTERVAL_MS, HEARTBEAT_COMMENT, HISTORY_LIMITS,
  makeMeta, makeDelta, makeToolCall, makeMovieList, makeError, makeDone
} from '@/types/chat';
import { createStreamScanner, guardMovieItems } from '@/lib/infra/guard';
import { log } from '@/lib/infra/logger';
import { unregisterInflight } from '@/lib/infra/inflight';
import { getEnv } from '@/lib/infra/env';

function safeAbortSignalAny(signals: AbortSignal[]): AbortSignal {
  const ctrl = new AbortController();
  for (const s of signals) if (s.aborted) { ctrl.abort(s.reason); return ctrl.signal; }
  const onAbort = (e: Event) => ctrl.abort((e.target as AbortSignal).reason);
  for (const s of signals) s.addEventListener('abort', onAbort, { once: true });
  return ctrl.signal;
}

class OrchestratorException extends Error {
  code: ErrorCode; fatal: boolean;
  constructor(code: ErrorCode, message: string, fatal = true) { super(message); this.name = 'OrchestratorException'; this.code = code; this.fatal = fatal; }
}

export async function runChat(message: string, history: ChatHistoryMessage[], requestId: string, conversationId: string, userId: string, reqSignal: AbortSignal) {
  if (!requestId || !userId) throw new OrchestratorException('UNKNOWN', '缺少参数', true);
  const { ZHIPU_API_KEY, LLM_MODEL } = getEnv();

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  reqSignal.addEventListener('abort', onAbort, { once: true });

  const stream = new ReadableStream({
    async start(streamController) {
      const encoder = new TextEncoder();
      let isStreamDone = false;
      let hasSentTerminalFrame = false;
      let pingTimer: NodeJS.Timeout | null = null;
      const scanner = createStreamScanner('mask');

      const safeSend = (frame: ChatFrame) => {
        if (isStreamDone) return;
        try { streamController.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`)); } catch (e) {}
      };

      const terminateStream = (errorCode?: ErrorCode, errorMsg?: string, fatal = true) => {
        if (hasSentTerminalFrame) return;
        const tail = scanner.flush();
        if (tail) safeSend(makeDelta(tail));
        if (errorCode) safeSend(makeError(errorCode, errorMsg || '未知错误', { fatal }));
        safeSend(makeDone(requestId));
        hasSentTerminalFrame = true; isStreamDone = true;
        if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
        unregisterInflight(requestId);
        try { streamController.close(); } catch (e) {}
      };

      const sendDelta = (text: string): boolean => {
        const safe = scanner.push(text);
        if (scanner.blockedNow) {
          log.warn('guard.blocked', { requestId, hits: scanner.hitWords });
          terminateStream('CONTENT_BLOCKED', '内容触发安全策略', true);
          return false;
        }
        if (safe) safeSend(makeDelta(safe));
        return true;
      };

      const onAbortInternal = () => { controller.abort(); terminateStream('CANCELLED', '用户主动中断', false); };
      reqSignal.addEventListener('abort', onAbortInternal);

      try {
        safeSend(makeMeta(requestId, conversationId, LLM_MODEL));
        pingTimer = setInterval(() => {
          if (isStreamDone) return;
          try { streamController.enqueue(encoder.encode(`: ${HEARTBEAT_COMMENT}\n\n`)); } catch (e) {}
        }, HEARTBEAT_INTERVAL_MS);

        const trimmedHistory = history.slice(-HISTORY_LIMITS.maxMessages).map(m => ({ ...m, content: m.content.slice(0, HISTORY_LIMITS.maxContentChars) }));
        const currentMessages: any[] = [
          { role: 'system', content: '你是电影助手。提取用户想看的电影关键词，调用 search_movies 工具进行搜索。如果没找到具体电影，可以说几句简短的推荐语。绝对不要废话。' },
          ...trimmedHistory.map(m => ({ role: m.role, content: m.content + (m.cards?.length ? ` [历史卡片: ${m.cards.map(c => c.title).join(',')}]` : '') })),
          { role: 'user', content: message }
        ];

        let steps = 0; let hasToolCallsInLastStep = false;

        for (steps = 0; steps < MAX_STEPS; steps++) {
          if (controller.signal.aborted) break;
          let res: Response;
          try {
            const fetchSignal = safeAbortSignalAny([controller.signal, AbortSignal.timeout(LLM_TIMEOUT_MS)]);
            res = await fetch("https://open.bigmodel.cn/api/paas/v4/chat/completions", {
              method: "POST", headers: { Authorization: `Bearer ${ZHIPU_API_KEY}`, "Content-Type": "application/json" },
              body: JSON.stringify({ model: LLM_MODEL, messages: currentMessages, tools: toolsDefinition, stream: true }),
              signal: fetchSignal
            });
          } catch (e: any) {
            if (controller.signal.aborted) break;
            if (steps === 0) {
              try {
                const { items } = await executeTool('search_movies', { keyword: message }, userId, controller.signal);
                safeSend(makeMovieList(`${requestId}:fallback`, guardMovieItems(items).items, { degraded: true }));
              } catch (err: any) { log.error('[Fallback Error]', { error: err }); }
              return terminateStream();
            }
            throw new OrchestratorException('LLM_TIMEOUT', '大模型请求超时');
          }

          if (!res.ok || !res.body) throw new OrchestratorException('LLM_FAILED', `API异常: ${res.status}`);

          const reader = res.body.getReader(); const decoder = new TextDecoder();
          let buffer = ""; let assistantContent = "";
          const toolCallsMap = new Map<number, { id: string, name: string, args: string }>();
          hasToolCallsInLastStep = false;

          try {
            while (true) {
              if (controller.signal.aborted) break;
              const { done, value } = await reader.read(); if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split(/\r?\n/); buffer = lines.pop() || "";
              for (const line of lines) {
                if (!line.startsWith("data:")) continue;
                const m = /^data:\s?(.*)$/.exec(line);
                if (!m) continue;
                const payload = m[1];
                if (payload.trim() === '[DONE]') continue;
                try {
                  const data = JSON.parse(payload); const delta = data.choices?.[0]?.delta;
                  if (delta?.content) { assistantContent += delta.content; if (!sendDelta(delta.content)) return; }
                  if (delta?.tool_calls) {
                    hasToolCallsInLastStep = true;
                    for (const tc of delta.tool_calls) {
                      const idx = tc.index ?? 0;
                      if (!toolCallsMap.has(idx)) toolCallsMap.set(idx, { id: '', name: '', args: '' });
                      const slot = toolCallsMap.get(idx)!;
                      if (tc.id) slot.id = tc.id;
                      if (tc.function?.name) slot.name = tc.function.name;
                      if (tc.function?.arguments) slot.args += tc.function.arguments;
                    }
                  }
                } catch (e) {}
              }
            }
          } finally { try { await reader.cancel(); } catch (e) {} }
          if (controller.signal.aborted) break;

          if (!hasToolCallsInLastStep) { currentMessages.push({ role: 'assistant', content: assistantContent }); break; }

          const toolCallsArray = Array.from(toolCallsMap.entries()).sort(([a], [b]) => a - b).map(([idx, tc]) => {
            let parsedArgs = {};
            try { parsedArgs = JSON.parse(tc.args || '{}'); } catch (e) {}
            return { id: tc.id || `call_${idx}`, type: 'function', function: { name: tc.name, arguments: tc.args }, _parsedArgs: parsedArgs };
          });

          currentMessages.push({ role: 'assistant', content: assistantContent || null, tool_calls: toolCallsArray.map(({ _parsedArgs, ...rest }) => rest) });
          for (const tc of toolCallsArray) safeSend(makeToolCall(tc.id, tc.function.name as any, tc._parsedArgs, `正在搜索...`));

          const settledResults = await Promise.allSettled(toolCallsArray.map(async (tc) => executeTool(tc.function.name, tc._parsedArgs, userId, controller.signal)));
          const toolMessages: any[] = [];
          for (let i = 0; i < toolCallsArray.length; i++) {
            const tc = toolCallsArray[i]; const result = settledResults[i];
            if (result.status === 'fulfilled' && result.value.items.length > 0) {
              const guarded = guardMovieItems(result.value.items);
              if (guarded.items.length > 0) {
                safeSend(makeMovieList(tc.id, guarded.items, { degraded: result.value.degraded }));
                toolMessages.push({ role: 'tool', tool_call_id: tc.id, content: `找到: ${guarded.items.slice(0, 3).map((v: any) => v.title).join(',')}` });
              } else {
                safeSend(makeMovieList(tc.id, [], { degraded: true }));
                toolMessages.push({ role: 'tool', tool_call_id: tc.id, content: "内容违规" });
              }
            } else {
              safeSend(makeMovieList(tc.id, [], { degraded: true }));
              toolMessages.push({ role: 'tool', tool_call_id: tc.id, content: "未找到结果" });
            }
          }
          currentMessages.push(...toolMessages);
        }

        if (controller.signal.aborted) return;
        if (steps === MAX_STEPS && hasToolCallsInLastStep) return terminateStream('MAX_STEPS_EXCEEDED', '执行超限', true);
        terminateStream();
      } catch (err: any) {
        if (err instanceof OrchestratorException) terminateStream(err.code, err.message, err.fatal);
        else terminateStream('UNKNOWN', err.message || '系统异常', true);
      } finally {
        if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
        reqSignal.removeEventListener('abort', onAbortInternal);
        reqSignal.removeEventListener('abort', onAbort);
        unregisterInflight(requestId);
        try { streamController.close(); } catch (e) {}
      }
    },
    cancel() { controller.abort(); }
  });
  return stream;
}
