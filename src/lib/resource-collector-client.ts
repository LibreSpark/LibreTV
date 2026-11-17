import { NextResponse } from 'next/server';

const DEFAULT_TIMEOUT_MS = 20_000;

function validCollectorBase(rawBase: string): string | null {
  try {
    const parsed = new URL(rawBase.trim());
    const hostname = parsed.hostname.toLowerCase();
    const isIpLiteral = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':');
    if (parsed.protocol !== 'https:' || (parsed.port && parsed.port !== '443') ||
      parsed.username || parsed.password || (parsed.pathname !== '' && parsed.pathname !== '/') ||
      parsed.search || parsed.hash || isIpLiteral || hostname === 'localhost' ||
      !hostname.includes('.') || /(^|\.)(local|internal|localhost|test|invalid)$/.test(hostname)) return null;
    return parsed.origin;
  } catch { return null; }
}

function collectorConfig(request?: Request) {
  const browserBase = request?.headers.get('x-scrapling-api-base')?.trim() ?? '';
  const browserToken = request?.headers.get('x-scrapling-api-token')?.trim() ?? '';
  if (browserBase || browserToken) {
    const base = validCollectorBase(browserBase);
    if (!base || !browserToken || browserToken.length > 4096) return null;
    return { base, token: browserToken };
  }

  const base = validCollectorBase(process.env.SCRAPLING_API_BASE ?? '');
  const token = process.env.SCRAPLING_API_TOKEN?.trim();
  return base && token ? { base, token } : null;
}

/** Server-side proxy. Browser overrides are accepted only after the route's private-feature auth guard. */
export async function collectorRequest(
  path: string,
  init: Pick<RequestInit, 'method' | 'body' | 'headers'> = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  request?: Request,
) {
  const config = collectorConfig(request);
  if (!config) {
    return NextResponse.json(
      { error: 'Scrapling 配置缺失或不符合安全要求。请检查本机设置中的 HTTPS 地址和 Token，或服务端环境变量。' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  try {
    const response = await fetch(config.base + path, {
      method: init.method ?? 'GET',
      ...(init.body !== undefined ? { body: init.body } : {}),
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${config.token}` },
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status >= 300 && response.status < 400) {
      return NextResponse.json({ code: 'COLLECTOR_REDIRECT_REJECTED', error: 'Collector 返回了重定向，已按安全策略拒绝。' }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
    }
    const payload = await response.json().catch(() => null);
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return NextResponse.json(
        { code: 'COLLECTOR_INVALID_RESPONSE', error: 'Collector 返回了非 JSON 或无效响应。' },
        { status: 502, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    return NextResponse.json(payload, { status: response.status, headers: { 'Cache-Control': 'no-store' } });
  } catch (reason) {
    const timedOut = reason instanceof Error && reason.name === 'TimeoutError';
    return NextResponse.json(
      { code: timedOut ? 'COLLECTOR_TIMEOUT' : 'COLLECTOR_UNREACHABLE', error: timedOut ? '连接 Scrapling 采集服务超时。请检查公网地址、网络出口和服务响应时间。' : '无法连接 Scrapling 采集服务。请检查公网地址、TLS 证书和网络出口。' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}

function intelligentCollectorConfig() {
  const rawBase = process.env.SCRAPLING_ENGINE_URL?.trim() ?? '';
  const token = (process.env.SCRAPLING_ENGINE_API_KEY ?? process.env.SCRAPLING_API_KEY)?.trim();
  if (!rawBase || !token || token.length < 32 || token.length > 4096) return null;
  try {
    const parsed = new URL(rawBase);
    const hostname = parsed.hostname.toLowerCase();
    const localHost = ['scrapling-engine', 'localhost', '127.0.0.1', '::1'].includes(hostname);
    if ((parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && localHost)) ||
      parsed.username || parsed.password || (parsed.pathname !== '' && parsed.pathname !== '/') ||
      parsed.search || parsed.hash) return null;
    return { base: parsed.origin, token };
  } catch {
    return null;
  }
}

export function intelligentCollectorConfigured(): boolean {
  return intelligentCollectorConfig() !== null;
}

export async function intelligentCollectorRequest(
  path: string,
  init: Pick<RequestInit, 'method' | 'body' | 'headers'> = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
) {
  const config = intelligentCollectorConfig();
  if (!config || !path.startsWith('/v1/')) {
    return NextResponse.json(
      { code: 'INTELLIGENT_COLLECTOR_NOT_CONFIGURED', error: '千级智能采集服务尚未配置或尚未启动。' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  try {
    const url = new URL(path, config.base);
    if (url.origin !== config.base || !url.pathname.startsWith('/v1/')) {
      return NextResponse.json({ error: 'Invalid intelligent collector route.' }, { status: 400 });
    }
    const headers = new Headers(init.headers);
    headers.set('X-API-Key', config.token);
    headers.set('Accept', 'application/json');
    const response = await fetch(url, {
      method: init.method ?? 'GET',
      ...(init.body !== undefined ? { body: init.body } : {}),
      headers,
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status >= 300 && response.status < 400) {
      return NextResponse.json({ code: 'ENGINE_REDIRECT_REJECTED', error: '采集引擎重定向已被安全策略拒绝。' }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
    }
    const payload = await response.json().catch(() => null);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return NextResponse.json({ code: 'ENGINE_INVALID_RESPONSE', error: '采集引擎返回了无效响应。' }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
    }
    return NextResponse.json(payload, { status: response.status, headers: { 'Cache-Control': 'no-store' } });
  } catch (reason) {
    const timedOut = reason instanceof Error && reason.name === 'TimeoutError';
    return NextResponse.json(
      { code: timedOut ? 'ENGINE_TIMEOUT' : 'ENGINE_UNREACHABLE', error: timedOut ? '智能采集服务超时。' : '无法连接智能采集服务，请检查 crawler profile 与数据库。' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
