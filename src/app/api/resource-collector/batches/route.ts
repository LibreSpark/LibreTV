import { NextResponse } from 'next/server';
import { intelligentCollectorRequest } from '@/lib/resource-collector-client';
import { getVerifiedReviewerSubject } from '@/lib/reviewer-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const MAX_BODY_BYTES = 2_500_000;

export async function GET(request: Request) {
  if (!await getVerifiedReviewerSubject(request)) {
    return NextResponse.json({ error: '需要有效的管理员登录或 OIDC 身份。' }, { status: 401 });
  }
  const limit = Math.min(Math.max(Number(new URL(request.url).searchParams.get('limit') ?? 20) || 20, 1), 50);
  return intelligentCollectorRequest(`/v1/batches?limit=${limit}`, {}, 15_000);
}

export async function POST(request: Request) {
  if (!await getVerifiedReviewerSubject(request)) {
    return NextResponse.json({ error: '需要有效的管理员登录或 OIDC 身份。' }, { status: 401 });
  }
  const rawLength = Number(request.headers.get('content-length') ?? 0);
  if (rawLength > MAX_BODY_BYTES) return NextResponse.json({ error: '批次请求超过大小限制。' }, { status: 413 });
  const raw = await request.text();
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return NextResponse.json({ error: '批次请求超过大小限制。' }, { status: 413 });
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: '请求内容不是有效 JSON。' }, { status: 400 });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return NextResponse.json({ error: '请求格式无效。' }, { status: 400 });
  }
  const body = value as Record<string, unknown>;
  if (!Array.isArray(body.urls) || body.urls.length < 1 || body.urls.length > 1000 ||
      body.urls.some((url) => typeof url !== 'string' || url.length < 8 || url.length > 2048)) {
    return NextResponse.json({ error: '每批需提供 1 至 1000 个有效网址。' }, { status: 400 });
  }
  if (body.goal !== undefined && (typeof body.goal !== 'string' || body.goal.trim().length < 1 || body.goal.length > 200)) {
    return NextResponse.json({ error: '采集目标最多 200 个字符。' }, { status: 400 });
  }
  const idempotencyKey = request.headers.get('idempotency-key')?.trim() ?? '';
  if (!/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) {
    return NextResponse.json({ error: '缺少有效的幂等请求标识。' }, { status: 400 });
  }
  return intelligentCollectorRequest('/v1/batches', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ urls: body.urls, ...(typeof body.goal === 'string' ? { goal: body.goal.trim() } : {}) }),
  }, 30_000);
}
