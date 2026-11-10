import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { cmsRequestHeaders, isAdultContent } from '@/lib/cms-parser';
import { catalogParameters, catalogQuery, loadCatalog } from '@/lib/catalog-core';
import { fetchUpstream } from '@/lib/fetch-utils';
import { checkUpstreamAllowed } from '@/lib/ssrf';

export const runtime = 'nodejs';
export async function POST(req: Request) {
  const guarded = guardRequest(req); if (guarded) return guarded;
  try {
    const body = await req.json();
    if (!body || typeof body !== 'object') return NextResponse.json({ error: '无效的目录请求' }, { status: 400 });
    const { page, category } = catalogParameters(body.page, body.category);
    const query = catalogQuery(body.query);
    const source = body.source;
    if (!source || typeof source.url !== 'string' || source.url.length > 2048) return NextResponse.json({ error: '无效的点播源' }, { status: 400 });
    if (body.filterAdult !== false && source.isAdult) return NextResponse.json({ error: '此点播源已被内容过滤隐藏' }, { status: 403 });
    const verdict = await checkUpstreamAllowed(source.url);
    if (!verdict.ok) return NextResponse.json({ error: verdict.reason }, { status: 400 });
    const data = await loadCatalog(source.url, page, category, body.filterAdult === false ? () => false : isAdultContent, async url => {
      const res = await fetchUpstream(url, { headers: cmsRequestHeaders(), timeoutMs: 10000, retries: 0, signal: req.signal });
      if (!res.ok) throw new Error(`点播源暂时不可用（HTTP ${res.status}）`);
      return res.json();
    }, query);
    return NextResponse.json(data, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (e) {
    const message = e instanceof Error ? e.message : '目录加载失败';
    return NextResponse.json({ error: message }, { status: message.startsWith('无效') ? 400 : 502 });
  }
}
