import { NextRequest, NextResponse } from 'next/server';
import { searchSources, mergeSearchResults } from '@/lib/search';
import type {
  SearchResultItem,
  SourceConfig,
  SourceSearchOutcome,
} from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MODEL_URL =
  'https://open.bigmodel.cn/api/paas/v4/chat/completions';

const MAX_BODY_BYTES = 256 * 1024;
const MAX_MESSAGES = 50;
const MAX_MESSAGE_LENGTH = 5000;
const MAX_TOOL_CALLS = 8;
const MAX_TOOL_ARGUMENTS = 4000;
const MAX_SOURCES = 30;
const MAX_KEYWORD_LENGTH = 50;
const MAX_RETURN_RESULTS = 100;
const MAX_CONTEXT_RESULTS = 5;
const MODEL_TIMEOUT_MS = 15000;

type ToolName =
  | 'search_movie'
  | 'control_player'
  | 'page_control';

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

你必须认真阅读完整对话历史，尤其是之前搜索结果的片名、资源 ID、资源源名称和编号。

规则：

1. 用户明确要求搜索、查找、观看某部电影、电视剧、动漫或综艺时，必须调用 search_movie。
2. 不要因为用户使用“我想看”“帮我找”“搜索一下”等表达就跳过搜索。
3. 普通聊天不需要调用工具。
4. 搜索结果会以 assistant 历史消息的形式提供。后续用户说“第一个”“第二个”“刚才那部”“播放第一个”时，必须优先结合最近一次搜索结果理解，不得假装不知道上下文。
5. 如果用户询问某个编号对应的影片，必须根据历史搜索结果回答真实片名和资源信息，不得编造。
6. 当前 control_player 只能控制已经打开的视频，不能仅凭 vodId 自动选择并打开搜索卡片。
7. 用户要求播放搜索列表中的某个结果时，如果尚未打开该影片，应明确引导用户点击对应卡片进入详情或播放页面，不得谎称已经自动打开。
8. 播放器控制使用 control_player。
9. 页面导航、站内搜索和主题切换使用 page_control。
10. 不得编造搜索结果、播放状态或页面操作结果。
11. 如果搜索没有结果，如实说明原因，并给出检查网络、更换资源源或重新搜索的建议。
12. 工具参数必须符合工具定义。
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
          keyword: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_KEYWORD_LENGTH,
          },
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
      description: '控制当前已经打开的视频播放器。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['play', 'pause', 'seek_to', 'set_rate'],
          },
          time: {
            type: 'number',
            minimum: 0,
          },
          rate: {
            type: 'number',
            enum: [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2],
          },
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
          path: {
            type: 'string',
            maxLength: 500,
          },
          keyword: {
            type: 'string',
            maxLength: 100,
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
  },
];

function jsonError(message: string, status: number) {
  return NextResponse.json(
    { error: message },
    { status },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value)
  );
}

function safeText(value: unknown, maxLength: number): string {
  return typeof value === 'string'
    ? value.trim().slice(0, maxLength)
    : '';
}

function isToolName(value: unknown): value is ToolName {
  return (
    value === 'search_movie' ||
    value === 'control_player' ||
    value === 'page_control'
  );
}

function validateToolCall(value: unknown): value is ToolCall {
  if (!isRecord(value)) return false;

  if (
    typeof value.id !== 'string' ||
    value.id.length < 1 ||
    value.id.length > 128
  ) {
    return false;
  }

  if (
    value.type !== 'function' ||
    !isRecord(value.function)
  ) {
    return false;
  }

  const fn = value.function;

  if (!isToolName(fn.name)) return false;

  if (
    typeof fn.arguments !== 'string' ||
    fn.arguments.length > MAX_TOOL_ARGUMENTS
  ) {
    return false;
  }

  try {
    const args: unknown = JSON.parse(fn.arguments);
    return isRecord(args);
  } catch {
    return false;
  }
}

