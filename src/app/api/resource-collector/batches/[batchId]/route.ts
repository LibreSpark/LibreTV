import { NextResponse } from 'next/server';
import { intelligentCollectorRequest } from '@/lib/resource-collector-client';
import { getVerifiedReviewerSubject } from '@/lib/reviewer-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ batchId: string }> }) {
  if (!await getVerifiedReviewerSubject(request)) {
    return NextResponse.json({ error: '需要有效的管理员登录或 OIDC 身份。' }, { status: 401 });
  }
  const { batchId } = await context.params;
  if (!/^[a-f0-9]{32}$/.test(batchId)) return NextResponse.json({ error: '批次 ID 无效。' }, { status: 400 });
  const query = new URL(request.url).searchParams;
  const limit = Math.min(Math.max(Number(query.get('limit') ?? 50) || 50, 1), 100);
  const offset = Math.max(Number(query.get('offset') ?? 0) || 0, 0);
  return intelligentCollectorRequest(`/v1/batches/${batchId}?limit=${limit}&offset=${offset}`, {}, 15_000);
}
