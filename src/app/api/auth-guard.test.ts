import { beforeEach, describe, expect, it } from 'vitest';
import { POST as legacyChatPost } from './ai-chat/route';
import { POST as cancelChatPost } from './chat/cancel/route';

function request(path: string, body: unknown): Request {
  return new Request(`https://local.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('legacy AI endpoints require a session', () => {
  beforeEach(() => {
    process.env.PASSWORD = 'test-password-123';
    delete process.env.PROXY_SECRET;
  });

  it('rejects unauthenticated legacy AI chat requests', async () => {
    const response = await legacyChatPost(request('/api/ai-chat', {
      messages: [{ role: 'user', content: 'hello' }],
    }) as never);
    expect(response.status).toBe(401);
  });

  it('rejects unauthenticated chat cancellation requests', async () => {
    const response = await cancelChatPost(request('/api/chat/cancel', {
      requestId: 'req_test_123',
    }) as never);
    expect(response.status).toBe(401);
  });

  it('treats malformed session cookies as unauthenticated instead of throwing', async () => {
    const response = await legacyChatPost(new Request('https://local.test/api/ai-chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: 'ltv_session=%E0%A4%A',
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
    }) as never);
    expect(response.status).toBe(401);
  });

  it('returns 503 when the server password is not configured', async () => {
    delete process.env.PASSWORD;
    const response = await legacyChatPost(request('/api/ai-chat', {
      messages: [{ role: 'user', content: 'hello' }],
    }) as never);
    expect(response.status).toBe(503);
  });
});
