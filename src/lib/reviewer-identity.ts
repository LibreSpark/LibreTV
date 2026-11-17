import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { isPasswordConfigured, sessionFromCookieHeader } from '@/lib/auth';

type AccessClaims = {
  aud?: string | string[];
  exp?: number;
  iss?: string;
  nbf?: number;
  sub?: string;
};

type AccessJwk = {
  kid?: string;
  kty?: string;
  [key: string]: unknown;
};

type KeyCache = { expiresAt: number; keys: AccessJwk[] };

const keyCache = new Map<string, KeyCache>();

function decodePart(value: string): Buffer | null {
  try {
    return Buffer.from(value, 'base64url');
  } catch {
    return null;
  }
}

function normalizeTeamDomain(value: string): string | null {
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.pathname !== '/' || !url.hostname.toLowerCase().endsWith('.cloudflareaccess.com') ||
      url.port) return null;
    return url.host.toLowerCase();
  } catch {
    return null;
  }
}

async function accessKeys(domain: string): Promise<AccessJwk[]> {
  const cached = keyCache.get(domain);
  if (cached && cached.expiresAt > Date.now()) return cached.keys;
  const response = await fetch(`https://${domain}/cdn-cgi/access/certs`, {
    headers: { Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(5_000),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('OIDC key service returned an error');
  const data = await response.json() as { keys?: AccessJwk[] };
  if (!Array.isArray(data.keys)) throw new Error('OIDC key set is invalid');
  keyCache.set(domain, { keys: data.keys, expiresAt: Date.now() + 10 * 60_000 });
  return data.keys;
}

async function cloudflareAccessSubject(request: Request, domain: string, audience: string): Promise<string | null> {
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token || token.length > 8_192) return null;
  const [encodedHeader, encodedClaims, encodedSignature, ...extra] = token.split('.');
  if (!encodedHeader || !encodedClaims || !encodedSignature || extra.length) return null;
  const headerBytes = decodePart(encodedHeader);
  const claimsBytes = decodePart(encodedClaims);
  const signature = decodePart(encodedSignature);
  if (!headerBytes || !claimsBytes || !signature) return null;
  try {
    const header = JSON.parse(headerBytes.toString('utf8')) as { alg?: string; kid?: string };
    const claims = JSON.parse(claimsBytes.toString('utf8')) as AccessClaims;
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;
    const jwk = (await accessKeys(domain)).find((key) => key.kid === header.kid && key.kty === 'RSA');
    if (!jwk) return null;
    const validSignature = verifySignature(
      'RSA-SHA256',
      Buffer.from(`${encodedHeader}.${encodedClaims}`),
      createPublicKey({ key: jwk, format: 'jwk' }),
      signature,
    );
    const now = Math.floor(Date.now() / 1000);
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!validSignature || claims.iss !== `https://${domain}` || !audiences.includes(audience)) return null;
    if (typeof claims.sub !== 'string' || claims.sub.length < 1 || claims.sub.length > 255) return null;
    if (typeof claims.exp !== 'number' || claims.exp <= now) return null;
    if (typeof claims.nbf === 'number' && claims.nbf > now + 30) return null;
    return claims.sub;
  } catch {
    return null;
  }
}

export async function getVerifiedReviewerSubject(request: Request): Promise<string | null> {
  const configuredDomain = process.env.CF_ACCESS_TEAM_DOMAIN?.trim() ?? '';
  const configuredAudience = process.env.CF_ACCESS_AUD?.trim() ?? '';
  if (configuredDomain || configuredAudience) {
    const domain = normalizeTeamDomain(configuredDomain);
    if (!domain || !configuredAudience) return null;
    const subject = await cloudflareAccessSubject(request, domain, configuredAudience);
    if (!subject) return null;
    const fingerprint = createHash('sha256').update(subject).digest('hex').slice(0, 40);
    return `cf-access-${fingerprint}`;
  }
  if (!isPasswordConfigured() || !sessionFromCookieHeader(request.headers.get('cookie'))) return null;
  return 'libretv-password-admin';
}
