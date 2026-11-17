import { NextResponse } from 'next/server';
import { intelligentCollectorRequest } from '@/lib/resource-collector-client';
import { getVerifiedReviewerSubject } from '@/lib/reviewer-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ ruleId: string; action: string }> },
) {
  const subject = await getVerifiedReviewerSubject(request);
  if (!subject) {
    return NextResponse.json(
      { error: '需要有效的管理员登录或 OIDC 身份。' },
      { status: 401 },
    );
  }
  const { ruleId, action } = await context.params;
  if (!/^[a-f0-9]{32}$/.test(ruleId)) {
    return NextResponse.json({ error: '规则 ID 无效。' }, { status: 400 });
  }
  if (action !== 'activate' && action !== 'disable') {
    return NextResponse.json({ error: '规则操作无效。' }, { status: 400 });
  }
  const rawLength = Number(request.headers.get('content-length') ?? 0);
  if (rawLength > 16_384) {
    return NextResponse.json({ error: '请求体过大。' }, { status: 413 });
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw, 'utf8') > 16_384) {
    return NextResponse.json({ error: '请求体过大。' }, { status: 413 });
  }
  let value: unknown;
  try {
    value = raw ? JSON.parse(raw) : {};
  } catch {
    return NextResponse.json({ error: '请求内容不是有效 JSON。' }, { status: 400 });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return NextResponse.json({ error: '规则审核请求无效。' }, { status: 400 });
  }
  const note = (value as { note?: unknown }).note;
  if (note !== undefined && (typeof note !== 'string' || note.length > 1000)) {
    return NextResponse.json({ error: '审核备注最多 1,000 个字符。' }, { status: 400 });
  }
  return intelligentCollectorRequest(`/v1/rules/${ruleId}/${action}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-LibreTV-Reviewer-Sub': subject,
    },
    body: JSON.stringify({ note: typeof note === 'string' ? note : '' }),
  }, 15_000);
}
