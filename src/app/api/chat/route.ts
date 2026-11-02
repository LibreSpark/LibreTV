import { NextRequest, NextResponse } from 'next/server';
import { getEnv } from '@/lib/infra/env';

const SYSTEM_PROMPT = `你是 Libretv 的智能影视助手。
【最高指令】：
1. 严禁使用你自带的电影知识库。用户提到任何电影、剧集、动漫、找片、推荐，你只能立刻调用 search_movie 工具。
2. 如果用户要求控制播放器（暂停/继续/倍速/进度/切集），立刻调用 control_player 工具。
3. 如果用户要求操作网页（跳转、搜索、切换主题），立刻调用 page_control 工具。
4. 拿到工具返回的真实数据后，只能使用工具返回的片名、年份等真实字段进行回答，绝不捏造。
5. 闲聊时禁止主动提及任何具体电影名字。`;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_movie',
      description: '搜索电影、电视剧资源',
      parameters: {
        type: 'object',
        properties: { keyword: { type: 'string' } },
        required: ['keyword'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'control_player',
      description: '控制网页播放器（播放、暂停、跳转时间、倍速、切集、全屏）',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['play', 'pause', 'seek_to', 'set_rate', 'next_episode', 'prev_episode', 'fullscreen'] },
          time: { type: 'number', description: '跳转时间（秒），仅seek_to需要' },
          rate: { type: 'number', description: '倍速（如1.5），仅set_rate需要' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'page_control',
      description: '控制网页UI（路由跳转、站内搜索、切换暗黑模式）',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['navigate', 'site_search', 'toggle_theme'] },
          path: { type: 'string', description: '跳转路由，如 /category' },
          keyword: { type: 'string', description: '站内搜索关键词' },
        },
        required: ['action'],
      },
    },
  },
];

export async function POST(req: NextRequest) {
  try {
    // 🚀 核心修复 P0-3：前端传过来的是 messages 数组，这里严格对应
    const { messages } = await req.json();
    const { ZHIPU_API_KEY, LLM_MODEL } = getEnv();

    const systemMsg = { role: 'system', content: SYSTEM_PROMPT };

    const res = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ZHIPU_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [systemMsg, ...messages],
        tools: TOOLS,
        stream: true,
      }),
    });

    if (!res.ok) return NextResponse.json({ error: '大模型请求失败' }, { status: res.status });

    // 🚀 原生透传 + 10s 心跳保活（防止 Cloudflare/Safari 断流）
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const timer = setInterval(() => {
          try { controller.enqueue(encoder.encode(': keep-alive\n\n')); } catch (e) {}
        }, 10000);
        try {
          const reader = res.body!.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
        } catch (e) {
          console.error('SSE Stream Error', e);
        } finally {
          clearInterval(timer);
          try { controller.close(); } catch (e) {}
        }
      },
    });

    return new Response(stream, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
