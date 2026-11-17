import { NextResponse } from 'next/server';
import { intelligentCollectorRequest } from '@/lib/resource-collector-client';
import { getVerifiedReviewerSubject } from '@/lib/reviewer-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!await getVerifiedReviewerSubject(request)) {
    return NextResponse.json({ error: '需要有效的管理员登录或 OIDC 身份。' }, { status: 401 });
  }
  const query = new URL(request.url).searchParams;
  const status = query.get('status')?.trim() ?? 'pending_review';
  if (!/^(pending_review|approved|rejected)$/.test(status)) {
    return NextResponse.json({ error: '候选状态无效。' }, { status: 400 });
  }
  const limit = Math.min(Math.max(Number(query.get('limit') ?? 50) || 50, 1), 200);
  return intelligentCollectorRequest(`/v1/candidates?status=${status}&limit=${limit}`, {}, 15_000);
}
