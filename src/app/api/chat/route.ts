import { NextRequest, NextResponse } from 'next/server';
import { searchSources, mergeSearchResults } from '@/lib/search';
import type { SearchResultItem, SourceConfig, SourceSearchOutcome } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MODEL_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

const MAX_BODY_BYTES = 256 * 1024;
const MAX_MESSAGES = 50;
const MAX_MESSAGE_LENGTH = 5000;
const MAX_TOOL_CALLS = 8;
const MAX_TOOL_ARGUMENTS = 4000;
const MAX_SOURCES = 30;
const MAX_KEYWORD_LENGTH = 50;
const MAX_RETURN_RESULTS = 100;
const MODEL_TIMEOUT_MS = 15000;

type ToolName = 'search_movie' | 'control_player' | 'page_control';

type ToolCall = {
  id: string;
  type: 'function';
  function: {
    name: ToolName;
    arguments: string;
  };
};

type ChatMessage = {
  role: 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
};

const SYSTEM_PROMPT = `
你是 LibreTV 的影视助手 Friday。

规则：
1. 用户明确要求搜索、查找、观看某部电影、电视剧、动漫或综艺时，调用 search_movie。
2. 用户只是普通聊天时，不调用工具。
3. 不得编造搜索结果、播放状态或页面操作结果。
4. 播放器控制使用 control_player。
5. 页面导航、站内搜索和主题切换使用 page_control。
6. 如果搜索没有结果，如实说明；如果资源源请求失败，不要谎称影片不存在。
7. 工具参数必须符合工具定义。
`.trim();

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_movie',
      description: '搜索电影、电视剧、动漫或综艺资源。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', minLength: 1, maxLength: MAX_KEYWORD_LENGTH },
        },
        required: ['keyword'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'control_player',
      description: '控制当前视频播放器。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['play', 'pause', 'seek_to', 'set_rate'],
          },
          time: { type: 'number', minimum: 0 },
          rate: { type: 'number', enum: [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'page_control',
      description: '控制 LibreTV 页面。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['navigate', 'site_search', 'toggle_theme'],
          },
          path: { type: 'string', maxLength: 500 },
          keyword: { type: 'string', maxLength: 100 },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
  },
];

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function safeText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function isToolName(value: unknown): value is ToolName {
  return value === 'search_movie' ||
    value === 'control_player' ||
    value === 'page_control';
}

function validateToolCall(value: unknown): value is ToolCall {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string' || value.id.length < 1 || value.id.length > 128) return false;
  if (value.type !== 'function' || !isRecord(value.function)) return false;

  const fn = value.function;
  if (!isToolName(fn.name)) return false;
  if (typeof fn.arguments !== 'string' || fn.arguments.length > MAX_TOOL_ARGUMENTS) return false;

  try {
    const args: unknown = JSON.parse(fn.arguments);
    return isRecord(args);
  } catch {
    return false;
  }
}

function validateHistory(value: unknown): value is ChatMessage[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MESSAGES) {
    return false;
  }

  const outstanding = new Set<string>();

  for (const rawMessage of value) {
    if (!isRecord(rawMessage)) return false;

    const role = rawMessage.role;

    if (role === 'user') {
      if (typeof rawMessage.content !== 'string') return false;
      if (rawMessage.content.length > MAX_MESSAGE_LENGTH) return false;
      if (outstanding.size > 0) return false;
      continue;
    }

    if (role === 'assistant') {
      if (
        rawMessage.content !== undefined &&
        rawMessage.content !== null &&
        typeof rawMessage.content !== 'string'
      ) return false;

      if (rawMessage.tool_calls !== undefined) {
        if (!Array.isArray(rawMessage.tool_calls)) return false;
        if (rawMessage.tool_calls.length === 0 || rawMessage.tool_calls.length > MAX_TOOL_CALLS) {
          return false;
        }
        if (outstanding.size > 0) return false;

        for (const call of rawMessage.tool_calls) {
          if (!validateToolCall(call) || outstanding.has(call.id)) return false;
          outstanding.add(call.id);
        }
      }
      continue;
    }

    if (role === 'tool') {
      if (typeof rawMessage.tool_call_id !== 'string') return false;
      if (typeof rawMessage.content !== 'string') return false;
      if (!outstanding.has(rawMessage.tool_call_id)) return false;

      outstanding.delete(rawMessage.tool_call_id);
      continue;
    }

    return false;
  }

  return outstanding.size === 0;
}

