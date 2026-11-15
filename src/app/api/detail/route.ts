import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { cmsDescriptionToText, cmsRequestHeaders, parseDetail, parseDetailPageHtml } from '@/lib/cms-parser';
import { fetchUpstream, getCache, setCache } from '@/lib/fetch-utils';
import { checkUpstreamAllowed } from '@/lib/ssrf';
import { enrichEpisodesWithTmdbArtwork } from '@/lib/tmdb-episode-artwork';
import type { SourceConfig, VideoDetail, VideoEpisode } from '@/lib/types';

export const runtime = 'nodejs';

/** 详情结果短缓存：换源测速/多人观看同一影片时避免重复打上游 */
const DETAIL_CACHE_TTL = 60 * 1000;

function parseSource(raw: string | null): SourceConfig | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as SourceConfig;
    if (!obj || !/^https?:\/\//.test(obj.url || '')) return null;
    return obj;
  } catch {
    return null;
  }
}

/**
 * 视频详情：优先走列表接口 ?ac=videolist&ids=，
 * 拿不到播放地址时（部分源需要爬详情页）降级到 detail 页 HTML 提取。
 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const url = new URL(req.url);
  const id = (url.searchParams.get('id') || '').trim();
  const source = parseSource(url.searchParams.get('source'));
  const baseUrl = (url.searchParams.get('baseUrl') || '').trim(); // 可选：详情页根地址

  if (!id || !/^[\w-]+$/.test(id)) {
    return NextResponse.json({ error: '无效的视频ID' }, { status: 400 });
  }
  if (!source) {
    return NextResponse.json({ error: '无效的点播源配置' }, { status: 400 });
  }

  try {
    // 详情页根地址：显式 detail 优先，其次 baseUrl 参数，最后用接口地址的 origin 推导
    // （Apple CMS 的详情页通常与接口同域）。脏 URL 会让 new URL 抛错，由外层 catch 兜底
    const detailRoot = (source.detail || baseUrl || new URL(source.url).origin).replace(/\/+$/, '');
    const cacheKey = `detail:${source.url}|${detailRoot}|${id}`;
    const cached = getCache<VideoDetail>(cacheKey);
    if (cached) {
      return NextResponse.json(cached);
    }

    // 用户可控地址发起服务端请求，先过 SSRF 校验（协议白名单 + 内网/保留地址）
    const listVerdict = await checkUpstreamAllowed(source.url);
    if (!listVerdict.ok) {
      return NextResponse.json({ error: listVerdict.reason }, { status: 400 });
    }

    const sourceHost = new URL(source.url).hostname.toLowerCase();
    let resolved: VideoDetail | null = null;

    if (source.key === 'kkphim' || sourceHost === 'phimapi.com') {
      const sourceUrl = new URL(source.url);
      if (sourceHost !== 'phimapi.com' || sourceUrl.origin !== 'https://phimapi.com' || sourceUrl.pathname !== '/') {
        return NextResponse.json({ error: 'KKPhim 仅允许 https://phimapi.com 根地址' }, { status: 400 });
      }

      const kkphimUrl = new URL(`/phim/${encodeURIComponent(id)}`, sourceUrl.origin);
      const kkphimResponse = await fetchUpstream(kkphimUrl.toString(), {
        timeoutMs: 10000,
        signal: req.signal,
        headers: cmsRequestHeaders(),
      });
      if (!kkphimResponse.ok) {
        return NextResponse.json({ error: `KKPhim 详情接口返回 HTTP ${kkphimResponse.status}` }, { status: 502 });
      }

      const payload = await kkphimResponse.json() as {
        movie?: Record<string, unknown>;
        episodes?: Array<Record<string, unknown>>;
      };
      const movie = payload?.movie;
      if (!movie || String(movie.slug ?? '').trim() !== id) {
        return NextResponse.json({ error: 'KKPhim 返回的影片与请求 ID 不匹配' }, { status: 404 });
      }

      const rawEpisodes: Array<{ name: string; url: string }> = [];
      for (const server of Array.isArray(payload.episodes) ? payload.episodes : []) {
        const serverData = Array.isArray(server.server_data) ? server.server_data : [];
        for (const entry of serverData) {
          if (!entry || typeof entry !== 'object') continue;
          const item = entry as Record<string, unknown>;
          const rawUrl = typeof item.link_m3u8 === 'string' ? item.link_m3u8.trim() : '';
          const name = typeof item.name === 'string' ? item.name.trim() : '';
          if (!rawUrl || !name) continue;
          try {
            const mediaUrl = new URL(rawUrl);
            if (mediaUrl.protocol !== 'https:' || mediaUrl.username || mediaUrl.password) continue;
            rawEpisodes.push({ name, url: mediaUrl.toString() });
          } catch {
            // Ignore malformed third-party stream URLs.
          }
          if (rawEpisodes.length >= 200) break;
        }
        if (rawEpisodes.length >= 200) break;
      }

      // Validate each distinct media host through the shared SSRF/DNS guard before
      // returning any third-party playback URL to the player.
      const hostVerdicts = new Map<string, Promise<boolean>>();
      const safeEpisodes: VideoEpisode[] = [];
      for (const episode of rawEpisodes) {
        const host = new URL(episode.url).hostname.toLowerCase();
        if (!hostVerdicts.has(host)) {
          hostVerdicts.set(host, checkUpstreamAllowed(episode.url).then((verdict) => verdict.ok));
        }
        if (await hostVerdicts.get(host)) {
          safeEpisodes.push({
            title: episode.name,
            url: episode.url,
          });
        }
      }

      if (safeEpisodes.length === 0) {
        return NextResponse.json({ error: 'KKPhim 没有返回通过安全校验的 HLS 播放地址' }, { status: 404 });
      }

      const stringValue = (value: unknown): string | undefined =>
        typeof value === 'string' || typeof value === 'number' ? String(value).trim() || undefined : undefined;
      const stringList = (value: unknown): string | undefined =>
        Array.isArray(value) ? value.map(stringValue).filter(Boolean).join(' / ') || undefined : stringValue(value);
      const quality = stringValue(movie.quality);
      const language = stringValue(movie.lang);
      const currentEpisode = stringValue(movie.episode_current);

      resolved = {
        episodes: safeEpisodes.map((episode) => episode.url),
        episodeItems: safeEpisodes,
        videoInfo: {
          title: stringValue(movie.name),
          originalTitle: stringValue(movie.origin_name),
          cover: stringValue(movie.poster_url) || stringValue(movie.thumb_url),
          desc: cmsDescriptionToText(movie.content),
          typeName: stringValue(movie.type === 'single' ? '电影' : movie.type === 'series' ? '电视剧' : movie.type),
          year: stringValue(movie.year),
          area: Array.isArray(movie.country)
            ? movie.country.map((entry) => entry && typeof entry === 'object' ? stringValue((entry as Record<string, unknown>).name) : undefined).filter(Boolean).join(' / ')
            : undefined,
          director: stringList(movie.director),
          actor: stringList(movie.actor),
          remarks: [quality, language, currentEpisode].filter(Boolean).join(' · ') || undefined,
          sourceKey: source.key,
          sourceName: source.name,
          sourceUrl: source.url,
        },
      };
    } else {
    // 1) 标准 CMS 详情接口。暴风官方 JSON 文档指定 ac=detail；
    // 其它 Apple CMS 源继续使用兼容性更广的 ac=videolist。
    const action = sourceHost === 'bfzyapi.com' ? 'detail' : 'videolist';
    const api = `${source.url.replace(/\/+$/, '')}?ac=${action}&ids=${encodeURIComponent(id)}`;
    const res = await fetchUpstream(api, { timeoutMs: 10000, signal: req.signal, headers: cmsRequestHeaders() });
    if (res.ok) {
      const data = await res.json();
      try {
        // CMS 可能忽略 ids 参数并返回列表中的其他影片。
        // 只有第一条记录的 vod_id 与请求 ID 精确匹配时，才允许作为当前详情。
        const first = data && typeof data === 'object' && Array.isArray((data as { list?: unknown }).list)
          ? (data as { list: Array<Record<string, unknown>> }).list[0]
          : undefined;
        const returnedId = first?.vod_id === undefined || first?.vod_id === null
          ? ''
          : String(first.vod_id).trim();
        if (returnedId === id) {
          const detail = parseDetail(data, source);
          if (detail.episodes.length > 0) {
            resolved = detail;
          }
        }
        // ID 不匹配、无详情或无播放地址 → 继续尝试请求 ID 对应的详情页
      } catch {
        // 列表接口无内容或格式异常 → 继续尝试详情页
      }
    }

    // 2) 详情页 HTML 提取
    if (!resolved && /^https?:\/\//.test(detailRoot)) {
      const detailVerdict = await checkUpstreamAllowed(detailRoot);
      if (!detailVerdict.ok) {
        return NextResponse.json({ error: detailVerdict.reason }, { status: 400 });
      }
      const detailUrl = `${detailRoot}/index.php/vod/detail/id/${id}.html`;
      const detailRes = await fetchUpstream(detailUrl, {
        timeoutMs: 10000,
        signal: req.signal,
        headers: { 'User-Agent': cmsRequestHeaders()['User-Agent'] },
      });
      if (detailRes.ok) {
        const html = await detailRes.text();
        resolved = parseDetailPageHtml(html, source);
      }
    }
    }

    if (!resolved || resolved.episodes.length === 0) {
      return NextResponse.json({ error: '未找到播放资源' }, { status: 404 });
    }
    // TMDB is an optional metadata provider. Missing credentials, unmatched titles,
    // or upstream outages leave the CMS episode list and playback URLs untouched.
    resolved = await enrichEpisodesWithTmdbArtwork(resolved, {
      token: process.env.TMDB_READ_ACCESS_TOKEN,
      title: resolved.videoInfo.title,
      originalTitle: resolved.videoInfo.originalTitle,
      year: resolved.videoInfo.year,
    });
    setCache(cacheKey, resolved, DETAIL_CACHE_TTL);
    return NextResponse.json(resolved);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '获取详情失败' },
      { status: 502 }
    );
  }
}