function validateHistory(value: unknown): value is ChatMessage[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_MESSAGES
  ) {
    return false;
  }

  const outstanding = new Set<string>();

  for (const rawMessage of value) {
    if (!isRecord(rawMessage)) return false;

    const role = rawMessage.role;

    if (role === 'user') {
      if (typeof rawMessage.content !== 'string') return false;

      if (rawMessage.content.length > MAX_MESSAGE_LENGTH) {
        return false;
      }

      if (outstanding.size > 0) return false;

      continue;
    }

    if (role === 'assistant') {
      if (
        rawMessage.content !== undefined &&
        rawMessage.content !== null &&
        (
          typeof rawMessage.content !== 'string' ||
          rawMessage.content.length > MAX_MESSAGE_LENGTH
        )
      ) {
        return false;
      }

      if (rawMessage.tool_calls !== undefined) {
        if (!Array.isArray(rawMessage.tool_calls)) {
          return false;
        }

        if (
          rawMessage.tool_calls.length === 0 ||
          rawMessage.tool_calls.length > MAX_TOOL_CALLS
        ) {
          return false;
        }

        if (outstanding.size > 0) return false;

        for (const call of rawMessage.tool_calls) {
          if (
            !validateToolCall(call) ||
            outstanding.has(call.id)
          ) {
            return false;
          }

          outstanding.add(call.id);
        }
      }

      continue;
    }

    if (role === 'tool') {
      if (
        typeof rawMessage.tool_call_id !== 'string' ||
        typeof rawMessage.content !== 'string' ||
        rawMessage.content.length > MAX_MESSAGE_LENGTH
      ) {
        return false;
      }

      if (!outstanding.has(rawMessage.tool_call_id)) {
        return false;
      }

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
  ) {
    return false;
  }

  if (
    value.isAdult !== undefined &&
    typeof value.isAdult !== 'boolean'
  ) {
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
  if (!req.body) {
    throw new Error('请求内容为空');
  }

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

/**
 * 识别用户明确的找片意图。
 * 命中后由服务器直接搜索，避免模型漏调 search_movie。
 */
function extractMovieSearchKeyword(
  messages: ChatMessage[],
): string | null {
  const lastUserMessage = [...messages]
    .reverse()
    .find(message => message.role === 'user');

  if (typeof lastUserMessage?.content !== 'string') {
    return null;
  }

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

function parseToolArguments(
  call: ToolCall,
): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(
      call.function.arguments || '{}',
    );

    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function validateModelMessage(
  value: unknown,
): value is {
  content?: string | null;
  tool_calls?: unknown[];
} {
  if (!isRecord(value)) return false;

  if (
    value.content !== undefined &&
    value.content !== null &&
    (
      typeof value.content !== 'string' ||
      value.content.length > MAX_MESSAGE_LENGTH
    )
  ) {
    return false;
  }

  if (
    value.tool_calls !== undefined &&
    !Array.isArray(value.tool_calls)
  ) {
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

  if (signal?.aborted) {
    controller.abort();
  } else {
    signal?.addEventListener('abort', onAbort, {
      once: true,
    });
  }

  const timer = setTimeout(
    () => controller.abort(),
    MODEL_TIMEOUT_MS,
  );

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
          {
            role: 'system',
            content: SYSTEM_PROMPT,
          },
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

      throw new Error(
        `模型服务请求失败：HTTP ${res.status}${
          detail ? `，${detail.slice(0, 200)}` : ''
        }`,
      );
    }

    const data: unknown = await res.json();

    if (
      !isRecord(data) ||
      !Array.isArray(data.choices) ||
      !isRecord(data.choices[0])
    ) {
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

/**
 * 将搜索结果写入 assistant 文本。
 *
 * 前端会把 final.text 存入 apiHistoryRef，
 * 下一轮模型请求就能读取这些具体结果。
 */
function buildSearchResponse(
  keyword: string,
  outcomes: SourceSearchOutcome[],
) {
  const movieData = mergeSearchResults(outcomes)
    .slice(0, MAX_RETURN_RESULTS);

  const successCount = outcomes.filter(
    item => item.ok,
  ).length;

  const failureCount = outcomes.filter(
    item => !item.ok,
  ).length;

  const contextItems = movieData.slice(
    0,
    MAX_CONTEXT_RESULTS,
  );

  let text = '';

  if (outcomes.length === 0) {
    text =
      `没有可用的影视资源源，暂时无法搜索“${keyword}”。\n` +
      '请先进入资源源设置，启用至少一个可用资源源，然后重新搜索。';
  } else if (successCount === 0) {
    text =
      `搜索“${keyword}”失败：当前选择的 ${outcomes.length} 个资源源全部请求失败。\n` +
      '这不代表影片不存在。请检查网络连接、资源源地址，或更换其他资源源后重试。';
  } else if (movieData.length === 0) {
    text =
      `已成功查询 ${successCount} 个资源源，但没有找到“${keyword}”的匹配影片。\n`;

    if (failureCount > 0) {
      text +=
        `另外有 ${failureCount} 个资源源请求失败，因此搜索结果可能不完整。\n`;
    }

    text +=
      '你可以尝试更换资源源、检查影片名称，或稍后重新搜索。';
  } else {
    text =
      `已完成“${keyword}”的搜索，共找到 ${movieData.length} 条资源。\n`;

    if (failureCount > 0) {
      text +=
        `其中 ${successCount} 个资源源查询成功，${failureCount} 个资源源请求失败，结果可能不完整。\n`;
    }

    text +=
      '\n以下是本次搜索结果的上下文记录，后续对话可以直接引用编号：\n';

    contextItems.forEach((item, index) => {
      text +=
        `\n${index + 1}. 影片名称：${safeText(item.name, 150)}` +
        `\n   资源 ID：${safeText(item.vodId, 300)}` +
        `\n   资源源名称：${safeText(item.sourceName, 100)}` +
        `\n   资源源 Key：${safeText(item.sourceKey, 100)}\n`;
    });

    text +=
      '\n你可以继续问我“第一个是什么”“第二个有没有其他版本”等问题。' +
      '如果要打开某条资源，请点击对应影片卡片进入详情或播放页面。';
  }

  return {
    type: 'final' as const,
    text,
    movieData,
    searchInfo: {
      keyword,
      totalSources: outcomes.length,
      successCount,
      failureCount,
      resultCount: movieData.length,
      contextCount: contextItems.length,
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

    if (
      !isRecord(body) ||
      !validateHistory(body.messages)
    ) {
      return jsonError('历史消息格式无效', 400);
    }

    const messages = body.messages;

    const rawSources = Array.isArray(body.sources)
      ? body.sources
      : [];

    const validSources = rawSources
      .filter(validateSource);

    // 去除重复资源源 Key。
    const sourceMap = new Map<string, SourceConfig>();

    for (const source of validSources) {
      if (!sourceMap.has(source.key)) {
        sourceMap.set(source.key, source);
      }
    }

    const sources = Array.from(sourceMap.values())
      .slice(0, MAX_SOURCES);

    const filterAdult = body.filterAdult === true;

    const eligibleSources = sources.filter(
      source => !(filterAdult && source.isAdult),
    );

    if (req.signal.aborted) {
      return jsonError('请求已取消', 408);
    }

    /*
     * 第一优先级：服务端强制搜索。
     *
     * 这一分支不依赖模型是否主动调用 search_movie。
     * 搜索结果会直接写入 final.text，供前端存入历史。
     */
    const forcedKeyword = extractMovieSearchKeyword(messages);

    if (forcedKeyword) {
      if (eligibleSources.length === 0) {
        const text =
          sources.length === 0
            ? `没有启用任何影视资源源，暂时无法搜索“${forcedKeyword}”。\n请先进入资源源设置，启用至少一个可用资源源，再回来搜索。`
            : `当前黄色过滤已开启，已选择的资源源均被过滤，因此无法搜索“${forcedKeyword}”。\n请调整过滤设置或启用其他资源源后重试。`;

        return NextResponse.json({
          type: 'final',
          text,
          movieData: [],
          searchInfo: {
            keyword: forcedKeyword,
            totalSources: 0,
            successCount: 0,
            failureCount: 0,
            resultCount: 0,
            contextCount: 0,
          },
        });
      }

      const outcomes = await searchSources(
        forcedKeyword,
        eligibleSources,
        {
          filterAdult,
          signal: req.signal,
        },
      );

      if (req.signal.aborted) {
        return jsonError('搜索请求已取消', 408);
      }

      const result = buildSearchResponse(
        forcedKeyword,
        outcomes,
      );

      return NextResponse.json(result);
    }

    /*
     * 第二优先级：普通聊天和模型工具调用。
     * 普通聊天需要模型 Key。
     */
    const apiKey = process.env.ZHIPU_API_KEY;

    if (!apiKey) {
      return jsonError(
        '服务器未配置模型 API Key',
        500,
      );
    }

    // 默认使用 glm-4-air；可以通过 LLM_MODEL 环境变量覆盖。
    const model =
      safeText(process.env.LLM_MODEL, 100) ||
      'glm-4-air';

    const choice = await requestModel(
      apiKey,
      model,
      messages,
      req.signal,
    );

    const rawCalls = Array.isArray(choice.tool_calls)
      ? choice.tool_calls
      : [];

    if (rawCalls.length === 0) {
      return NextResponse.json({
        type: 'final',
        text:
          typeof choice.content === 'string'
            ? choice.content
            : '',
        movieData: [],
      });
    }

    if (rawCalls.length > MAX_TOOL_CALLS) {
      return jsonError(
        '模型返回的工具调用数量超过限制，请重试。',
        502,
      );
    }

    const calls: ToolCall[] = [];

    for (const rawCall of rawCalls) {
      if (!validateToolCall(rawCall)) {
        return jsonError(
          '模型返回了无效的工具调用参数。',
          502,
        );
      }

      calls.push(rawCall);
    }

    const ids = new Set<string>();

    for (const call of calls) {
      if (ids.has(call.id)) {
        return jsonError(
          '模型返回了重复的工具调用 ID。',
          502,
        );
      }

      ids.add(call.id);
    }

    const uiToolCalls: ToolCall[] = [];
    const movieData: SearchResultItem[] = [];
    const searchSummaries: string[] = [];

    for (const call of calls) {
      if (req.signal.aborted) {
        return jsonError('请求已取消', 408);
      }

      if (call.function.name === 'search_movie') {
        const args = parseToolArguments(call);

        const keyword = args
          ? safeText(
              args.keyword,
              MAX_KEYWORD_LENGTH,
            )
          : '';

        if (!keyword) {
          searchSummaries.push(
            '搜索关键词无效，请重新告诉我影片名称。',
          );

          continue;
        }

        if (eligibleSources.length === 0) {
          searchSummaries.push(
            '没有可用的影视资源源，请检查资源源选择或黄色过滤设置。',
          );

          continue;
        }

        const outcomes = await searchSources(
          keyword,
          eligibleSources,
          {
            filterAdult,
            signal: req.signal,
          },
        );

        const result = buildSearchResponse(
          keyword,
          outcomes,
        );

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

    const searchText = searchSummaries.join('\n\n');

    if (uiToolCalls.length === 0) {
      return NextResponse.json({
        type: 'final',
        text: [
          searchText,
          typeof choice.content === 'string'
            ? choice.content
            : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
        movieData: uniqueMovieData,
      });
    }

    /*
     * 搜索工具在服务器执行。
     * 前端只接收真正需要执行的 UI 工具。
     */
    const assistantMessage: ChatMessage = {
      role: 'assistant',
      content:
        typeof choice.content === 'string'
          ? choice.content
          : null,
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
    const message =
      error instanceof Error
        ? error.message
        : '服务器内部错误';

    if (message === '请求内容过大') {
      return jsonError(message, 413);
    }

    if (message === '请求内容为空') {
      return jsonError(message, 400);
    }

    if (
      req.signal.aborted ||
      (
        error instanceof Error &&
        error.name === 'AbortError'
      )
    ) {
      return jsonError(
        '请求已取消或超时，请稍后重试。',
        408,
      );
    }

    console.error('[Friday API]', message);

    return jsonError(
      'Friday 服务暂时出现异常，请稍后重试。',
      500,
    );
  }
}
