import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CMS_BASE = process.env.CMS_SEARCH_API || '';
const TIMEOUT_MS = 8000;

export type MovieItem = {
  id: string;
  title: string;
  poster: string;
  link: string;
  year: string;
  rating: string;
  overview: string;
};

// 🚀 核心修复 P1-9：防二次代理套娃
function normalizePoster(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let url = raw.trim();
  if (!url) return '';
  if (url.startsWith('/api/img?')) return url; // 已经是代理路径，直接放行
  if (url.startsWith('//')) url = 'https:' + url;
  if (!/^https?:\/\//i.test(url)) return '';
  if (url.startsWith('http://')) {
    return `/api/img?url=${encodeURIComponent(url)}`;
  }
  return url;
}

// 🚀 核心修复 P1-11：垃圾过滤逻辑
function normalizeName(name: string) {
  return String(name || '').replace(/[\s\(\)（）]/g, '').toLowerCase();
}
function filterBadWords(list: any[], keyword: string) {
  const badWords = ['预告', '花絮', '解说', 'mv', '特辑', '片段', '彩蛋'];
  const nKeyword = normalizeName(keyword);
  return list.filter((m) => {
    const nName = normalizeName(m.vod_name || m.title || '');
    const matchedBadWord = badWords.find((w) => nName.includes(w));
    if (matchedBadWord && !nKeyword.includes(matchedBadWord)) return false;
    return true;
  });
}

async function handleSearch(keyword: string) {
  if (!keyword) return NextResponse.json({ items: [], error: '缺少关键词' }, { status: 400 });
  if (!CMS_BASE) return NextResponse.json({ items: [], error: 'CMS 接口未配置' }, { status: 500 });

  const url = `${CMS_BASE}${CMS_BASE.includes('?') ? '&' : '?'}wd=${encodeURIComponent(keyword)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const upstream = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!upstream.ok) throw new Error(`CMS 接口异常: ${upstream.status}`);

    const data = await upstream.json();
    let rawList = Array.isArray(data?.list) ? data.list : (Array.isArray(data?.data) ? data.data : []);
    
    // 执行垃圾词过滤
    rawList = filterBadWords(rawList, keyword);

    const items: MovieItem[] = rawList.map((it: any) => ({
      id: String(it.vod_id ?? it.id ?? it.vodId ?? ''),
      title: String(it.vod_name ?? it.title ?? '未知影片'),
      poster: normalizePoster(it.vod_pic ?? it.pic ?? it.poster ?? ''),
      link: `/detail/${it.vod_id ?? it.id ?? it.vodId}`,
      year: String(it.vod_year ?? it.year ?? ''),
      rating: String(it.vod_score ?? it.rating ?? ''),
      overview: String(it.vod_remarks ?? it.overview ?? '暂无简介'),
    }));

    return NextResponse.json({ items });
  } catch (err) {
    return NextResponse.json({ items: [], error: '资源搜索超时或失败' }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(req: NextRequest) {
  const keyword = req.nextUrl.searchParams.get('wd') || req.nextUrl.searchParams.get('keyword') || '';
  return handleSearch(keyword.trim());
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const keyword = String(body?.wd || body?.keyword || '').trim();
  return handleSearch(keyword);
}
