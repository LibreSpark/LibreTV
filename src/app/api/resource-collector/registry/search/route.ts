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
  const query = new URL(request.url).searchParams.get('q')?.trim() ?? '';
  if (!query || query.length > 50) {
    return NextResponse.json({ resources: [], queued: [] }, { status: 200 });
  }
  const legacyPromise = collectorRequest(
    `/v1/registry/search?q=${encodeURIComponent(query)}`,
    {},
    2_000,
    request,
  );
  const enginePromise = intelligentCollectorConfigured()
    ? intelligentCollectorRequest(`/v1/registry/search?q=${encodeURIComponent(query)}`, {}, 5_000)
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
