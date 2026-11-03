import { NextRequest, NextResponse } from 'next/server';
import {
  searchSources,
  mergeSearchResults,
} from '@/lib/search';
import type { SourceConfig } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_KEYWORD_LENGTH = 50;
const MAX_SOURCES = 30;
const MAX_URL_LENGTH = 2048;
const MAX_NAME_LENGTH = 100;

interface SearchRequestBody {
  wd?: unknown;
  keyword?: unknown;
  sources?: unknown;
  filterAdult?: unknown;
}

function jsonError(
  message: string,
  status: number,
) {
  return NextResponse.json(
    {
      error: message,
      items: [],
    },
    { status },
  );
}

/**
 * 流式读取请求体，避免先调用 req.json()
 * 导致超大请求体被完整载入内存。
 */
async function readLimitedBody(
  req: NextRequest,
): Promise<string> {
  const contentLength = req.headers.get('content-length');

  if (contentLength !== null) {
    const length = Number(contentLength);

    if (
      !Number.isSafeInteger(length) ||
      length < 0
    ) {
      throw new Error('INVALID_CONTENT_LENGTH');
    }

    if (length > MAX_BODY_BYTES) {
      throw new Error('BODY_TOO_LARGE');
    }
  }

  if (!req.body) {
    throw new Error('EMPTY_BODY');
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      if (req.signal.aborted) {
        throw new Error('REQUEST_ABORTED');
      }

      const { done, value } = await reader.read();

      if (done) break;

      totalBytes += value.byteLength;

      if (totalBytes > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error('BODY_TOO_LARGE');
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const buffer = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return new TextDecoder('utf-8', {
      fatal: true,
    }).decode(buffer);
  } catch {
    throw new Error('INVALID_UTF8');
  }
}

/**
 * 只负责验证来源配置的数据结构和 URL 格式。
 *
 * 真正的 SSRF、DNS 和重定向安全检查，
 * 由 searchSources -> fetchUpstream -> ssrf 安全层负责。
 */
function validateSources(
  rawSources: unknown,
): SourceConfig[] {
  if (rawSources === undefined) {
    return [];
  }

  if (!Array.isArray(rawSources)) {
    throw new Error('INVALID_SOURCES');
  }

  if (rawSources.length > MAX_SOURCES) {
    throw new Error('TOO_MANY_SOURCES');
  }

  const sources: SourceConfig[] = [];
  const seenKeys = new Set<string>();

  for (const raw of rawSources) {
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw)
    ) {
      throw new Error('INVALID_SOURCE');
    }

    const item = raw as Record<string, unknown>;

    if (
      typeof item.key !== 'string' ||
      typeof item.name !== 'string' ||
      typeof item.url !== 'string'
    ) {
      throw new Error('INVALID_SOURCE_FIELDS');
    }

    const key = item.key.trim();
    const name = item.name.trim();
    const url = item.url.trim();

    if (
      !key ||
      key.length > MAX_NAME_LENGTH ||
      !name ||
      name.length > MAX_NAME_LENGTH ||
      !url ||
      url.length > MAX_URL_LENGTH
    ) {
      throw new Error('INVALID_SOURCE_FIELDS');
    }

    let parsed: URL;

    try {
      parsed = new URL(url);
    } catch {
      throw new Error('INVALID_SOURCE_URL');
    }

    if (
      parsed.protocol !== 'http:' &&
      parsed.protocol !== 'https:'
    ) {
      throw new Error('INVALID_SOURCE_PROTOCOL');
    }

    if (
      parsed.username ||
      parsed.password ||
      !parsed.hostname
    ) {
      throw new Error('INVALID_SOURCE_URL');
    }

    if (seenKeys.has(key)) {
      continue;
    }

    seenKeys.add(key);

    const source: SourceConfig = {
      key,
      name,
      url: parsed.toString(),
      isAdult: item.isAdult === true,
    };

    if (typeof item.detail === 'string') {
      source.detail = item.detail.slice(0, 2048);
    }

    sources.push(source);
  }

  return sources;
}

export async function POST(req: NextRequest) {
  try {
    if (req.signal.aborted) {
      return jsonError('请求已取消', 400);
    }

    let rawBody: string;

    try {
      rawBody = await readLimitedBody(req);
    } catch (error) {
      const code =
        error instanceof Error ? error.message : '';

      if (code === 'BODY_TOO_LARGE') {
        return jsonError('请求体不能超过 64 KB', 413);
      }

      if (code === 'REQUEST_ABORTED') {
        return jsonError('请求已取消', 400);
      }

      if (code === 'EMPTY_BODY') {
        return jsonError('请求内容为空', 400);
      }

      return jsonError('请求内容格式无效', 400);
    }

    let body: SearchRequestBody;

    try {
      body = JSON.parse(rawBody) as SearchRequestBody;
    } catch {
      return jsonError('JSON 格式错误', 400);
    }

    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body)
    ) {
      return jsonError('请求参数格式错误', 400);
    }

    const rawKeyword =
      typeof body.wd === 'string' && body.wd.trim()
        ? body.wd
        : body.keyword;

    if (typeof rawKeyword !== 'string') {
      return jsonError('缺少搜索关键词', 400);
    }

    const keyword = rawKeyword.trim();

    if (!keyword) {
      return jsonError('缺少搜索关键词', 400);
    }

    if (keyword.length > MAX_KEYWORD_LENGTH) {
      return jsonError('搜索关键词不能超过 50 个字符', 400);
    }

    let sources: SourceConfig[];

    try {
      sources = validateSources(body.sources);
    } catch {
      return jsonError('资源站配置无效', 400);
    }

    if (sources.length === 0) {
      return NextResponse.json({
        items: [],
      });
    }

    const filterAdult = body.filterAdult === true;

    const outcomes = await searchSources(
      keyword,
      sources,
      {
        filterAdult,
        signal: req.signal,
      },
    );

    if (req.signal.aborted) {
      return jsonError('请求已取消', 400);
    }

    const items = mergeSearchResults(outcomes);

    return NextResponse.json({
      items,
    });
  } catch {
    // 不向客户端暴露内部异常、堆栈和上游地址。
    return jsonError('搜索服务暂时不可用，请稍后重试', 500);
  }
}
