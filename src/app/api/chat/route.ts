import { NextRequest, NextResponse } from 'next/server';
import { searchMovies } from '@/lib/search';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MODEL_URL =
  'https://open.bigmodel.cn/api/paas/v4/chat/completions';

const MAX_BODY_BYTES = 100 * 1024;
const MAX_MESSAGES = 30;
const MAX_MESSAGE_LENGTH = 5000;
const MODEL_TIMEOUT_MS = 15000;

const SYSTEM_PROMPT = `
你是 LibreTV 的智能影视助手 Friday。

规则：
1. 用户要求搜索电影、电视剧、动漫或综艺时，必须调用 search_movie。
2. 不允许编造搜索结果、影片信息、播放地址或资源状态。
3. 用户要求控制播放器时，调用 control_player。
4. 用户要求页面导航、站内搜索或切换主题时，调用 page_control。
5. 播放器和页面工具由用户浏览器执行。
6. 收到工具执行结果后，必须根据真实结果回答。
7. 如果工具执行失败，明确告诉用户失败原因，不得谎称成功。
8. 不相关的普通聊天直接回答，不要调用工具。
9. 搜索结果以工具返回的数据为准。
10. 不要向用户暴露内部工具调用协议。
`;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_movie',
      description: '搜索电影、电视剧、动漫或综艺',
      parameters: {
        type: 'object',
        properties: {
          keyword: {
            type: 'string',
            minLength: 1,
            maxLength: 50,
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
      description: '控制当前视频播放器',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'play',
              'pause',
              'seek_to',
              'set_rate',
            ],
          },
          time: {
            type: 'number',
            minimum: 0,
          },
          rate: {
            type: 'number',
            enum: [
              0.5,
              0.75,
              1,
              1.25,
              1.5,
              1.75,
              2,
              3,
              4,
            ],
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
      description: '控制 LibreTV 页面',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'navigate',
              'site_search',
              'toggle_theme',
            ],
          },
          path: {
            type: 'string',
            maxLength: 200,
          },
          keyword: {
            type: 'string',
            maxLength: 50,
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
  },
];

type ChatMessage = {
  role: 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
};

type ToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

const ALLOWED_TOOLS = new Set([
  'search_movie',
  'control_player',
  'page_control',
]);

const ALLOWED_RATES = new Set([
  0.5,
  0.75,
  1,
  1.25,
  1.5,
  1.75,
  2,
  3,
  4,
]);

function jsonError(
  message: string,
  status: number
) {
  return NextResponse.json(
    { error: message },
    { status }
  );
}

async function readRequestBody(
  req: NextRequest
): Promise<string> {
  const reader = req.body?.getReader();

  if (!reader) {
    throw new Error('请求体为空');
  }

  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      total += value.byteLength;

      if (total > MAX_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {}

        throw new Error('请求体过大');
      }

      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }

  const merged = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(merged);
}

function validateToolArguments(
  name: string,
  args: unknown
): string | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return '工具参数必须是对象';
  }

  const value = args as Record<string, unknown>;

  if (name === 'search_movie') {
    if (
      typeof value.keyword !== 'string' ||
      !value.keyword.trim() ||
      value.keyword.length > 50
    ) {
      return '搜索关键词无效';
    }

    return null;
  }

  if (name === 'control_player') {
    const action = value.action;

    if (
      ![
        'play',
        'pause',
        'seek_to',
        'set_rate',
      ].includes(String(action))
    ) {
      return '不支持的播放器操作';
    }

    if (action === 'seek_to') {
      if (
        typeof value.time !== 'number' ||
        !Number.isFinite(value.time) ||
        value.time < 0
      ) {
        return '跳转时间无效';
      }
    }

    if (action === 'set_rate') {
      if (
        typeof value.rate !== 'number' ||
        !Number.isFinite(value.rate) ||
        !ALLOWED_RATES.has(value.rate)
      ) {
        return '播放倍速无效';
      }
    }

    return null;
  }

  if (name === 'page_control') {
    const action = value.action;

    if (
      ![
        'navigate',
        'site_search',
        'toggle_theme',
      ].includes(String(action))
    ) {
      return '不支持的页面操作';
    }

    if (action === 'navigate') {
      if (
        typeof value.path !== 'string' ||
        value.path.length > 200
      ) {
        return '页面路径无效';
      }
    }

    if (action === 'site_search') {
      if (
        typeof value.keyword !== 'string' ||
        !value.keyword.trim() ||
        value.keyword.length > 50
      ) {
        return '站内搜索关键词无效';
      }
    }

    return null;
  }

  return '未知工具';
}

