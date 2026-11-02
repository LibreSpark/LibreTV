import { NextRequest, NextResponse } from 'next/server';
import { searchMovies } from '@/lib/search';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 10 * 1024;

async function readRequestBody(
  req: NextRequest
): Promise<string> {
  const reader = req.body?.getReader();

  if (!reader) {
    throw new Error('请求体为空');
  }

  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      total += value.byteLength;

      if (total > MAX_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {}

        throw new Error('请求体过大');
      }

      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }

  const merged = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(merged);
}

export async function POST(req: NextRequest) {
  try {
    const raw = await readRequestBody(req);
    const body = JSON.parse(raw);

    if (
      !body ||
      typeof body.wd !== 'string' ||
      !body.wd.trim() ||
      body.wd.length > 50
    ) {
      return NextResponse.json(
        { error: '搜索关键词无效', items: [] },
        { status: 400 }
      );
    }

    const items = await searchMovies(body.wd);

    return NextResponse.json({
      items,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : '搜索请求失败';

    const status = message === '请求体过大'
      ? 413
      : 502;

    return NextResponse.json(
      {
        error: message,
        items: [],
      },
      { status }
    );
  }
}