function validateSource(value: unknown): value is SourceConfig {
  if (!isRecord(value)) return false;

  if (
    typeof value.key !== 'string' ||
    value.key.length < 1 ||
    value.key.length > 100 ||
    typeof value.name !== 'string' ||
    value.name.length < 1 ||
    value.name.length > 100 ||
    typeof value.url !== 'string' ||
    value.url.length > 2048
  ) return false;

  if (value.isAdult !== undefined && typeof value.isAdult !== 'boolean') {
    return false;
  }

  try {
    const url = new URL(value.url);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

async function readRequestBody(req: NextRequest): Promise<string> {
  if (!req.body) throw new Error('请求内容为空');

  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let result = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      received += value.byteLength;
      if (received > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error('请求内容过大');
      }

      result += decoder.decode(value, { stream: true });
    }

    return result + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function extractMovieSearchKeyword(messages: ChatMessage[]): string | null {
  const lastUserMessage = [...messages].reverse().find(message => message.role === 'user');

  if (typeof lastUserMessage?.content !== 'string') return null;

  let text = lastUserMessage.content.trim();
  if (!text) return null;

  const playerPattern =
    /^(?:请)?(?:帮我)?(?:暂停|继续播放|恢复播放|快进|快退|后退|静音|取消静音|调高音量|调低音量|增大音量|减小音量|全屏|退出全屏|切换倍速|设置倍速|跳转到|跳到|播放进度)/i;

  if (playerPattern.test(text)) return null;

  text = text.replace(
    /^(?:请)?(?:帮我)?调用\s*search_movie\s*(?:工具)?\s*/i,
    '',
  );

  const patterns = [
    /^(?:请)?(?:帮我)?(?:搜索|搜一下|搜搜|查找|查一下|找一下|找找|找|播放|看看)\s*[:：]?\s*(.+)$/i,
    /^(?:我想看|我想要看|我要看|我想播放|我想找|我想搜索|我想搜|帮我找|帮我搜|帮我搜索|请帮我找|请帮我搜索)\s*[:：]?\s*(.+)$/i,
  ];

  let keyword = '';

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      keyword = match[1].trim();
      break;
    }
  }

  if (!keyword) return null;

  keyword = keyword
    .replace(/^(?:一部|一个|一下)\s*/, '')
    .replace(/[，。！？,.!?；;]+$/g, '')
    .replace(/^(?:叫做|名字叫|名称是)\s*/, '')
    .replace(/[《》「」『』]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_KEYWORD_LENGTH);

  return keyword.length > 0 ? keyword : null;
}

function parseToolArguments(call: ToolCall): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(call.function.arguments || '{}');
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function validateModelMessage(value: unknown): value is {
  content?: string | null;
  tool_calls?: unknown[];
} {
  if (!isRecord(value)) return false;

  if (
    value.content !== undefined &&
    value.content !== null &&
    typeof value.content !== 'string'
  ) return false;

  if (value.tool_calls !== undefined && !Array.isArray(value.tool_calls)) {
    return false;
  }

  return true;
}

async function requestModel(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  signal?: AbortSignal,
) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();

  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', onAbort, { once: true });

  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);

  try {
    const res = await fetch(MODEL_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          ...messages,
        ],
        tools: TOOLS,
        tool_choice: 'auto',
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`模型服务请求失败：HTTP ${res.status}${detail ? `，${detail.slice(0, 200)}` : ''}`);
    }

    const data: unknown = await res.json();

    if (!isRecord(data) || !Array.isArray(data.choices) || !isRecord(data.choices[0])) {
      throw new Error('模型服务返回格式无效');
    }

    const message = data.choices[0].message;
    if (!validateModelMessage(message)) {
      throw new Error('模型消息格式无效');
    }

    return message;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function buildSearchResponse(
  keyword: string,
  outcomes: SourceSearchOutcome[],
) {
  const movieData = mergeSearchResults(outcomes).slice(0, MAX_RETURN_RESULTS);
  const successCount = outcomes.filter(item => item.ok).length;
  const failureCount = outcomes.filter(item => !item.ok).length;

  let text: string;

  if (outcomes.length === 0) {
    text = '你还没有选择可用的影视资源源，请先在设置中选择资源源。';
  } else if (successCount === 0) {
    text = `搜索“${keyword}”时，所选资源源全部请求失败，请检查资源源地址或稍后重试。`;
  } else if (movieData.length === 0) {
    text = `已成功查询 ${successCount} 个资源源，但没有找到“${keyword}”的匹配结果。`;
  } else {
    text = `已为你找到 ${movieData.length} 条“${keyword}”相关资源。`;
    if (failureCount > 0) {
      text += `另外有 ${failureCount} 个资源源请求失败。`;
    }
  }

  return {
    type: 'final' as const,
    text,
    movieData,
    searchInfo: {
      totalSources: outcomes.length,
      successCount,
      failureCount,
    },
  };
}

