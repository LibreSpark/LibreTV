export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getEnv } from '@/lib/infra/env';

// 定义前端支持的工具，让大模型能够听懂并调用
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_movie',
      description: '搜索电影。当用户想看电影、找资源时调用此工具。',
      parameters: {
        type: 'object',
        properties: { keyword: { type: 'string', description: '搜索关键词' } },
        required: ['keyword'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'control_player',
      description: '控制视频播放器。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'play', 'pause', 'seek_forward', 'seek_backward',
              'volume_up', 'volume_down', 'fullscreen', 'seek_to'
            ],
          },
          time: { type: 'number', description: '跳转时间（秒），仅 seek_to 需要' },
        },
        required: ['action'],
      },
    },
  },
];

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { messages, playerContext } = body;

    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json({ error: 'messages 格式错误' }, { status: 400 });
    }

    const { ZHIPU_API_KEY, LLM_MODEL } = getEnv();

    // 注入系统提示词
    const systemMsg = {
      role: 'system',
      content: `你是一个智能影视助手。如果用户想找电影，请调用 search_movie。如果用户想控制播放器，请调用 control_player。\n当前播放器状态：${playerContext || '无'}`,
    };

    const finalMessages = [systemMsg, ...messages];

    // 请求智谱大模型
    const res = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ZHIPU_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: finalMessages,
        tools: TOOLS,
        stream: true, // 开启流式
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      return NextResponse.json({ error: `大模型接口报错: ${errText}` }, { status: res.status });
    }

    // 🚀 核心：直接把智谱的返回流，原封不动地透传给前端！
    return new Response(res.body, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });

  } catch (err: any) {
    return NextResponse.json({ error: err.message || '服务器内部错误' }, { status: 500 });
  }
}
