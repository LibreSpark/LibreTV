import { type MovieItem } from '@/types/chat';
import { getEnv } from '@/lib/infra/env';
import { log } from '@/lib/infra/logger';

export async function searchMovies(
  args: Record<string, unknown>, 
  ctx: { signal: AbortSignal, userId: string }
): Promise<{ items: any[], degraded: boolean }> {
  const keyword = String(args.keyword ?? '').trim();
  if (!keyword) return { items: [], degraded: true };

  const { METADATA_API_KEY } = getEnv();
  
  try {
    const url = `https://api.themoviedb.org/3/search/movie?api_key=${METADATA_API_KEY}&query=${encodeURIComponent(keyword)}&language=zh-CN&page=1`;
    const res = await fetch(url, { signal: ctx.signal });
    
    if (!res.ok) {
      log.error('[TMDB] 请求失败', { status: res.status });
      return { items: [], degraded: true };
    }

    const data = await res.json();
    const results = data.results || [];

    // 🚨 拿回全部真实数据
    const items = results.slice(0, 5).map((m: any) => ({
      id: String(m.id),
      title: m.title || m.original_title,
      year: m.release_date ? parseInt(m.release_date.split('-')[0]) : undefined,
      rating: m.vote_average ? Number(m.vote_average.toFixed(1)) : undefined,
      overview: m.overview || '暂无简介',
      poster: m.poster_path ? `https://image.tmdb.org/t/p/w500${m.poster_path}` : '/poster-placeholder.png',
      path: `/detail/${m.id}`, 
    }));

    return { items, degraded: false };
  } catch (e: any) {
    if (e.name !== 'AbortError') log.error('[TMDB] 搜索异常', { error: e.message });
    return { items: [], degraded: true };
  }
}
