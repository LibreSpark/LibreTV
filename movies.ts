import { type MovieItem } from '@/types/chat';
import { getEnv } from '@/lib/infra/env';
import { log } from '@/lib/infra/logger';

export async function searchMovies(
  args: Record<string, unknown>, 
  ctx: { signal: AbortSignal, userId: string }
): Promise<{ items: MovieItem[], degraded: boolean }> {
  const keyword = String(args.keyword ?? '').trim();
  if (!keyword) return { items: [], degraded: true };

  const { METADATA_API_KEY } = getEnv();
  
  try {
    // 真实请求 TMDB
    const url = `https://api.themoviedb.org/3/search/movie?api_key=${METADATA_API_KEY}&query=${encodeURIComponent(keyword)}&language=zh-CN&page=1`;
    const res = await fetch(url, { signal: ctx.signal });
    
    if (!res.ok) {
      log.error('[TMDB] 请求失败', { status: res.status });
      return { items: [], degraded: true };
    }

    const data = await res.json();
    const results = data.results || [];

    // 将真实数据转换为标准格式
    const items: MovieItem[] = results.slice(0, 6).map((m: any) => ({
      id: String(m.id),
      title: m.title || m.original_title,
      year: m.release_date ? parseInt(m.release_date.split('-')[0]) : undefined,
      rating: m.vote_average ? Number(m.vote_average.toFixed(1)) : undefined,
      // 拼接真实的 TMDB 海报域名
      poster: m.poster_path ? `https://image.tmdb.org/t/p/w500${m.poster_path}` : '/poster-placeholder.png',
      // 这里需要改成你 LibreTV 真实的详情页路由格式
      path: `/detail/${m.id}`, 
      source: 'tmdb'
    }));

    return { items, degraded: false };
  } catch (e: any) {
    if (e.name !== 'AbortError') {
      log.error('[TMDB] 搜索异常', { error: e.message });
    }
    return { items: [], degraded: true };
  }
}
