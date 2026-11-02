import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('url') || '';
  let target: URL;
  try {
    target = new URL(raw);
    // 🚀 核心修复 P1-8：拦截内网 IP 和协议
    if (!['http:', 'https:'].includes(target.protocol)) return new NextResponse('bad protocol', { status: 400 });
    const host = target.hostname.toLowerCase();
    if (host === 'localhost' || host === '::1' || host.startsWith('127.') || host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('169.254.')) {
      return new NextResponse('forbidden host', { status: 403 });
    }
  } catch {
    return new NextResponse('invalid url', { status: 400 });
  }
  
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const upstream = await fetch(target.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: controller.signal,
    });
    if (!upstream.ok) return new NextResponse('upstream error', { status: 502 });

    const contentType = upstream.headers.get('content-type') || 'image/jpeg';
    return new NextResponse(await upstream.arrayBuffer(), {
      headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=86400' },
    });
  } catch {
    return new NextResponse('fetch failed', { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}
