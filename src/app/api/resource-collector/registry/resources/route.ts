import { NextResponse } from 'next/server';
import { guardPrivateFeatureRequest } from '@/lib/api-guard';
import {
  collectorRequest,
  intelligentCollectorConfigured,
  intelligentCollectorRequest,
} from '@/lib/resource-collector-client';
import { mergeRegistryPayloads } from '@/lib/registry-merge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function readPayload(response: Response) {
  return response.json().catch(() => null) as Promise<unknown>;
}

export async function GET(request: Request) {
  const guarded = guardPrivateFeatureRequest(request);
  if (guarded) return guarded;
  const url = new URL(request.url);
  const params = new URLSearchParams({
    q: url.searchParams.get('q') ?? '',
    verified_only: url.searchParams.get('verified_only') ?? 'true',
    limit: url.searchParams.get('limit') ?? '30',
  });
  const limit = Math.min(Math.max(Number(params.get('limit')) || 30, 1), 100);
  const legacyPromise = collectorRequest(
    `/v1/registry/resources?${params.toString()}`,
    {},
    5_000,
    request,
  );
  const enginePromise = intelligentCollectorConfigured()
    ? intelligentCollectorRequest(
        `/v1/registry/resources?q=${encodeURIComponent(params.get('q') ?? '')}&limit=${limit}`,
        {},
        5_000,
      )
    : Promise.resolve(null);
  const [legacyResponse, engineResponse] = await Promise.all([legacyPromise, enginePromise]);
  const legacyPayload = await readPayload(legacyResponse);
  const enginePayload = engineResponse ? await readPayload(engineResponse) : null;
  const successful = [
    ...(legacyResponse.ok ? [legacyPayload] : []),
    ...(engineResponse?.ok ? [enginePayload] : []),
  ];
  if (!successful.length) {
    const failure = engineResponse && engineResponse.status >= 500 ? engineResponse : legacyResponse;
    const payload = engineResponse === failure ? enginePayload : legacyPayload;
    return NextResponse.json(
      payload && typeof payload === 'object' ? payload : { error: '资源站暂时不可用。' },
      { status: failure.status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return NextResponse.json(mergeRegistryPayloads(successful), {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function POST(request: Request) {
  const guarded = guardPrivateFeatureRequest(request);
  if (guarded) return guarded;
  const body = await request.text();
  if (body.length > 64 * 1024) return NextResponse.json({ error: '请求体过大' }, { status: 413 });
  return collectorRequest('/v1/registry/resources', { method: 'POST', body, headers: { 'Content-Type': 'application/json' } }, 5_000, request);
}
