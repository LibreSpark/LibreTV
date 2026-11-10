import { beforeEach, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
vi.mock('@/lib/api-guard', () => ({ guardRequest: vi.fn() }));
vi.mock('@/lib/ssrf', () => ({ checkUpstreamAllowed: vi.fn() }));
vi.mock('@/lib/catalog-core', async () => ({ ...await vi.importActual('@/lib/catalog-core'), loadCatalog: vi.fn() }));
import { guardRequest } from '@/lib/api-guard';
import { checkUpstreamAllowed } from '@/lib/ssrf';
import { loadCatalog } from '@/lib/catalog-core';
import { POST } from './route';
const req = (body: unknown) => new Request('https://example.com/api/catalog', { method: 'POST', body: JSON.stringify(body) });
const source = { key: 'movie', name: 'Movie', url: 'https://source.example/api' };
beforeEach(() => { vi.resetAllMocks(); vi.mocked(guardRequest).mockReturnValue(null); vi.mocked(checkUpstreamAllowed).mockResolvedValue({ ok: true }); vi.mocked(loadCatalog).mockResolvedValue({ items: [], categories: [], page: 1, nextPage: null, rawCount: 0 }); });
it('requires login before any catalog request', async () => { vi.mocked(guardRequest).mockReturnValue(NextResponse.json({}, { status: 401 })); expect((await POST(req({ source }))).status).toBe(401); expect(loadCatalog).not.toHaveBeenCalled(); });
it('rejects invalid pages and blocked upstreams before loading', async () => { expect((await POST(req({ source, page: -1 }))).status).toBe(400); vi.mocked(checkUpstreamAllowed).mockResolvedValue({ ok: false, reason: 'private target' }); expect((await POST(req({ source }))).status).toBe(400); expect(loadCatalog).not.toHaveBeenCalled(); });
it('preserves source-level content filtering', async () => { expect((await POST(req({ source: { ...source, isAdult: true } }))).status).toBe(403); expect(loadCatalog).not.toHaveBeenCalled(); });
it('passes validated category/page and marks responses private', async () => { const res = await POST(req({ source, category: '10', page: 2 })); expect(res.status).toBe(200); expect(loadCatalog).toHaveBeenCalledWith(source.url, 2, '10', expect.any(Function), expect.any(Function), ''); expect(res.headers.get('cache-control')).toBe('private, no-store'); });

it('validates and forwards source-catalog title queries', async () => { const res = await POST(req({ source, query: ' Inception ' })); expect(res.status).toBe(200); expect(loadCatalog).toHaveBeenCalledWith(source.url, 1, '', expect.any(Function), expect.any(Function), 'Inception'); expect((await POST(req({ source, query: 'x'.repeat(101) }))).status).toBe(400); });
