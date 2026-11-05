import { HISTORY_LIMITS, type ChatRequest, type ChatHistoryMessage, type CardSummary } from '@/types/chat';

const RID_RE = /^[A-Za-z0-9_:.-]{1,128}$/;

const isNonEmptyStr = (x: unknown, max = 512): x is string =>
  typeof x === 'string' && x.length > 0 && x.length <= max;

const isCard = (x: any): x is CardSummary =>
  !!x && typeof x.id === 'string' && typeof x.title === 'string';

const isHistoryMsg = (x: any): x is ChatHistoryMessage =>
  !!x &&
  (x.role === 'user' || x.role === 'assistant') &&
  typeof x.content === 'string' &&
  (x.cards === undefined || (Array.isArray(x.cards) && x.cards.every(isCard)));

export type ValidateResult = { ok: true; value: ChatRequest } | { ok: false; reason: string };

export function validateChatRequest(body: unknown): ValidateResult {
  if (!body || typeof body !== 'object') return { ok: false, reason: 'body 非对象' };
  const b = body as Record<string, unknown>;

  const requestId = b.requestId;
  const conversationId = b.conversationId;

  if (!isNonEmptyStr(requestId, 128) || !RID_RE.test(requestId))
    return { ok: false, reason: 'requestId 非法' };
  if (!isNonEmptyStr(conversationId, 128) || !RID_RE.test(conversationId))
    return { ok: false, reason: 'conversationId 非法' };
  if (typeof b.message !== 'string')
    return { ok: false, reason: 'message 非法' };

  const rawHistory = b.history;
  const limited: ChatHistoryMessage[] = Array.isArray(rawHistory)
    ? rawHistory
        .filter(isHistoryMsg)
        .slice(-HISTORY_LIMITS.maxMessages)
        .map((m) => ({
          role: m.role,
          content: m.content.slice(0, HISTORY_LIMITS.maxContentChars),
          cards: m.cards?.slice(0, HISTORY_LIMITS.maxCardsPerMessage),
        }))
    : [];

  let total = 0;
  const finalHistory: ChatHistoryMessage[] = [];
  for (let i = limited.length - 1; i >= 0; i--) {
    const c = limited[i].content.length + (limited[i].cards?.length ?? 0) * 32;
    if (total + c > HISTORY_LIMITS.maxTotalChars) break;
    total += c;
    finalHistory.unshift(limited[i]);
  }

  return {
    ok: true,
    value: { requestId, conversationId, message: b.message, history: finalHistory },
  };
}
