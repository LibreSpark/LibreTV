import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from './route';
import { SESSION_COOKIE, signSession } from '@/lib/auth';

vi.mock('node:dns/promises', () => ({
  resolve4: async () => ['93.184.216.34'],
  resolve6: async () => {
    throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
  },
}));

const PASSWORD = 'detail-route-test-password';

function makeRequest(options: {
  id?: string;
  source?: unknown;
  cookie?: boolean;
  rawSource?: string;
} = {}): NextRequest {
  const params = new URLSearchParams();
  if (options.id !== undefined) params.set('id', options.id);
  if (options.rawSource !== undefined) params.set('source', options.rawSource);
  else if (options.source !== undefined) params.set('source', JSON.stringify(options.source));
  const headers = new Headers();
  if (options.cookie !== false) {
    const { token } = signSession();
    headers.set('cookie', SESSION_COOKIE + '=' + token);
  }
  return new NextRequest('https://local.test/api/detail?' + params.toString(), { headers });
}

function source(url: string, key = 'detail-test') {
  return { key, name: '测试源', url };
}

function cmsDetail(playUrl: string) {
  return {
    code: 1,
    list: [{
      vod_id: 'movie-1',
      vod_name: '测试影片',
      vod_pic: 'https://img.example.com/poster.jpg',
      vod_content: '影片简介',
      vod_play_url: playUrl,
    }],
  };
}

