
import { NextRequest, NextResponse } from 'next/server';
import { fetchUpstream } from '@/lib/fetch-utils';

export const runtime = 'nodejs';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 8000;

const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/bmp',
]);

function errorResponse(message: string, status: number) {
  return new NextResponse(message, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('url') || '';

  if (!raw || raw.length > 4096) {
    return errorResponse('invalid url', 400);
  }

  let target: URL;

  try {
    target = new URL(raw);

    if (
      target.protocol !== 'http:' &&
      target.protocol !== 'https:'
    ) {
      return errorResponse('bad protocol', 400);
    }

    if (target.username || target.password) {
      return errorResponse('credentials not allowed', 400);
    }
  } catch {
    return errorResponse('invalid url', 400);
  }

  try {
    const upstream = await fetchUpstream(target.toString(), {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
      timeoutMs: IMAGE_TIMEOUT_MS,
      signal: req.signal,
      retries: 0,
      cache: 'no-store',
    });

    if (!upstream.ok) {
      return errorResponse('upstream error', 502);
    }

    const contentType = (
      upstream.headers.get('content-type') || ''
    )
      .split(';')[0]
      .trim()
      .toLowerCase();

    if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
      return errorResponse('unsupported image type', 502);
    }

    const contentLength = Number(
      upstream.headers.get('content-length') || 0
    );

    if (
      Number.isFinite(contentLength) &&
      contentLength > MAX_IMAGE_BYTES
    ) {
      return errorResponse('image too large', 413);
    }

    if (!upstream.body) {
      return errorResponse('empty image response', 502);
    }

    const reader = upstream.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        total += value.byteLength;

        if (total > MAX_IMAGE_BYTES) {
          try {
            await reader.cancel();
          } catch {
            // 忽略取消读取时的错误
          }

          return errorResponse('image too large', 413);
        }

        chunks.push(value);
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // 忽略释放锁时的错误
      }
    }

    if (total === 0) {
      return errorResponse('empty image response', 502);
    }

    const image = new Uint8Array(total);
    let offset = 0;

    for (const chunk of chunks) {
      image.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return new NextResponse(image, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(total),
        'Cache-Control': 'public, max-age=86400, stale-while-revalidate=3600',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    console.error('[api/img] Image proxy failed:', error);

    return errorResponse('image fetch failed', 502);
  }
}
