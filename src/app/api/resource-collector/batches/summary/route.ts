import { NextResponse } from 'next/server';
import { intelligentCollectorRequest } from '@/lib/resource-collector-client';
import { getVerifiedReviewerSubject } from '@/lib/reviewer-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!await getVerifiedReviewerSubject(request)) {
    return NextResponse.json({ error: '需要有效的管理员登录或 OIDC 身份。' }, { status: 401 });
  }
  return intelligentCollectorRequest('/v1/batches/summary', {}, 15_000);
}
