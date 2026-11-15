import { NextResponse } from 'next/server';
import { isAuthDisabled, isPasswordConfigured, sessionFromCookieHeader } from './auth';

/** API Route 共享守卫：未配置密码返回 503，未登录返回 401 */
export function guardRequest(req: Request): NextResponse | null {
  // 仅在明确设置 AUTH_DISABLED=true 的预览环境中开放 API；默认仍强制鉴权。
  if (isAuthDisabled()) return null;
  if (!isPasswordConfigured()) {
    return NextResponse.json(
      { error: '服务器未设置 PASSWORD 环境变量' },
      { status: 503 }
    );
  }
  if (!sessionFromCookieHeader(req.headers.get('cookie'))) {
    return NextResponse.json({ error: '未登录' }, { status: 401 });
  }
  return null;
}

export function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}


/**
 * Guard for costly/private features that must never inherit a public preview's
 * AUTH_DISABLED bypass. Public pages may remain accessible, but collector
 * operations always require a password-protected session.
 */
export function guardPrivateFeatureRequest(req: Request): NextResponse | null {
  if (!isAuthDisabled()) return guardRequest(req);

  // Public preview: website login is disabled, but Collector still requires
  // its own HTTPS endpoint + bearer token (browser-local or server-side).
  const browserBase = req.headers.get('x-scrapling-api-base')?.trim() ?? '';
  const browserToken = req.headers.get('x-scrapling-api-token')?.trim() ?? '';

  // Browser-supplied credentials remain supported for operators. A server-
  // configured Collector may serve only the two bounded SeedHub read endpoints
  // anonymously; mutations, discovery, task inspection, and crawling stay closed.
  if (browserBase && browserToken) return null;
  const action = new URL(req.url).searchParams.get('action');
  // SeedHub catalogue/detail GETs have a repository-backed, read-only snapshot
  // fallback. They must remain readable when the optional live Collector is
  // not provisioned; all mutations and other Collector operations stay gated.
  if (req.method === 'GET' &&
      (action === 'seedhub-catalog' || action === 'seedhub-detail')) return null;

  const serverCollectorConfigured = Boolean(
    process.env.SCRAPLING_API_BASE?.trim() && process.env.SCRAPLING_API_TOKEN?.trim()
  );
  if (req.method === 'GET' && serverCollectorConfigured &&
      (action === 'seedhub-catalog' || action === 'seedhub-detail')) return null;

  return NextResponse.json(
    { code: 'COLLECTOR_NOT_CONFIGURED', error: '网站无需访问密码。请先在「设置 → 资源采集中心」配置 Scrapling HTTPS 地址和访问 Token。' },
    { status: 503, headers: { 'Cache-Control': 'no-store' } }
  );
}
