import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VideoDetail } from './types';
import { enrichEpisodesWithTmdbArtwork, parseEpisodeCoordinates } from './tmdb-episode-artwork';

function makeDetail(count = 24): VideoDetail {
  const episodeItems = Array.from({ length: count }, (_, index) => ({
    title: '第' + (index + 1) + '集',
    url: 'https://media.example.com/episode-' + (index + 1) + '.m3u8',
  }));
  return {
    episodes: episodeItems.map((item) => item.url),
    episodeItems,
    videoInfo: {
      title: '今天是太阳雨',
      year: '2026',
      sourceKey: 'custom_0',
      sourceName: '暴风资源',
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TMDB episode artwork matching', () => {
  it('matches all 24 episodes by explicit season and episode numbers, not array position', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/3/search/tv') {
        return Response.json({
          results: [{ id: 307853, name: '今天是太阳雨', original_name: 'Sunshine Through the Rain', first_air_date: '2026-01-01' }],
        });
      }
      if (url.pathname === '/3/tv/307853/season/1') {
        return Response.json({
          episodes: Array.from({ length: 24 }, (_, index) => ({
            id: 9000 + index,
            season_number: 1,
            episode_number: index + 1,
            still_path: '/still-' + (index + 1) + '.jpg',
          })).reverse(),
        });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichEpisodesWithTmdbArtwork(makeDetail(), {
      token: 'test-read-token',
      title: '今天是太阳雨',
      year: '2026',
    });

    expect(result.episodeItems).toHaveLength(24);
    for (let index = 0; index < 24; index += 1) {
      expect(result.episodeItems?.[index]).toMatchObject({
        title: '第' + (index + 1) + '集',
        image: 'https://image.tmdb.org/t/p/w780/still-' + (index + 1) + '.jpg',
        tmdbSeriesId: 307853,
        tmdbEpisodeId: 9000 + index,
        seasonNumber: 1,
        episodeNumber: index + 1,
        imageSource: 'tmdb',
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fills missing episode title, overview and runtime even when TMDB has no still image', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/3/search/tv') {
        return Response.json({
          results: [{ id: 307853, name: '今天是太阳雨', original_name: 'Sunshine Through the Rain', first_air_date: '2026-01-01' }],
        });
      }
      return Response.json({
        episodes: [{
          id: 9001,
          episode_number: 1,
          still_path: null,
          name: '試播集',
          overview: '普萊斯的運氣跌到谷底，而一次在練習場的偶遇，讓他決心把握住這個難得的機會。',
          runtime: 45,
        }],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichEpisodesWithTmdbArtwork(makeDetail(1), {
      token: 'test-read-token',
      title: '今天是太阳雨',
      year: '2026',
    });

    expect(result.episodeItems?.[0]).toMatchObject({
      episodeName: '試播集',
      description: '普萊斯的運氣跌到谷底，而一次在練習場的偶遇，讓他決心把握住這個難得的機會。',
      duration: '45分钟',
    });
    expect(result.episodeItems?.[0].image).toBeUndefined();
  });

  it('does not match a different title', async () => {
    const fetchMock = vi.fn(async () => Response.json({
      results: [{ id: 307853, name: '另一部剧', original_name: 'Another Show', first_air_date: '2026-01-01' }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichEpisodesWithTmdbArtwork(makeDetail(1), {
      token: 'test-read-token',
      title: '今天是太阳雨',
      year: '2026',
    });

    expect(result.episodeItems?.[0].image).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('matches an exact title when the CMS release year differs from the TMDB first-air year', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/3/search/tv') {
        return Response.json({
          results: [{ id: 307853, name: '今天是太阳雨', original_name: 'Sunshine Through the Rain', first_air_date: '2025-01-01' }],
        });
      }
      return Response.json({ episodes: [{ id: 9001, episode_number: 1, still_path: '/correct-still.jpg' }] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichEpisodesWithTmdbArtwork(makeDetail(1), {
      token: 'test-read-token',
      title: '今天是太阳雨',
      year: '2026',
    });

    expect(result.episodeItems?.[0]).toMatchObject({
      image: 'https://image.tmdb.org/t/p/w780/correct-still.jpg',
      tmdbSeriesId: 307853,
      episodeNumber: 1,
    });
    // One year-constrained search, one title-only fallback, and one season lookup.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('preserves source-provided episode stills instead of overwriting them', async () => {
    const detail = makeDetail(1);
    detail.episodeItems![0].image = 'https://source.example.com/episode-1.jpg';
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/3/search/tv') {
        return Response.json({
          results: [{ id: 307853, name: '今天是太阳雨', original_name: 'Sunshine Through the Rain', first_air_date: '2026-01-01' }],
        });
      }
      return Response.json({ episodes: [{ id: 1, episode_number: 1, still_path: '/tmdb.jpg' }] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichEpisodesWithTmdbArtwork(detail, {
      token: 'test-read-token',
      title: '今天是太阳雨',
      year: '2026',
    });
    expect(result.episodeItems?.[0].image).toBe('https://source.example.com/episode-1.jpg');
  });

  it('matches generic or blank CMS episode labels by position only when the season count matches exactly', async () => {
    const detail = makeDetail(16);
    detail.episodeItems = detail.episodeItems?.map((item, index) => ({
      ...item,
      title: index % 2 === 0 ? '' : '高清中字',
    }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/3/search/tv') {
        return Response.json({
          results: [{ id: 307853, name: '今天是太阳雨', original_name: 'Sunshine Through the Rain', first_air_date: '2026-01-01' }],
        });
      }
      return Response.json({
        episodes: Array.from({ length: 16 }, (_, index) => ({
          id: 9100 + index,
          episode_number: index + 1,
          still_path: '/matched-' + (index + 1) + '.jpg',
          name: '第' + (index + 1) + '集',
          runtime: 45,
        })),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichEpisodesWithTmdbArtwork(detail, {
      token: 'test-read-token',
      title: '今天是太阳雨',
      year: '2026',
    });

    expect(result.episodeItems).toHaveLength(16);
    for (let index = 0; index < 16; index += 1) {
      expect(result.episodeItems?.[index]).toMatchObject({
        image: 'https://image.tmdb.org/t/p/w780/matched-' + (index + 1) + '.jpg',
        episodeNumber: index + 1,
        imageSource: 'tmdb',
        episodeName: '第' + (index + 1) + '集',
        duration: '45分钟',
      });
    }
  });

  it('does nothing without credentials and keeps the playback data intact', async () => {
    const detail = makeDetail(2);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichEpisodesWithTmdbArtwork(detail, { title: '今天是太阳雨', year: '2026' });
    expect(result).toEqual(detail);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses strict season and episode coordinates from labels', () => {
    expect(parseEpisodeCoordinates('第十二集', '示例剧第二季')).toEqual({ seasonNumber: 2, episodeNumber: 12 });
    expect(parseEpisodeCoordinates('S02E03', '示例剧第二季')).toEqual({ seasonNumber: 2, episodeNumber: 3 });
    expect(parseEpisodeCoordinates('024', '示例剧')).toEqual({ seasonNumber: 1, episodeNumber: 24 });
    expect(parseEpisodeCoordinates('S01E03', '示例剧第二季')).toBeNull();
    expect(parseEpisodeCoordinates('特别篇', '示例剧')).toBeNull();
  });

  it('does not reuse a series backdrop when an exact episode still is unavailable', async () => {
    const detail = makeDetail(1);
    detail.videoInfo.cover = 'https://source.example.com/title-poster.jpg';
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/3/search/tv') {
        return Response.json({
          results: [{
            id: 307853,
            name: '今天是太阳雨',
            original_name: 'Sunshine Through the Rain',
            first_air_date: '2026-01-01',
            backdrop_path: '/series-backdrop.jpg',
          }],
        });
      }
      return Response.json({ episodes: [{ id: 1, episode_number: 1, still_path: null }] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichEpisodesWithTmdbArtwork(detail, {
      token: 'test-read-token',
      title: '今天是太阳雨',
      year: '2026',
    });
    expect(result.episodeItems?.[0].image).toBeUndefined();
    expect(result.episodeItems?.[0].image).not.toBe('https://image.tmdb.org/t/p/w1280/series-backdrop.jpg');
    expect(result.episodeItems?.[0].image).not.toBe(detail.videoInfo.cover);
  });

  it('adds the matched series backdrop at w1280 and strips leading slashes', async () => {
    const detail = makeDetail(1);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/3/search/tv') {
        return Response.json({
          results: [{
            id: 307853,
            name: '今天是太阳雨',
            original_name: 'Sunshine Through the Rain',
            first_air_date: '2026-01-01',
            backdrop_path: '///series-backdrop.jpg',
          }],
        });
      }
      return Response.json({ episodes: [{ id: 1, episode_number: 1, still_path: null }] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichEpisodesWithTmdbArtwork(detail, {
      token: 'test-read-token',
      title: '今天是太阳雨',
      year: '2026',
    });

    expect(result.videoInfo.backdrop).toBe('https://image.tmdb.org/t/p/w1280/series-backdrop.jpg');
    expect(result.episodeItems?.[0].image).toBeUndefined();
  });

  it('keeps CMS-provided stills and never falls back to the title poster', async () => {
    const detail = makeDetail(1);
    detail.videoInfo.cover = 'https://source.example.com/title-poster.jpg';
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/3/search/tv') {
        return Response.json({
          results: [{ id: 307853, name: '今天是太阳雨', original_name: 'Sunshine Through the Rain', first_air_date: '2026-01-01' }],
        });
      }
      return Response.json({ episodes: [{ id: 1, episode_number: 1, still_path: null }] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichEpisodesWithTmdbArtwork(detail, {
      token: 'test-read-token',
      title: '今天是太阳雨',
      year: '2026',
    });
    expect(result.episodeItems?.[0].image).toBeUndefined();
    expect(result.episodeItems?.[0].image).not.toBe(detail.videoInfo.cover);
  });
});