function validateHistory(
  messages: unknown
): ChatMessage[] {
  if (
    !Array.isArray(messages) ||
    messages.length > MAX_MESSAGES
  ) {
    throw new Error('对话历史数量无效');
  }

  const result: ChatMessage[] = [];
  let outstanding = new Set<string>();

  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') {
      throw new Error('对话消息格式错误');
    }

    const message = raw as Record<string, unknown>;

    if (message.role === 'user') {
      if (outstanding.size > 0) {
        throw new Error('工具调用结果不完整');
      }

      if (
        typeof message.content !== 'string' ||
        message.content.length > MAX_MESSAGE_LENGTH
      ) {
        throw new Error('用户消息内容无效');
      }

      result.push({
        role: 'user',
        content: message.content,
      });

      continue;
    }

    if (message.role === 'assistant') {
      if (outstanding.size > 0) {
        throw new Error('工具调用结果不完整');
      }

      const content =
        message.content === null ||
        message.content === undefined
          ? null
          : typeof message.content === 'string'
            ? message.content
            : undefined;

      if (
        content === undefined ||
        (content && content.length > MAX_MESSAGE_LENGTH)
      ) {
        throw new Error('助手消息内容无效');
      }

      const rawCalls = message.tool_calls;

      if (rawCalls !== undefined) {
        if (
          !Array.isArray(rawCalls) ||
          rawCalls.length < 1 ||
          rawCalls.length > 5
        ) {
          throw new Error('工具调用数量无效');
        }

        const calls: ToolCall[] = [];

        for (const rawCall of rawCalls) {
          if (!rawCall || typeof rawCall !== 'object') {
            throw new Error('工具调用结构错误');
          }

          const call = rawCall as Record<string, unknown>;
          const fn = call.function as Record<string, unknown> | undefined;

          if (
            typeof call.id !== 'string' ||
            !/^[a-zA-Z0-9_-]{1,100}$/.test(call.id) ||
            !fn ||
            typeof fn.name !== 'string' ||
            typeof fn.arguments !== 'string' ||
            fn.arguments.length > 4000
          ) {
            throw new Error('工具调用字段无效');
          }

          if (outstanding.has(call.id)) {
            throw new Error('工具调用 ID 重复');
          }

          outstanding.add(call.id);

          calls.push({
            id: call.id,
            type: 'function',
            function: {
              name: fn.name,
              arguments: fn.arguments,
            },
          });
        }

        result.push({
          role: 'assistant',
          content,
          tool_calls: calls,
        });
      } else {
        result.push({
          role: 'assistant',
          content,
        });
      }

      continue;
    }

    if (message.role === 'tool') {
      if (
        typeof message.tool_call_id !== 'string' ||
        !outstanding.has(message.tool_call_id) ||
        typeof message.content !== 'string' ||
        message.content.length > MAX_MESSAGE_LENGTH
      ) {
        throw new Error('工具结果与调用记录不匹配');
      }

      outstanding.delete(message.tool_call_id);

      result.push({
        role: 'tool',
        tool_call_id: message.tool_call_id,
        content: message.content,
      });

      continue;
    }

    throw new Error('不允许的消息角色');
  }

  if (outstanding.size > 0) {
    throw new Error('存在未完成的工具调用');
  }

  return result;
}

