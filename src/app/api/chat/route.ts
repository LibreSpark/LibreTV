export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getEnv } from '@/lib/infra/env';

export async function POST(req: NextRequest) {
  try {
    const { messages } = await req.json();
    if (!messages || !Array.isArray(messages)) return NextResponse.json({ error: '格式错误' }, { status: 400 });

    const { ZHIPU_API_KEY, LLM_MODEL } = getEnv();

    const TOOLS = [
      {
        type: 'function',
        function: {
          name: 'search_movie',
          description: '搜索电影、电视剧、动漫等影视资源。',
          parameters: {
            type: 'object',
            properties: { keyword: { type: 'string', description: '搜索关键词' } },
            required: ['keyword'],
          },
        },
      },
    ];

    // 🚨 强制 AI 必须去搜真实数据，不许自己瞎编
    const systemMsg = {
      role: 'system',
      content: `你是 Libretv 的影视助手。
【最高强制指令】：
1. 只要用户提了任何电影、电视、动漫、找片、推荐相关的词，你绝对不许直接回答电影名字！绝对不许使用你的内部知识库！
2. 你唯一能做的，就是立刻提取核心关键词，调用 search_movie 工具。
3. 只有用户发纯粹的闲聊（如"你好"），才可以正常文字回复。`,
    };

    const res = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ZHIPU_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [systemMsg, ...messages],
        tools: TOOLS,
        stream: true,
      }),
    });

    if (!res.ok) return NextResponse.json({ error: '大模型报错' }, { status: 500 });

    // 🚨 心跳保活，10秒发一次，彻底干掉 iPad/Safari 的 Load failed
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
          console.error(e);
        } finally {
          clearInterval(timer);
          try { controller.close(); } catch (e) {}
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
