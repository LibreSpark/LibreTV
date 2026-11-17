import { NextResponse } from 'next/server';
import { intelligentCollectorRequest } from '@/lib/resource-collector-client';
import { getVerifiedReviewerSubject } from '@/lib/reviewer-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ workflowId: string }> },
) {
  if (!await getVerifiedReviewerSubject(request)) {
    return NextResponse.json({ error: '需要已验证的管理员身份。' }, { status: 401 });
  }
  const { workflowId } = await context.params;
  if (!/^[a-f0-9]{32}$/.test(workflowId)) {
    return NextResponse.json({ error: '无效的工作流 ID。' }, { status: 400 });
  }
  const url = new URL(request.url);
  const after = Math.max(0, Number(url.searchParams.get('after') ?? 0) || 0);
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') ?? 100) || 100));
  return intelligentCollectorRequest(
    `/v1/workflows/${workflowId}/snapshots?after=${after}&limit=${limit}`,
    {},
    15_000,
  );
}
