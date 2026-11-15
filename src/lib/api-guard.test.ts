import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE, signSession } from './auth';
import { guardPrivateFeatureRequest } from './api-guard';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('guardPrivateFeatureRequest', () => {
  it('does not require the website password in public preview when Collector credentials are absent', async () => {
    vi.stubEnv('AUTH_DISABLED', 'true');
    vi.stubEnv('PASSWORD', 'preview-password');
    vi.stubEnv('SCRAPLING_API_BASE', '');
    vi.stubEnv('SCRAPLING_API_TOKEN', '');

    const response = guardPrivateFeatureRequest(new Request('https://preview.example/api/resource-collector'));
    expect(response?.status).toBe(503);
    expect(response?.headers.get('Cache-Control')).toBe('no-store');
    await expect(response?.json()).resolves.toMatchObject({ code: 'COLLECTOR_NOT_CONFIGURED' });
  });

  it('requires a login session when normal authentication is enabled', () => {
    vi.stubEnv('AUTH_DISABLED', 'false');
    vi.stubEnv('PASSWORD', 'test-password');

    const response = guardPrivateFeatureRequest(new Request('https://app.example/api/resource-collector'));
    expect(response?.status).toBe(401);
  });

  it('allows a valid password-protected session', () => {
    vi.stubEnv('AUTH_DISABLED', 'false');
    vi.stubEnv('PASSWORD', 'test-password');
    const { token } = signSession();

    const response = guardPrivateFeatureRequest(new Request('https://app.example/api/resource-collector', {
      headers: { Cookie: `${SESSION_COOKIE}=${token}` },
    }));
    expect(response).toBeNull();
  });
  it('does not expose server-side Collector credentials through an unauthenticated public preview', async () => {
    vi.stubEnv('AUTH_DISABLED', 'true');
    vi.stubEnv('SCRAPLING_API_BASE', 'https://collector.example');
    vi.stubEnv('SCRAPLING_API_TOKEN', 'server-only-token');

    const response = guardPrivateFeatureRequest(new Request('https://preview.example/api/resource-collector'));
    expect(response?.status).toBe(503);
    await expect(response?.json()).resolves.toMatchObject({ code: 'COLLECTOR_NOT_CONFIGURED' });
  });

  it('allows only SeedHub read endpoints through a server-configured public Preview Collector', () => {
    vi.stubEnv('AUTH_DISABLED', 'true');
    vi.stubEnv('SCRAPLING_API_BASE', 'https://collector.example');
    vi.stubEnv('SCRAPLING_API_TOKEN', 'server-only-token');

    expect(guardPrivateFeatureRequest(new Request(
      'https://preview.example/api/resource-collector?action=seedhub-catalog&category=movies'
    ))).toBeNull();
    expect(guardPrivateFeatureRequest(new Request(
      'https://preview.example/api/resource-collector?action=seedhub-detail&url=https%3A%2F%2Fwww.seedhub.cc%2Fmovies%2F1%2F'
    ))).toBeNull();
    expect(guardPrivateFeatureRequest(new Request(
      'https://preview.example/api/resource-collector?action=jobs'
    ))?.status).toBe(503);
    expect(guardPrivateFeatureRequest(new Request(
      'https://preview.example/api/resource-collector',
      { method: 'POST' }
    ))?.status).toBe(503);
  });

  it('allows a public preview caller to provide its own browser-local Collector credentials', () => {
    vi.stubEnv('AUTH_DISABLED', 'true');
    vi.stubEnv('SCRAPLING_API_BASE', 'https://collector.example');
    vi.stubEnv('SCRAPLING_API_TOKEN', 'server-only-token');

    const response = guardPrivateFeatureRequest(new Request('https://preview.example/api/resource-collector', {
      headers: {
        'x-scrapling-api-base': 'https://my-collector.example',
        'x-scrapling-api-token': 'browser-local-token',
      },
    }));
    expect(response).toBeNull();
  });

});