export async function POST(req: NextRequest) {
  try {
    const rawBody = await readRequestBody(req);

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return jsonError('JSON 格式错误', 400);
    }

    if (!isRecord(body) || !validateHistory(body.messages)) {
      return jsonError('历史消息格式无效', 400);
    }

    const messages = body.messages;
    const sources = Array.isArray(body.sources)
      ? body.sources.filter(validateSource).slice(0, MAX_SOURCES)
      : [];

    const filterAdult = body.filterAdult === true;
    const eligibleSources = sources.filter(source => !(filterAdult && source.isAdult));

    if (req.signal.aborted) return jsonError('请求已取消', 408);

    // 明确的找片意图直接走资源搜索，不依赖模型是否主动调用工具。
    const forcedKeyword = extractMovieSearchKeyword(messages);

    if (forcedKeyword) {
      if (eligibleSources.length === 0) {
        return NextResponse.json({
          type: 'final',
          text: sources.length === 0
            ? '你还没有选择影视资源源，请先在设置中选择资源源。'
            : '当前黄色过滤已开启，所选资源源均被过滤。请调整资源源或过滤设置后重试。',
          movieData: [],
          searchInfo: {
            totalSources: 0,
            successCount: 0,
            failureCount: 0,
          },
        });
      }

      const outcomes = await searchSources(
        forcedKeyword,
        eligibleSources,
        { filterAdult, signal: req.signal },
      );

      return NextResponse.json(buildSearchResponse(forcedKeyword, outcomes));
    }

    const apiKey = process.env.ZHIPU_API_KEY;
    if (!apiKey) return jsonError('服务器未配置模型 API Key', 500);

    const model = safeText(process.env.LLM_MODEL, 100) || 'glm-4-flash';
    const choice = await requestModel(apiKey, model, messages, req.signal);

    const rawCalls = Array.isArray(choice.tool_calls) ? choice.tool_calls : [];

    if (rawCalls.length === 0) {
      return NextResponse.json({
        type: 'final',
        text: typeof choice.content === 'string' ? choice.content : '',
        movieData: [],
      });
    }

    if (rawCalls.length > MAX_TOOL_CALLS) {
      return jsonError('模型返回的工具调用数量超过限制，请重试。', 502);
    }

    const calls: ToolCall[] = [];

    for (const rawCall of rawCalls) {
      if (!validateToolCall(rawCall)) {
        return jsonError('模型返回了无效的工具调用参数。', 502);
      }
      calls.push(rawCall);
    }

    const ids = new Set<string>();
    for (const call of calls) {
      if (ids.has(call.id)) return jsonError('模型返回了重复的工具调用 ID。', 502);
      ids.add(call.id);
    }

    const uiToolCalls: ToolCall[] = [];
    const movieData: SearchResultItem[] = [];
    const searchSummaries: string[] = [];

    for (const call of calls) {
      if (req.signal.aborted) return jsonError('请求已取消', 408);

      if (call.function.name === 'search_movie') {
        const args = parseToolArguments(call);
        const keyword = args ? safeText(args.keyword, MAX_KEYWORD_LENGTH) : '';

        if (!keyword) {
          searchSummaries.push('搜索关键词无效，请重新告诉我影片名称。');
          continue;
        }

        if (eligibleSources.length === 0) {
          searchSummaries.push('没有可用的影视资源源，请检查资源源选择或黄色过滤设置。');
          continue;
        }

        const outcomes = await searchSources(
          keyword,
          eligibleSources,
          { filterAdult, signal: req.signal },
        );

        const result = buildSearchResponse(keyword, outcomes);
        movieData.push(...result.movieData);
        searchSummaries.push(result.text);
      } else {
        uiToolCalls.push(call);
      }
    }

    const uniqueMovieData = mergeSearchResults([
      {
        sourceKey: '__combined__',
        ok: true,
        list: movieData,
      },
    ]).slice(0, MAX_RETURN_RESULTS);

    const searchText = searchSummaries.join('\n');

    if (uiToolCalls.length === 0) {
      return NextResponse.json({
        type: 'final',
        text: [searchText, typeof choice.content === 'string' ? choice.content : '']
          .filter(Boolean)
          .join('\n'),
        movieData: uniqueMovieData,
      });
    }

    // 搜索工具已经在服务器执行，不放进前端工具历史。
    // assistantMessage 只包含真正需要由前端执行的 UI 工具调用。
    const assistantMessage: ChatMessage = {
      role: 'assistant',
      content: typeof choice.content === 'string' ? choice.content : null,
      tool_calls: uiToolCalls,
    };

    return NextResponse.json({
      type: 'tool_calls',
      assistantMessage,
      serverToolMessages: [],
      uiToolCalls,
      movieData: uniqueMovieData,
      searchText,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '服务器内部错误';

    if (message === '请求内容过大') return jsonError(message, 413);
    if (message === '请求内容为空') return jsonError(message, 400);
    if (req.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      return jsonError('请求已取消或超时', 408);
    }

    console.error('[Friday API]', message);
    return jsonError(message, 500);
  }
}
