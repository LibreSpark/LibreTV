import { beforeEach, describe, expect, it } from 'vitest';
import { GET } from './status/route';
import { SESSION_COOKIE, signSession } from '@/lib/auth';

describe('GET /api/status configuration visibility', () => {
  beforeEach(() => {
    process.env.PASSWORD = 'test-password-123';
    process.env.DEFAULT_SOURCES = JSON.stringify([
      { name: 'Private CMS', url: 'https://cms.example/api.php?token=private' },
    ]);
    process.env.DEFAULT_LIVE_SOURCES = JSON.stringify([
      { name: 'Private IPTV', url: 'https://iptv.example/list.m3u?token=private' },
    ]);
    process.env.DEFAULT_SUBSCRIPTIONS = JSON.stringify([
      'https://subscriptions.example/sources.json?token=private',
    ]);
    delete process.env.PROXY_SECRET;
  });

  it('does not expose deployment source URLs to unauthenticated visitors', async () => {
    const response = await GET(new Request('https://local.test/api/status'));
    const data = await response.json() as {
      verified: boolean;
      defaultSources: unknown[];
      defaultLiveSources: unknown[];
      defaultSubscriptions: unknown[];
    };
    expect(data.verified).toBe(false);
    expect(data.defaultSources).toEqual([]);
    expect(data.defaultLiveSources).toEqual([]);
    expect(data.defaultSubscriptions).toEqual([]);
  });

  it('returns deployment defaults to an authenticated session', async () => {
    const { token } = signSession();
    const response = await GET(new Request('https://local.test/api/status', {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    }));
    const data = await response.json() as {
      verified: boolean;
      defaultSources: Array<{ name: string }>;
      defaultLiveSources: Array<{ name: string }>;
      defaultSubscriptions: Array<{ url: string }>;
    };
    expect(data.verified).toBe(true);
    expect(data.defaultSources[0]?.name).toBe('Private CMS');
    expect(data.defaultLiveSources[0]?.name).toBe('Private IPTV');
    expect(data.defaultSubscriptions[0]?.url).toContain('subscriptions.example');
  });
});
