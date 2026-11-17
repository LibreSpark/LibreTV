import { createHash, generateKeyPairSync, randomUUID, sign as signSignature } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signSession } from '@/lib/auth';
import { getVerifiedReviewerSubject } from '@/lib/reviewer-identity';

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('verified reviewer identity', () => {
  it('derives a stable reviewer fingerprint from a valid Access JWT', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const domain = `team-${randomUUID()}.cloudflareaccess.com`;
    const audience = 'test-audience';
    const subject = 'admin@example.com';
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
    const header = encode({ alg: 'RS256', kid: 'test-key', typ: 'JWT' });
    const payload = encode({
      aud: [audience],
      exp: Math.floor(Date.now() / 1000) + 300,
      iss: `https://${domain}`,
      sub: subject,
    });
    const signingInput = `${header}.${payload}`;
    const signature = signSignature('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url');
    const request = new Request('https://libretv.example/api/review', {
      headers: { 'cf-access-jwt-assertion': `${signingInput}.${signature}` },
    });
    vi.stubEnv('CF_ACCESS_TEAM_DOMAIN', domain);
    vi.stubEnv('CF_ACCESS_AUD', audience);
    vi.stubEnv('PASSWORD', '');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })));

    const expected = `cf-access-${createHash('sha256').update(subject).digest('hex').slice(0, 40)}`;
    expect(await getVerifiedReviewerSubject(request)).toBe(expected);
  });

  it('rejects a validly signed token with the wrong audience', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const domain = `team-${randomUUID()}.cloudflareaccess.com`;
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
    const header = encode({ alg: 'RS256', kid: 'test-key', typ: 'JWT' });
    const payload = encode({
      aud: ['wrong-audience'],
      exp: Math.floor(Date.now() / 1000) + 300,
      iss: `https://${domain}`,
      sub: 'admin@example.com',
    });
    const signingInput = `${header}.${payload}`;
    const signature = signSignature('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url');
    vi.stubEnv('CF_ACCESS_TEAM_DOMAIN', domain);
    vi.stubEnv('CF_ACCESS_AUD', 'expected-audience');
    vi.stubEnv('PASSWORD', '');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })));

    const request = new Request('https://libretv.example/api/review', {
      headers: { 'cf-access-jwt-assertion': `${signingInput}.${signature}` },
    });
    expect(await getVerifiedReviewerSubject(request)).toBeNull();
  });

  it('accepts only a valid signed password session when Access is not configured', async () => {
    vi.stubEnv('CF_ACCESS_TEAM_DOMAIN', '');
    vi.stubEnv('CF_ACCESS_AUD', '');
    vi.stubEnv('AUTH_DISABLED', 'false');
    vi.stubEnv('PASSWORD', 'test-password');
    const { token } = signSession();
    const request = new Request('https://libretv.example/api/review', {
      headers: { cookie: `ltv_session=${token}` },
    });

    expect(await getVerifiedReviewerSubject(request)).toBe('libretv-password-admin');
    expect(await getVerifiedReviewerSubject(new Request('https://libretv.example/api/review'))).toBeNull();
  });
});
