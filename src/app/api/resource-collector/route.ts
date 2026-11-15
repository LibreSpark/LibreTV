import { NextRequest, NextResponse } from 'next/server';
import { guardPrivateFeatureRequest } from '@/lib/api-guard';
import { collectorRequest } from '@/lib/resource-collector-client';
const SEEDHUB_IMAGE_HOSTS = new Set(['www.seedhub.cc', 'img.seedhub.cc', 'sh1.pcie.pppoe.top']);

function decodeSeedHubEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (match, entity: string) => {
    const key = entity.toLowerCase();
    if (key === 'amp') return '&';
    if (key === 'quot') return '"';
    if (key === 'apos' || key === '#39') return "'";
    if (key === 'lt') return '<';
    if (key === 'gt') return '>';
    if (key === 'nbsp') return ' ';
    if (key.startsWith('#x')) return String.fromCodePoint(Number.parseInt(key.slice(2), 16));
    if (key.startsWith('#')) return String.fromCodePoint(Number.parseInt(key.slice(1), 10));
    return match;
  });
}

function stripSeedHubMarkup(value: string): string {
  return decodeSeedHubEntities(value
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

function seedHubAttribute(tag: string, name: string): string {
  const match = tag.match(new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\\x27([^\\x27]*)\\x27|([^\\s>]+))', 'i'));
  return decodeSeedHubEntities((match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim());
}

function trustedSeedHubImage(raw: string, baseUrl: string): string | null {
  try {
    const image = new URL(raw, baseUrl);
    if (image.protocol !== 'https:' || !SEEDHUB_IMAGE_HOSTS.has(image.hostname) ||
        !/^\/static\/pics\/[^/]+\.(?:avif|jpe?g|png|webp)$/i.test(image.pathname)) return null;
    image.search = '';
    image.hash = '';
    return image.toString();
  } catch {
    return null;
  }
}

function parseSeedHubDetailHtml(
  html: string,
  sourceUrl: string,
  category: 'movies' | 'series' | 'anime',
  preferredPosterUrl: string | null,
): Record<string, unknown> {
  const pageUrl = new URL(sourceUrl);
  const meta = new Map<string, string>();
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const key = (seedHubAttribute(tag, 'property') || seedHubAttribute(tag, 'name')).toLowerCase();
    const content = seedHubAttribute(tag, 'content');
    if (key && content && !meta.has(key)) meta.set(key, content);
  }
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? '';
  const titleTag = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '';
  let title = stripSeedHubMarkup(meta.get('og:title') || h1 || titleTag);
  title = title.replace(/^[#\s]+/, '').replace(/\s*-\s*SeedHub.*$/i, '').trim();

  const headings = [...html.matchAll(/<h[23]\b[^>]*>[\s\S]*?<\/h[23]>/gi)];
  const introIndex = headings.findIndex((heading) => stripSeedHubMarkup(heading[0]).includes('简介'));
  let sectionDescription = '';
  if (introIndex >= 0) {
    const heading = headings[introIndex];
    const start = (heading.index ?? 0) + heading[0].length;
    const end = headings[introIndex + 1]?.index ?? Math.min(html.length, start + 16_000);
    sectionDescription = stripSeedHubMarkup(html.slice(start, end)).slice(0, 4_000);
  }
  const description = (meta.get('og:description') || meta.get('description') || sectionDescription).trim().slice(0, 4_000);

  const imageUrls = new Set<string>();
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const raw = seedHubAttribute(tag, 'data-src') ||
      seedHubAttribute(tag, 'data-original') ||
      seedHubAttribute(tag, 'src');
    const image = raw ? trustedSeedHubImage(raw, pageUrl.toString()) : null;
    if (image) imageUrls.add(image);
  }
  const preferredPoster = preferredPosterUrl ? trustedSeedHubImage(preferredPosterUrl, pageUrl.toString()) : null;
  const ogPoster = trustedSeedHubImage(meta.get('og:image') || '', pageUrl.toString());
  const posterUrl = preferredPoster || ogPoster || [...imageUrls][0] || null;
  const stillUrls = [...imageUrls].filter((image) => image !== posterUrl).slice(0, 30);

  const firstHeadingIndex = html.search(/<h[23]\b/i);
  const headerText = stripSeedHubMarkup(html.slice(0, firstHeadingIndex >= 0 ? firstHeadingIndex : 12_000));
  const labels = [
    ['director', '导演'],
    ['writers', '编剧'],
    ['cast', '主演'],
    ['genres', '类型'],
    ['countries', '制片国家/地区'],
    ['languages', '语言'],
    ['premiere', '首播'],
    ['episode_count', '集数'],
    ['runtime', '单集片长'],
    ['aliases', '又名'],
  ] as const;
  const metadata: Record<string, string> = {};
  for (let index = 0; index < labels.length; index += 1) {
    const [key, labelText] = labels[index];
    const labelIndex = headerText.indexOf(labelText);
    if (labelIndex < 0) continue;
    const valueStart = labelIndex + labelText.length;
    let valueEnd = headerText.length;
    for (const [, nextLabel] of labels.slice(index + 1)) {
      const nextIndex = headerText.indexOf(nextLabel, valueStart);
      if (nextIndex >= 0) valueEnd = Math.min(valueEnd, nextIndex);
    }
    const value = headerText.slice(valueStart, valueEnd).replace(/^[：:\s/|]+|[：:\s/|]+$/g, '').trim().slice(0, 1_000);
    if (value) metadata[key] = value;
  }

  const canonical = new URL(pageUrl);
  canonical.search = '';
  canonical.hash = '';
  return {
    source_name: 'SeedHub',
    source_url: canonical.toString(),
    title,
    category,
    description,
    metadata,
    poster_url: posterUrl,
    still_urls: stillUrls,
    mode: 'metadata-only',
    external_resource_links_extracted: false,
  };
}

async function readSeedHubHtmlLimited(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('SeedHub detail HTML exceeded size limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(bytes);
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const guarded = guardPrivateFeatureRequest(request);
  if (guarded) return guarded;
  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  if (action === 'stats') {
    const host = url.searchParams.get('host');
    const query = host ? '?host=' + encodeURIComponent(host) : '';
    return collectorRequest('/v1/stats' + query, {}, 10_000, request);
  }
  if (action === 'resources') {
    const limit = url.searchParams.get('limit') ?? '100';
    if (!/^[0-9]{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100) {
      return NextResponse.json({ error: 'Invalid resource limit.' }, { status: 400 });
    }
    return collectorRequest('/v1/registry/resources?verified_only=true&limit=' + limit, {}, 10_000, request);
  }
  if (action === 'jobs') {
    const limit = url.searchParams.get('limit') ?? '50';
    if (!/^[0-9]{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100) {
      return NextResponse.json({ error: 'Invalid collector job limit.' }, { status: 400 });
    }
    return collectorRequest('/v1/jobs?limit=' + limit, {}, 10_000, request);
  }
  if (action === 'seedhub-detail') {
    const detailUrl = url.searchParams.get('url') ?? '';
    const category = url.searchParams.get('category');
    if (category && !/^(movies|series|anime)$/.test(category)) {
      return NextResponse.json({ error: 'Invalid SeedHub category.' }, { status: 400 });
    }
    let parsed: URL;
    try { parsed = new URL(detailUrl); } catch {
      return NextResponse.json({ error: 'Invalid SeedHub detail URL.' }, { status: 400 });
    }
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.seedhub.cc' ||
        parsed.username || parsed.password || (parsed.port && parsed.port !== '443') ||
        !/^\/(movies|series|anime)\/\d+\/?$/.test(parsed.pathname)) {
      return NextResponse.json({ error: 'Only SeedHub detail pages are accepted.' }, { status: 400 });
    }
    const categoryQuery = category ? '&category=' + category : '';
    const hasBrowserCollectorCredentials = Boolean(
      request.headers.get('x-scrapling-api-base')?.trim() &&
      request.headers.get('x-scrapling-api-token')?.trim()
    );
    const cacheOnlyQuery = hasBrowserCollectorCredentials ? '' : '&cache_only=true';
    const collectorResponse = await collectorRequest(
      '/v1/seedhub/detail?url=' + encodeURIComponent(parsed.toString()) + categoryQuery + cacheOnlyQuery,
      {}, 30_000, request,
    );
    if (collectorResponse.status !== 503) return collectorResponse;
    const detailCategory = (category ?? 'movies') as 'movies' | 'series' | 'anime';
    // Public SeedHub detail pages contain metadata and still images. When the
    // persistent Scrapling Collector is not provisioned, fetch only this fixed
    // public origin as a metadata-only fallback; never parse or return share URLs.
    try {
      const directResponse = await fetch(parsed.toString(), {
        redirect: 'error',
        signal: AbortSignal.timeout(8_000),
        headers: { Accept: 'text/html,application/xhtml+xml' },
      });
      const contentType = directResponse.headers.get('content-type') ?? '';
      const declaredLength = Number(directResponse.headers.get('content-length') ?? '0');
      if (directResponse.ok && contentType.toLowerCase().includes('text/html') &&
          (!declaredLength || declaredLength <= 512 * 1024)) {
        const html = await readSeedHubHtmlLimited(directResponse, 512 * 1024);
        const detail = parseSeedHubDetailHtml(html, parsed.toString(), detailCategory, null);
        if (typeof detail.title === 'string' && detail.title.trim()) {
          return NextResponse.json(detail, {
            headers: { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600' },
          });
        }
      }
    } catch {
      // A blocked, redirected, oversized, or unavailable page remains unverified.
    }
    return collectorResponse;
  }
  if (action === 'seedhub-catalog') {
    const category = url.searchParams.get('category') ?? 'movies';
    const limit = url.searchParams.get('limit') ?? '50';
    const offset = url.searchParams.get('offset') ?? '0';
    if (!/^(movies|series|anime)$/.test(category) || !/^\d{1,3}$/.test(limit) || !/^\d{1,7}$/.test(offset)) {
      return NextResponse.json({ error: 'Invalid SeedHub catalogue query.' }, { status: 400 });
    }
    const collectorResponse = await collectorRequest(
      `/v1/seedhub/catalog?category=${category}&limit=${limit}&offset=${offset}`,
      {}, 10_000, request,
    );
    if (collectorResponse.status !== 503) return collectorResponse;
    return NextResponse.json({
      source: 'SeedHub',
      category,
      total: 0,
      items: [],
      snapshot: false,
      updated_at: null,
    }, { headers: { 'Cache-Control': 'no-store' } });
  }
  if (action === 'discover') return collectorRequest('/v1/discover', {}, 20_000, request);
  return collectorRequest(action === 'tasks' ? '/v1/tasks' : '/v1/discover', {}, 20_000, request);
}

export async function POST(request: NextRequest) {
  const guarded = guardPrivateFeatureRequest(request);
  if (guarded) return guarded;

  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > 8_192) {
    return NextResponse.json({ error: 'Request body is too large.' }, { status: 413 });
  }

  let body: unknown;
  try {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > 8_192) {
      return NextResponse.json({ error: 'Request body is too large.' }, { status: 413 });
    }
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid collector request.' }, { status: 400 });
  }
  const payload = body as Record<string, unknown>;
  if (payload.jobAction === 'retry' || payload.jobAction === 'cancel') {
    const jobId = typeof payload.jobId === 'string' ? payload.jobId : '';
    if (!/^[a-f0-9]{32}$/i.test(jobId)) {
      return NextResponse.json({ error: 'Invalid collector job ID.' }, { status: 400 });
    }
    const action = payload.jobAction;
    return collectorRequest(`/v1/jobs/${jobId}/${action}`, { method: 'POST' }, 10_000, request);
  }

  if (payload.discover === true) {
    const searchKeyword = typeof payload.searchKeyword === 'string' ? payload.searchKeyword.trim().slice(0, 50) : '';
    const idempotencyKey = typeof payload.idempotencyKey === 'string' && payload.idempotencyKey.length <= 200
      ? payload.idempotencyKey
      : 'resource-discover:' + (searchKeyword || 'all');
    return collectorRequest('/v1/tasks/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job_type: 'discover',
        payload: { ...(searchKeyword ? { search_keyword: searchKeyword } : {}) },
        idempotency_key: idempotencyKey,
      }),
    }, 5_000, request);
  }


  if (typeof payload.candidateId === 'string') {
    if (!/^[a-f0-9]{32}$/i.test(payload.candidateId)) {
      return NextResponse.json({ error: 'Invalid candidate ID.' }, { status: 400 });
    }
    return collectorRequest(`/v1/candidates/${payload.candidateId}/validate`, { method: 'POST' }, 20_000, request);
  }
  if (typeof payload.url !== 'string' || payload.url.length > 2_048) {
    return NextResponse.json({ error: 'A valid FMHY site URL is required.' }, { status: 400 });
  }

  let parsed: URL;
  try {
    parsed = new URL(payload.url);
  } catch {
    return NextResponse.json({ error: 'Invalid URL.' }, { status: 400 });
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) {
    return NextResponse.json({ error: 'Only public HTTPS URLs on the default port are accepted.' }, { status: 400 });
  }

  return collectorRequest('/v1/crawl', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: parsed.toString(), limit: 50 }),
  }, 65_000, request);
}