async function requestModel(
  apiKey: string,
  model: string,
  messages: ChatMessage[]
) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, MODEL_TIMEOUT_MS);

  try {
    const response = await fetch(MODEL_URL, {
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
        parallel_tool_calls: true,
        temperature: 0.3,
        max_tokens: 1200,
        stream: false,
      }),
      signal: controller.signal,
      cache: 'no-store',
    });

    if (!response.ok) {
      throw new Error(
        `模型请求失败，HTTP ${response.status}`
      );
    }

    const data = await response.json();

    const choice = data?.choices?.[0]?.message;

    if (!choice || typeof choice !== 'object') {
      throw new Error('模型响应结构异常');
    }

    return choice;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('模型请求超时');
    }

    throw error instanceof Error
      ? error
      : new Error('模型请求失败');
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(req: NextRequest) {
  const requestId = crypto.randomUUID();

  try {
    const raw = await readRequestBody(req);

    let body: Record<string, unknown>;

    try {
      body = JSON.parse(raw);
    } catch {
      return jsonError('请求 JSON 格式错误', 400);
    }

    const safeMessages = validateHistory(body.messages);

    const apiKey = process.env.ZHIPU_API_KEY;

    if (!apiKey) {
      return jsonError('服务器未配置模型 API Key', 500);
    }

    const model =
      process.env.LLM_MODEL || 'glm-4-flash';

    const choice = await requestModel(
      apiKey,
      model,
      safeMessages
    );

    const rawCalls = choice.tool_calls;

    if (
      rawCalls !== undefined &&
      !Array.isArray(rawCalls)
    ) {
      return jsonError('模型工具调用格式异常', 502);
    }

    if (Array.isArray(rawCalls) && rawCalls.length > 0) {
      if (rawCalls.length > 5) {
        return jsonError('模型工具调用数量超过限制', 502);
      }

      const assistantMessage = {
        role: 'assistant' as const,
        content:
          typeof choice.content === 'string'
            ? choice.content
            : null,
        tool_calls: [] as ToolCall[],
      };

      const toolMessages: Array<{
        role: 'tool';
        tool_call_id: string;
        content: string;
      }> = [];

      const uiToolCalls: ToolCall[] = [];

      type MovieSearchResult = Awaited<
        ReturnType<typeof searchMovies>
      >[number];

      const movieMap = new Map<string, MovieSearchResult>();

      for (const rawCall of rawCalls) {
        if (!rawCall || typeof rawCall !== 'object') {
          throw new Error('模型返回了无效工具调用');
        }

        const tc = rawCall as Record<string, unknown>;
        const fn = tc.function as
          | Record<string, unknown>
          | undefined;

        if (
          typeof tc.id !== 'string' ||
          !/^[a-zA-Z0-9_-]{1,100}$/.test(tc.id) ||
          !fn ||
          typeof fn.name !== 'string' ||
          typeof fn.arguments !== 'string'
        ) {
          throw new Error('模型工具调用字段缺失');
        }

        const call: ToolCall = {
          id: tc.id,
          type: 'function',
          function: {
            name: fn.name,
            arguments: fn.arguments,
          },
        };

        assistantMessage.tool_calls.push(call);

        let args: unknown;

        try {
          args = JSON.parse(fn.arguments);
        } catch {
          toolMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({
              ok: false,
              error: '工具参数 JSON 格式错误',
            }),
          });

          continue;
        }

        if (!ALLOWED_TOOLS.has(fn.name)) {
          toolMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({
              ok: false,
              error: '工具不在允许列表中',
            }),
          });

          continue;
        }

        const validationError =
          validateToolArguments(fn.name, args);

        if (validationError) {
          toolMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({
              ok: false,
              error: validationError,
            }),
          });

          continue;
        }

        if (fn.name === 'search_movie') {
          try {
            const keyword = (
              args as { keyword: string }
            ).keyword;

            const items = await searchMovies(keyword);

            // 每次工具调用的 tool result 只返回本次搜索结果。
            // movieData 则累计所有搜索结果，避免后一次搜索覆盖前一次。
            for (const item of items) {
              const key = `${item.sourceKey}:${item.vodId}`;

              if (!movieMap.has(key)) {
                movieMap.set(key, item);
              }
            }

            toolMessages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: JSON.stringify({
                ok: true,
                count: items.length,
                items,
              }),
            });
          } catch (error) {
            toolMessages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: JSON.stringify({
                ok: false,
                error:
                  error instanceof Error
                    ? error.message
                    : '搜索失败',
                items: [],
              }),
            });
          }

          continue;
        }

        uiToolCalls.push(call);
      }

      const movieData = Array.from(movieMap.values());

      // 统一返回完整工具批次。
      // 前端必须为每个 uiToolCall 补充真实执行结果。
      return NextResponse.json({
        type: 'tool_calls',
        assistantMessage,
        toolMessages,
        uiToolCalls,
        movieData,
      });
    }

    const text =
      typeof choice.content === 'string'
        ? choice.content
        : '';

    return NextResponse.json({
      type: 'final',
      text,
      movieData: [],
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : '服务器内部错误';

    console.error(
      `[LibreTV Chat ${requestId}]`,
      message
    );

    const status =
      message === '请求体过大'
        ? 413
        : message.includes('对话') ||
            message.includes('工具调用') ||
            message.includes('消息') ||
            message.includes('工具结果') ||
            message.includes('不允许')
          ? 400
          : 500;

    return jsonError(message, status);
  }
}
