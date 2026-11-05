export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { runChat } from '@/lib/orchestrator';
import { registerInflight, unregisterInflight } from '@/lib/infra/inflight';
import { inspectInput } from '@/lib/infra/guard';
import { guardRequest } from '@/lib/api-guard';

export async function POST(req: NextRequest) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const userId = 'libretv-authenticated-user';
  let requestId: string | undefined;
  
  try {
    const body = await req.json();
    
    // 兼容 LibreTV 前端传来的格式： { messages: [...] }
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      return NextResponse.json({ error: 'messages 必须为非空数组' }, { status: 400 });
    }

    // 取最后一条作为当前消息，前面的作为历史记录
    const userMessage = body.messages[body.messages.length - 1].content;
    const history = body.messages.slice(0, -1).map((m: any) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content
    }));

    const input = inspectInput(userMessage);
    if (!input.ok) {
      return NextResponse.json({ error: input.reason }, { status: 400 });
    }

    // 自动生成 requestId
    requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const conversationId = 'libretv_session';

    const ctrl = new AbortController();
    registerInflight(requestId, userId, ctrl);
    req.signal.addEventListener('abort', () => ctrl.abort(), { once: true });

    // 调用咱们写好的核心大脑！
    const stream = await runChat(
      userMessage,
      history,
      requestId,
      conversationId,
      userId,
      ctrl.signal
    );

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (err: any) {
    if (requestId) unregisterInflight(requestId);
    return NextResponse.json({ error: err.message || '服务器内部错误' }, { status: 500 });
  }
}
