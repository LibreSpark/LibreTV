import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { fetchUpstream, getCache, setCache } from '@/lib/fetch-utils';

export const runtime = 'nodejs';

const CACHE_TTL = 24 * 60 * 60 * 1000;
const IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';

interface TmdbSearchResult {
  poster_path?: string | null;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
}

interface TmdbSearchResponse {
  results?: TmdbSearchResult[];
}

/** 仅供豆瓣推荐与影视热榜在原封面全部加载失败后使用；密钥只在服务端读取。 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const url = new URL(req.url);
  const title = (url.searchParams.get('title') || '').trim().slice(0, 100);
  const type = url.searchParams.get('type') === 'tv' ? 'tv' : 'movie';
  if (!title) return NextResponse.json({ error: '缺少影片标题' }, { status: 400 });

  const cacheKey = `tmdb-poster:${type}:${title.toLowerCase()}`;
  const cached = getCache<string | null>(cacheKey);
  if (cached !== undefined) return NextResponse.json({ poster: cached });

  const apiKey = process.env.METADATA_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: '服务器未配置 METADATA_API_KEY' }, { status: 503 });
  }

  try {
    const endpoint = type === 'tv' ? 'tv' : 'movie';
    const target = new URL(`https://api.themoviedb.org/3/search/${endpoint}`);
    target.searchParams.set('api_key', apiKey);
    target.searchParams.set('query', title);
    target.searchParams.set('language', 'zh-CN');
    target.searchParams.set('include_adult', 'false');

    const res = await fetchUpstream(target.toString(), {
      timeoutMs: 6000,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`TMDB HTTP ${res.status}`);

    const data = (await res.json()) as TmdbSearchResponse;
    const result = data.results?.find((entry) => entry.poster_path);
    const poster = result?.poster_path ? `${IMAGE_BASE}${result.poster_path}` : null;
    setCache(cacheKey, poster, CACHE_TTL);
    return NextResponse.json({ poster });
  } catch {
    return NextResponse.json({ error: 'TMDB 海报查询失败' }, { status: 502 });
  }
}
