
import { NextRequest, NextResponse } from 'next/server';
import { fetchUpstream } from '@/lib/fetch-utils';

export const runtime = 'nodejs';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 8000;

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('url') || '';

  if (!raw || raw.length > 4096) {
    return new NextResponse('invalid url', { status: 400 });
  }

  let target: URL;

  try {
    target = new URL(raw);

    if (
      target.protocol !== 'http:' &&
      target.protocol !== 'https:'
    ) {
      return new NextResponse('bad protocol', { status: 400 });
    }

    if (target.username || target.password) {
      return new NextResponse('credentials not allowed', {
        status: 400,
      });
    }
  } catch {
    return new NextResponse('invalid url', { status: 400 });
  }

  try {
    const upstream = await fetchUpstream(target.toString(), {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      },
      timeoutMs: IMAGE_TIMEOUT_MS,
      retries: 0,
      safeRedirects: true,
      cache: 'no-store',
    });

    if (!upstream.ok) {
      return new NextResponse('upstream error', {
        status: 502,
      });
    }

    const contentType = (
      upstream.headers.get('content-type') || ''
    )
      .split(';')[0]
      .trim()
      .toLowerCase();

    if (!contentType.startsWith('image/')) {
      return new NextResponse('invalid image content type', {
        status: 502,
      });
    }

    const contentLength = Number(
      upstream.headers.get('content-length') || 0
    );

    if (
      Number.isFinite(contentLength) &&
      contentLength > MAX_IMAGE_BYTES
    ) {
      return new NextResponse('image too large', {
        status: 413,
      });
    }

    if (!upstream.body) {
      return new NextResponse('empty image response', {
        status: 502,
      });
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
          await reader.cancel();

          return new NextResponse('image too large', {
            status: 413,
          });
        }

        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    if (total === 0) {
      return new NextResponse('empty image response', {
        status: 502,
      });
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
        'Cache-Control': 'public, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    console.error('[api/img] Image proxy failed:', error);

    return new NextResponse('image fetch failed', {
      status: 502,
    });
  }
}
