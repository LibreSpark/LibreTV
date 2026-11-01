export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { cancelInflight } from '@/lib/infra/inflight';

const RID_RE = /^[A-Za-z0-9_:.-]{1,128}$/;

export async function POST(req: NextRequest) {
  const userId = req.headers.get('Authorization') ? 'user_123' : 'dev-user';

  try {
    const { requestId } = (await req.json()) as { requestId?: string };
    if (!requestId || typeof requestId !== 'string' || !RID_RE.test(requestId)) {
      return NextResponse.json({ ok: false, message: 'requestId 非法' }, { status: 400 });
    }

    const r = cancelInflight(requestId, userId);
    if (r === 'forbidden') {
      return NextResponse.json({ ok: false, state: r }, { status: 403 });
    }
    return NextResponse.json({ ok: r === 'ok' || r === 'pending', state: r });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
