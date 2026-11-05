export const PROTOCOL_VERSION = 2 as const;
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_COMMENT = 'ping';
export const MAX_STEPS = 4;
export const TOOL_TIMEOUT_MS = 3_000;
export const LLM_TIMEOUT_MS = 20_000;

export type ToolName = 'search_movies';

export interface MovieItem {
  id: string;
  title: string;
  poster: string;
  year?: number;
  rating?: number;
  path: string;
  source?: string;
}

export interface CardSummary { id: string; title: string; }
export interface ChatHistoryMessage { role: 'user' | 'assistant'; content: string; cards?: CardSummary[]; }

export const HISTORY_LIMITS = {
  maxMessages: 8,
  maxContentChars: 2000,
  maxTotalChars: 12000,
  maxCardsPerMessage: 12,
} as const;

export interface ChatRequest {
  requestId: string;
  conversationId: string;
  message: string;
  history: ChatHistoryMessage[];
}

export type ErrorCode =
  | 'LLM_TIMEOUT' | 'LLM_FAILED' | 'TOOL_FAILED' | 'TOOL_EMPTY'
  | 'RATE_LIMIT' | 'UNAUTHORIZED' | 'MAX_STEPS_EXCEEDED' | 'CANCELLED'
  | 'CONTENT_BLOCKED' | 'UNKNOWN';

export type ChatFrameType = 'meta' | 'delta' | 'tool_call' | 'movie_list' | 'ui' | 'error' | 'done';

interface FrameBase { v: typeof PROTOCOL_VERSION; type: ChatFrameType; }
export interface MetaFrame extends FrameBase { type: 'meta'; requestId: string; conversationId: string; model: string; degraded?: boolean; }
export interface DeltaFrame extends FrameBase { type: 'delta'; text: string; }
export interface ToolCallFrame extends FrameBase { type: 'tool_call'; callId: string; tool: ToolName; args: Record<string, unknown>; label?: string; }
export interface MovieListFrame extends FrameBase { type: 'movie_list'; callId: string; items: MovieItem[]; degraded?: boolean; suggestions?: string[]; }
export interface UiFrame extends FrameBase { type: 'ui'; action: 'navigate'; payload: { path?: string; id?: string; mode?: 'spa' | 'external'; }; }
export interface ErrorFrame extends FrameBase { type: 'error'; code: ErrorCode; message: string; retryable: boolean; fatal: boolean; callId?: string; }
export interface DoneFrame extends FrameBase { type: 'done'; requestId: string; steps?: number; }

export type ChatFrame = MetaFrame | DeltaFrame | ToolCallFrame | MovieListFrame | UiFrame | ErrorFrame | DoneFrame;

export const makeMeta = (requestId: string, conversationId: string, model: string, degraded = false): MetaFrame => ({ v: PROTOCOL_VERSION, type: 'meta', requestId, conversationId, model, degraded });
export const makeDelta = (text: string): DeltaFrame => ({ v: PROTOCOL_VERSION, type: 'delta', text });
export const makeToolCall = (callId: string, tool: ToolName, args: any, label?: string): ToolCallFrame => ({ v: PROTOCOL_VERSION, type: 'tool_call', callId, tool, args, label });
export const makeMovieList = (callId: string, items: MovieItem[], opts: { degraded?: boolean; suggestions?: string[] } = {}): MovieListFrame => ({ v: PROTOCOL_VERSION, type: 'movie_list', callId, items, degraded: opts.degraded, suggestions: opts.suggestions });
export const makeError = (code: ErrorCode, message: string, opts: { retryable?: boolean; fatal?: boolean; callId?: string } = {}): ErrorFrame => ({ v: PROTOCOL_VERSION, type: 'error', code, message, retryable: opts.retryable ?? false, fatal: opts.fatal ?? true, callId: opts.callId });
export const makeDone = (requestId: string, steps?: number): DoneFrame => ({ v: PROTOCOL_VERSION, type: 'done', requestId, steps });

export const isSafeInternalPath = (path: unknown): path is string => 
  typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && 
  !path.includes('..') && !path.includes('\\') && /^\/[A-Za-z0-9\-._~/?#&=]*$/.test(path);
