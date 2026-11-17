import { describe, expect, it } from 'vitest';
import { mergeRegistryPayloads } from './registry-merge';

describe('mergeRegistryPayloads', () => {
  it('merges both registries and deduplicates by ID and URL', () => {
    const result = mergeRegistryPayloads([
      {
        resources: [{ id: 'old-1', url: 'https://example.com/a' }],
        queued: [{ id: 'queued-1', url: 'https://example.com/b' }],
      },
      {
        resources: [
          { id: 'old-1', url: 'https://example.com/a' },
          { id: 'new-1', url: 'https://example.com/c' },
          { url: 'https://example.com/a' },
        ],
        queued: [{ id: 'queued-1', url: 'https://example.com/b' }],
      },
    ]);

    expect(result.count).toBe(2);
    expect(result.resources).toHaveLength(2);
    expect(result.queued).toHaveLength(1);
  });

  it('ignores malformed payloads', () => {
    expect(mergeRegistryPayloads([null, [], { resources: 'invalid' }])).toMatchObject({
      count: 0,
      resources: [],
      queued: [],
    });
  });
});
