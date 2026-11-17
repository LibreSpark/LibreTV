import { NextResponse } from 'next/server';
import { intelligentCollectorRequest } from '@/lib/resource-collector-client';
import { getVerifiedReviewerSubject } from '@/lib/reviewer-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ candidateId: string }> }) {
  const subject = await getVerifiedReviewerSubject(request);
  if (!subject) return NextResponse.json({ error: '需要有效的管理员登录或 OIDC 身份。' }, { status: 401 });
  const { candidateId } = await context.params;
  if (!/^[a-f0-9]{24}$/.test(candidateId)) return NextResponse.json({ error: '候选 ID 无效。' }, { status: 400 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求内容必须是 JSON。' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') return NextResponse.json({ error: '审核请求无效。' }, { status: 400 });
  const input = body as { decision?: unknown; note?: unknown };
  if (input.decision !== 'approved' && input.decision !== 'rejected') {
    return NextResponse.json({ error: '审核决定无效。' }, { status: 400 });
  }
  const note = typeof input.note === 'string' ? input.note.slice(0, 1000) : '';
  return intelligentCollectorRequest(`/v1/candidates/${candidateId}/review`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-LibreTV-Reviewer-Sub': subject,
    },
    body: JSON.stringify({ decision: input.decision, note }),
  }, 15_000);
}
