import { NextResponse } from 'next/server';
import { intelligentCollectorRequest } from '@/lib/resource-collector-client';
import { getVerifiedReviewerSubject } from '@/lib/reviewer-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ batchId: string }> },
) {
  if (!await getVerifiedReviewerSubject(request)) {
    return NextResponse.json(
      { error: '需要有效的管理员登录或 OIDC 身份。' },
      { status: 401 },
    );
  }
  const { batchId } = await context.params;
  if (!/^[a-f0-9]{32}$/.test(batchId)) {
    return NextResponse.json({ error: '批次 ID 无效。' }, { status: 400 });
  }
  return intelligentCollectorRequest(
    `/v1/batches/${batchId}/retry`,
    { method: 'POST' },
    15_000,
  );
}