describe('GET /api/detail', () => {
  beforeEach(() => {
    process.env.PASSWORD = PASSWORD;
    delete process.env.PROXY_SECRET;
    delete process.env.AUTH_DISABLED;
    delete process.env.TMDB_READ_ACCESS_TOKEN;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns 401 without a valid session and 503 when no password is configured', async () => {
    const unauthenticated = await GET(makeRequest({ id: 'movie-1', source: source('https://auth-detail.example/api.php'), cookie: false }));
    expect(unauthenticated.status).toBe(401);

    delete process.env.PASSWORD;
    const unconfigured = await GET(makeRequest({ id: 'movie-1', source: source('https://no-password-detail.example/api.php') }));
    expect(unconfigured.status).toBe(503);
  });

  it('rejects invalid IDs and malformed source configuration before fetching upstream', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const invalidId = await GET(makeRequest({ id: '../private', source: source('https://invalid-id-detail.example/api.php') }));
    expect(invalidId.status).toBe(400);
    expect(await invalidId.json()).toMatchObject({ error: '无效的视频ID' });

    const invalidSource = await GET(makeRequest({ id: 'movie-1', rawSource: '{bad-json' }));
    expect(invalidSource.status).toBe(400);
    expect(await invalidSource.json()).toMatchObject({ error: '无效的点播源配置' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('blocks private-network source URLs before making an upstream request', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const response = await GET(makeRequest({
      id: 'movie-1',
      source: source('http://192.168.1.100/api.php', 'private-detail'),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('允许范围') });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('blocks a private explicit detail-page origin after the public CMS list fallback', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(cmsDetail('')), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const response = await GET(makeRequest({
      id: 'movie-private-detail',
      source: {
        ...source('https://cms-detail-root.example/api.php', 'private-detail-root'),
        detail: 'http://127.0.0.1:8080/internal',
      },
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('允许范围') });
    // The public CMS list may be queried, but the private detail-page origin must never be fetched.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('parses KKPhim REST detail and only returns DNS-validated direct HLS episodes', async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('https://phimapi.com/phim/kkphim-test-title');
      return new Response(JSON.stringify({
        movie: {
          slug: 'kkphim-test-title',
          name: 'KKPhim 测试影片',
          origin_name: 'Test Movie',
          poster_url: 'https://images.example.com/poster.jpg',
          content: '<p>测试简介</p>',
          type: 'series',
          year: 2026,
          quality: 'FHD',
          lang: 'Vietsub',
          episode_current: '第 2 集',
          country: [{ name: '越南' }],
          actor: ['演员甲'],
          director: ['导演乙'],
        },
        episodes: [{
          server_name: 'Vietsub',
          server_data: [
            { name: '第 1 集', link_m3u8: 'https://media.example.com/ep1/index.m3u8' },
            { name: '第 2 集', link_m3u8: 'https://media.example.com/ep2/index.m3u8' },
          ],
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const response = await GET(makeRequest({
      id: 'kkphim-test-title',
      source: source('https://phimapi.com', 'kkphim'),
    }));

    expect(response.status).toBe(200);
    const data = await response.json() as {
      episodes: string[];
      episodeItems: Array<{ title: string; url: string }>;
      videoInfo: { title?: string; originalTitle?: string; typeName?: string; year?: string; remarks?: string };
    };
    expect(data.episodes).toEqual([
      'https://media.example.com/ep1/index.m3u8',
      'https://media.example.com/ep2/index.m3u8',
    ]);
    expect(data.episodeItems[0]).toMatchObject({ title: '第 1 集', url: 'https://media.example.com/ep1/index.m3u8' });
    expect(data.videoInfo).toMatchObject({
      title: 'KKPhim 测试影片',
      originalTitle: 'Test Movie',
      typeName: '电视剧',
      year: '2026',
      remarks: 'FHD · Vietsub · 第 2 集',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects a spoofed KKPhim host before requesting details', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const response = await GET(makeRequest({
      id: 'kkphim-test-title',
      source: source('https://phimapi.com.attacker.example', 'kkphim'),
    }));
    expect(response.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns parsed episode details from the CMS list endpoint', async () => {
    const fetchSpy = vi.fn(async () => new Response(
      JSON.stringify(cmsDetail('第1集$https://media.example.com/episode-1.m3u8')),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchSpy);

    const response = await GET(makeRequest({
      id: 'movie-1',
      source: source('https://cms-detail-success.example/api.php', 'detail-success'),
    }));

    expect(response.status).toBe(200);
    const data = await response.json() as { episodes: string[]; videoInfo: { title?: string } };
    expect(data.episodes).toEqual(['https://media.example.com/episode-1.m3u8']);
    expect(data.videoInfo.title).toBe('测试影片');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('uses the documented JSON ac=detail action for BaoFeng API sources', async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain('?ac=detail&ids=171637');
      expect(url).not.toContain('ac=videolist');
      return new Response(JSON.stringify({
        code: 1,
        list: [{
          vod_id: '171637',
          vod_name: '今天是太阳雨',
          vod_year: '2026',
          vod_play_url: '第1集$https://media.example.com/episode-1.m3u8',
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const response = await GET(makeRequest({
      id: '171637',
      source: source('https://bfzyapi.com/api.php/provide/vod/', 'storm-source'),
    }));

    expect(response.status).toBe(200);
    const data = await response.json() as { episodes: string[]; videoInfo: { title?: string } };
    expect(data.episodes).toEqual(['https://media.example.com/episode-1.m3u8']);
    expect(data.videoInfo.title).toBe('今天是太阳雨');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not attach playable episodes from a different CMS vod_id', async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('ac=videolist')) {
        // The CMS ignores ids=movie-requested and returns movie-1 with playable media.
        return new Response(JSON.stringify(cmsDetail('第1集$https://media.example.com/wrong-movie.m3u8')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('<html><h1>未匹配到请求影片</h1></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const response = await GET(makeRequest({
      id: 'movie-requested',
      source: source('https://cms-detail-mismatch.example/api.php', 'detail-mismatch'),
    }));

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: '未找到播放资源' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('falls back to the detail HTML page when the CMS list has no playable episodes', async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('ac=videolist')) {
        return new Response(JSON.stringify(cmsDetail('')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        '<html><h1>HTML 回退影片</h1><script>var play = "$https://media.example.com/fallback.m3u8";</script></html>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);

    const response = await GET(makeRequest({
      id: 'movie-2',
      source: source('https://cms-detail-fallback.example/api.php', 'detail-fallback'),
    }));

    expect(response.status).toBe(200);
    const data = await response.json() as { episodes: string[]; videoInfo: { title?: string } };
    expect(data.episodes).toEqual(['https://media.example.com/fallback.m3u8']);
    expect(data.videoInfo.title).toBe('HTML 回退影片');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('returns 404 when neither the list endpoint nor detail HTML contains playable resources', async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('ac=videolist')) {
        return new Response(JSON.stringify(cmsDetail('')), { status: 200 });
      }
      return new Response('<html><h1>没有播放地址</h1></html>', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const response = await GET(makeRequest({
      id: 'movie-3',
      source: source('https://cms-detail-empty.example/api.php', 'detail-empty'),
    }));

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: '未找到播放资源' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('returns 502 when the upstream request fails unexpectedly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('upstream connection failed');
    }));

    const response = await GET(makeRequest({
      id: 'movie-4',
      source: source('https://cms-detail-error.example/api.php', 'detail-error'),
    }));

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: 'upstream connection failed' });
  });
});
