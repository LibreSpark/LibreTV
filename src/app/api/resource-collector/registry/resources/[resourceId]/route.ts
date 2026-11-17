import { NextResponse } from 'next/server';
import { guardPrivateFeatureRequest } from '@/lib/api-guard';
import {
  collectorRequest,
  intelligentCollectorConfigured,
  intelligentCollectorRequest,
} from '@/lib/resource-collector-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ resourceId: string }> }) {
  const guarded = guardPrivateFeatureRequest(request);
  if (guarded) return guarded;
  const { resourceId } = await context.params;
  if (!/^[a-z0-9_-]{1,80}$/i.test(resourceId)) return NextResponse.json({ error: '资源 ID 无效' }, { status: 400 });
  if (/^[a-f0-9]{24}$/.test(resourceId) && intelligentCollectorConfigured()) {
    return intelligentCollectorRequest(`/v1/registry/resources/${resourceId}`, {}, 5_000);
  }
  return collectorRequest(`/v1/registry/resources/${resourceId}`, {}, 5_000, request);
}

export async function POST(request: Request, context: { params: Promise<{ resourceId: string }> }) {
  const guarded = guardPrivateFeatureRequest(request);
  if (guarded) return guarded;
  const { resourceId } = await context.params;
  if (!/^[a-z0-9_-]{1,80}$/i.test(resourceId)) return NextResponse.json({ error: '资源 ID 无效' }, { status: 400 });
  const body = await request.text();
  if (body.length > 16 * 1024) return NextResponse.json({ error: '请求体过大' }, { status: 413 });
  if (/^[a-f0-9]{24}$/.test(resourceId) && intelligentCollectorConfigured()) {
    return intelligentCollectorRequest(`/v1/registry/resources/${resourceId}/verifications`, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json' },
    }, 5_000);
  }
  return collectorRequest(`/v1/registry/resources/${resourceId}/verifications`, {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/json' },
  }, 5_000, request);
}
