import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './client-api';
import type { SourceConfig } from './types';

const sources = Array.from({ length: 28 }, (_, i) => ({
  key: `source_${i}`, name: `source_${i}`, url: `https://source_${i}.example/api`,
}));

afterEach(() => vi.unstubAllGlobals());

describe('Workers 分批搜索', () => {
  it.each([true, false])('尝试搜索全部 28 个源，分批不丢结果 (stream=%s)', async (stream) => {
    let inFlight = 0;
    let peak = 0;
    const requested: string[] = [];
    const onSource = vi.fn();
    const fetchMock = vi.fn(async (_input: string, init: RequestInit) => {
      const { sources: batch } = JSON.parse(String(init.body)) as { sources: SourceConfig[] };
      if (batch.length > 2) return new Response(null, { status: 413 });
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight--;
      requested.push(...batch.map(({ key }) => key));
      const list = batch.map(({ key, name }) => ({
        sourceKey: key, sourceName: name, vodId: '1', name: key === 'source_27' ? '测试' : '测试外传',
      }));
      if (!stream) return Response.json({ list, failures: [] });
      return new Response(batch.map(({ key }, i) =>
        JSON.stringify({ type: 'source', sourceKey: key, ok: true, list: [list[i]] })
      ).concat(JSON.stringify({ type: 'done', list, failures: [] })).join('\n') + '\n');
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await api.search('测试', sources, true, stream ? { onSource } : undefined);
    expect(peak).toBe(4);
    expect(fetchMock).toHaveBeenCalledTimes(15);
    expect(requested.sort()).toEqual(sources.map(({ key }) => key).sort());
    expect(result.list).toHaveLength(28);
    expect(result.list[0].sourceKey).toBe('source_27');
    expect(result.failures).toEqual([]);
    expect(onSource).toHaveBeenCalledTimes(stream ? 28 : 0);
  });

  it('批次传输失败不冒充源站失败，其他批次继续返回', async () => {
    const onSource = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (_input: string, init: RequestInit) => {
      const { sources: batch } = JSON.parse(String(init.body)) as { sources: SourceConfig[] };
      if (batch.length > 2) return new Response(null, { status: 413 });
      if (batch.length === 2) return new Response(null, { status: 502 });
      return new Response(`{"type":"source","sourceKey":"source_2","ok":true,"list":[]}\n{"type":"done","list":[],"failures":[]}\n`);
    }));
    const result = await api.search('测试', sources.slice(0, 3), true, { onSource });
    expect(result.failures.map((failure) => failure.sourceKey)).toEqual(['source_0', 'source_1']);
    expect(onSource).toHaveBeenCalledOnce();
    expect(onSource).toHaveBeenCalledWith(expect.objectContaining({ sourceKey: 'source_2', ok: true }));
  });
});
