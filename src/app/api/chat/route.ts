export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { runChat } from '@/lib/orchestrator';
import { registerInflight, unregisterInflight } from '@/lib/infra/inflight';
import { inspectInput } from '@/lib/infra/guard';
import { validateChatRequest } from '@/lib/chat/validate-request';

export async function POST(req: NextRequest) {
  // 实际业务中请从 token/session 解析真实 userId
  const userId = req.headers.get('Authorization') ? 'user_123' : 'dev-user';
  let requestId: string | undefined;

  try {
    const raw = await req.json().catch(() => null);
    const parsed = validateChatRequest(raw);
    if (!parsed.ok) {
      return NextResponse.json({ code: 'BAD_REQUEST', message: parsed.reason }, { status: 400 });
    }
    
    const body = parsed.value;
    requestId = body.requestId;

    const input = inspectInput(body.message);
    if (!input.ok) {
      return NextResponse.json({ code: 'BAD_REQUEST', message: input.reason }, { status: 400 });
    }

    const ctrl = new AbortController();
    const registered = registerInflight(body.requestId, userId, ctrl);
    if (!registered) {
      return NextResponse.json({ code: 'CONFLICT', message: '请求已存在' }, { status: 409 });
    }

    req.signal.addEventListener('abort', () => ctrl.abort(), { once: true });

    const stream = await runChat(
      body.message,
      body.history,
      body.requestId,
      body.conversationId,
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
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
