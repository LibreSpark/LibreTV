import { NextResponse } from 'next/server';
import { intelligentCollectorRequest } from '@/lib/resource-collector-client';
import { getVerifiedReviewerSubject } from '@/lib/reviewer-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!await getVerifiedReviewerSubject(request)) {
    return NextResponse.json(
      { error: '需要有效的管理员登录或 OIDC 身份。' },
      { status: 401 },
    );
  }
  const query = new URL(request.url).searchParams;
  const limit = Math.min(Math.max(Number(query.get('limit') ?? 100) || 100, 1), 200);
  const status = query.get('status');
  if (status && !['tested', 'active', 'disabled'].includes(status)) {
    return NextResponse.json({ error: '规则状态无效。' }, { status: 400 });
  }
  const params = new URLSearchParams({ limit: String(limit) });
  if (status) params.set('status', status);
  return intelligentCollectorRequest(`/v1/rules?${params.toString()}`, {}, 15_000);
}
