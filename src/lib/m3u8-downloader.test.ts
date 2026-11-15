import { afterEach, describe, expect, it, vi } from 'vitest';
import { decryptSegment, PauseResumeController, runDirectDownloadJob, runDownloadJob, type DownloadJobOptions, type DownloadProgress } from './m3u8-downloader';
import { parseM3u8Playlist } from './m3u8-parse';

const KEY = crypto.getRandomValues(new Uint8Array(16));
const asBuf = (v: Uint8Array): BufferSource => v.buffer as ArrayBuffer;
const PLAINTEXT = crypto.getRandomValues(new Uint8Array(188 * 3));

async function encryptForIv(plaintext: BufferSource, iv: Uint8Array): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey('raw', asBuf(KEY), 'AES-CBC', false, ['encrypt']);
  return crypto.subtle.encrypt({ name: 'AES-CBC', iv: asBuf(iv) }, cryptoKey, plaintext);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('decryptSegment', () => {
  it('显式 IV：密文往返还原明文', async () => {
    const cipher = await encryptForIv(PLAINTEXT, new Uint8Array(16).fill(0xab));
    const out = await decryptSegment(cipher, asBuf(KEY), 'ab'.repeat(16), 0, 0);
    expect(new Uint8Array(out)).toEqual(PLAINTEXT);
  });

  it('无 IV 属性：IV = mediaSequence + 分片序号（16 字节大端），逐分片递增', async () => {
    // 分片 0（媒体序列号 5 → IV=5）与分片 1（IV=6）用各自正确的 IV 加密
    const ivOf = (seq: number) => {
      const iv = new Uint8Array(16);
      iv[15] = seq;
      return iv;
    };
    const cipher0 = await encryptForIv(PLAINTEXT, ivOf(5));
    const cipher1 = await encryptForIv(PLAINTEXT, ivOf(6));

    const out0 = await decryptSegment(cipher0, asBuf(KEY), undefined, 5, 0);
    expect(new Uint8Array(out0)).toEqual(PLAINTEXT);
    const out1 = await decryptSegment(cipher1, asBuf(KEY), undefined, 5, 1);
    expect(new Uint8Array(out1)).toEqual(PLAINTEXT);
  });

  it('回归：旧实现恒用零向量 IV——对非零序列号分片解密必然失败', async () => {
    // 分片按正确 IV=6 加密；旧实现对无 IV 属性的 KEY 恒用零向量 → 解不出明文
    const cipher = await encryptForIv(PLAINTEXT, ivOf6());
    const zeroIv = '00'.repeat(16);
    const out = await decryptSegment(cipher, asBuf(KEY), zeroIv, 5, 1).catch(
      () => new ArrayBuffer(0)
    );
    const same =
      out.byteLength === PLAINTEXT.byteLength &&
      new Uint8Array(out).every((b, i) => b === PLAINTEXT[i]);
    expect(same).toBe(false);
  });
});

function ivOf6(): Uint8Array {
  const iv = new Uint8Array(16);
  iv[15] = 6;
  return iv;
}

describe('parseM3u8Playlist · mediaSequence 与 AES URI 绝对化', () => {
  it('解析 EXT-X-MEDIA-SEQUENCE，AES key 相对地址转绝对', async () => {
    const playlist = [
      '#EXTM3U',
      '#EXT-X-MEDIA-SEQUENCE:15',
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
      '#EXTINF:4,',
      'seg0.ts',
      '#EXTINF:4,',
      'seg1.ts',
    ].join('\n');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(playlist, { status: 200 }))
    );

    const parsed = await parseM3u8Playlist('https://cdn.example.com/live/index.m3u8');
    expect(parsed.mediaSequence).toBe(15);
    expect(parsed.aesConf?.uri).toBe('https://cdn.example.com/live/key.bin');
    expect(parsed.segments).toHaveLength(2);
    expect(parsed.segments[0].url).toBe('https://cdn.example.com/live/seg0.ts');
  });

  it('缺省 MEDIA-SEQUENCE 时为 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('#EXTM3U\n#EXTINF:4,\nseg.ts', { status: 200 }))
    );
    const parsed = await parseM3u8Playlist('https://cdn.example.com/a.m3u8');
    expect(parsed.mediaSequence).toBe(0);
  });
});

const PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:6',
  '#EXT-X-PLAYLIST-TYPE:VOD',
  '#EXTINF:4,',
  's0.ts',
  '#EXTINF:4,',
  's1.ts',
  '#EXTINF:4,',
  's2.ts',
  '#EXT-X-ENDLIST',
].join('\n');

/** 极简 Cache Storage 替身：只实现 runDownloadJob 用到的 match/put/keys/delete */
function stubCaches(onPut?: () => Promise<void>): void {
  const store = new Map<string, ArrayBuffer>();
  const cache = {
    match: async (req: Request) => {
      const hit = store.get(req.url);
      return hit ? new Response(hit.slice(0)) : undefined;
    },
    put: async (req: Request, res: Response) => {
      if (onPut) {
        await onPut();
        return;
      }
      store.set(req.url, await res.arrayBuffer());
    },
    keys: async () => [...store.keys()].map((u) => new Request(u)),
    delete: async (req: Request) => store.delete(req.url),
  };
  vi.stubGlobal('caches', { open: async () => cache });
}

function jobOptions(overrides: Partial<DownloadJobOptions> = {}): DownloadJobOptions {
  return {
    taskId: 'task-1',
    url: 'https://cdn.example.com/index.m3u8',
    title: '测试剧集',
    format: 'TS',
    concurrency: 1,
    signal: new AbortController().signal,
    pause: new PauseResumeController(),
    onProgress: () => {},
    target: { kind: 'memory', write: async () => {}, close: async () => {}, abort: async () => {} },
    ...overrides,
  };
}


describe('runDirectDownloadJob · progressive media', () => {
  it('按真实响应流分块写入并报告字节进度', async () => {
    const chunks: number[] = [];
    const progress: DownloadProgress[] = [];
    const close = vi.fn(async () => {});
    const target = {
      kind: 'memory' as const,
      write: vi.fn(async (data: Uint8Array) => { chunks.push(data.byteLength); }),
      close,
      abort: vi.fn(async () => {}),
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5]));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {
      status: 200,
      headers: { 'content-type': 'video/mp4', 'content-length': '5' },
    })));
    await runDirectDownloadJob(jobOptions({
      url: 'https://cdn.example.com/episode.mp4',
      format: 'MP4',
      target,
      onProgress: (entry) => progress.push(entry),
    }));
    expect(chunks).toEqual([3, 2]);
    expect(close).toHaveBeenCalledOnce();
    expect(progress.at(-1)).toMatchObject({ current: 5, total: 5, status: 'done', percentage: 100 });
  });

  it('持续有数据的大文件下载超过 60 秒不会被固定总时限中断', async () => {
    vi.useFakeTimers();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(value) { controller = value; },
    });
    const written: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {
      headers: { 'content-type': 'video/mp4', 'content-length': '2' },
    })));
    const job = runDirectDownloadJob(jobOptions({
      url: 'https://cdn.example.com/long-feature.mp4',
      format: 'MP4',
      target: {
        kind: 'memory',
        write: async (chunk) => { written.push(chunk.byteLength); },
        close: async () => {},
        abort: async () => {},
      },
    }));

    await vi.advanceTimersByTimeAsync(59_000);
    controller.enqueue(new Uint8Array([1]));
    await vi.advanceTimersByTimeAsync(59_000);
    controller.enqueue(new Uint8Array([2]));
    controller.close();
    await job;

    expect(written).toEqual([1, 1]);
  });

  it('Content-Length 缺失时仍报告已接收字节，不伪造百分比', async () => {
    const progress: DownloadProgress[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'content-type': 'video/mp4' },
    })));
    await runDirectDownloadJob(jobOptions({
      url: 'https://cdn.example.com/episode.mp4',
      format: 'MP4',
      onProgress: (entry) => progress.push(entry),
    }));
    expect(progress.some((entry) => entry.current === 3 && entry.total === 0 && entry.status === 'downloading')).toBe(true);
    expect(progress.at(-1)).toMatchObject({ current: 3, total: 3, status: 'done', percentage: 100 });
  });

  it.each([403, 404])('HTTP %s 记录为下载失败', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status })));
    await expect(runDirectDownloadJob(jobOptions({
      url: 'https://cdn.example.com/episode.mp4',
      format: 'MP4',
    }))).rejects.toThrow(`视频源返回 HTTP ${status}`);
  });

  it('拒绝 HTML 错误页，不把它保存成视频', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>blocked</html>', {
      headers: { 'content-type': 'text/html' },
    })));
    await expect(runDirectDownloadJob(jobOptions({
      url: 'https://cdn.example.com/episode.mp4',
      format: 'MP4',
    }))).rejects.toThrow('来源返回的不是视频文件');
  });

  it('响应流网络中断时失败并清理 reader', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.error(new TypeError('network interrupted'));
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {
      headers: { 'content-type': 'video/mp4' },
    })));
    await expect(runDirectDownloadJob(jobOptions({
      url: 'https://cdn.example.com/episode.mp4',
      format: 'MP4',
    }))).rejects.toThrow('network interrupted');
  });
});

describe('runDownloadJob · 源站缺片与存储错误', () => {
  it('分片 404 视为确定性缺失：不重试、立即失败并提示换源', async () => {
    stubCaches();
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith('index.m3u8')) return new Response(PLAYLIST, { status: 200 });
        if (url.endsWith('s1.ts')) return new Response('', { status: 404 });
        return new Response(new Uint8Array([0x47, 0x40, 0x11, 0x10]), { status: 200 });
      })
    );

    const job = runDownloadJob(jobOptions());
    await expect(job).rejects.toThrow(/分片 2 源站缺失/);
    await expect(job).rejects.toThrow(/建议更换来源/);
    // 不重试：m3u8 一次 + s0 一次 + s1 一次（整集失败后 s2 不再请求）
    expect(calls.filter((u) => u.endsWith('.ts'))).toEqual([
      'https://cdn.example.com/s0.ts',
      'https://cdn.example.com/s1.ts',
    ]);
  });

  it('5xx 仍走退避重试，重试耗尽后才失败', async () => {
    stubCaches();
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('index.m3u8')) return new Response(PLAYLIST, { status: 200 });
      return new Response('', { status: 503 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const job = runDownloadJob(jobOptions());
    const assertion = expect(job).rejects.toThrow(/已重试 3 次/);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;

    const segCalls = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('.ts'));
    expect(segCalls).toHaveLength(3);
    vi.useRealTimers();
  });

  it('缓存写入失败（如配额不足）时给出可读提示', async () => {
    stubCaches(async () => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('index.m3u8')) return new Response(PLAYLIST, { status: 200 });
        return new Response(new Uint8Array([0x47]), { status: 200 });
      })
    );

    await expect(runDownloadJob(jobOptions())).rejects.toThrow(/存储空间可能不足/);
  });

  it('环境无 Cache Storage（HTTP 访问 / 老浏览器）：退化为串行边下边写而非直接失败', async () => {
    // 不提供 caches：等价于非安全上下文。旧行为是抛「不支持浏览器缓存」，
    // 现改为串行下载 + 立即写出（无断点、并发 1），功能仍可用
    vi.stubGlobal('caches', undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('index.m3u8')) return new Response(PLAYLIST, { status: 200 });
        return new Response(new Uint8Array([0x47]), { status: 200 });
      })
    );
    const written: number[] = [];
    const progress: DownloadProgress[] = [];

    await runDownloadJob(
      jobOptions({
        target: {
          kind: 'memory',
          write: async (d) => void written.push(d.byteLength),
          close: async () => {},
          abort: async () => {},
        },
        onProgress: (p) => progress.push(p),
      })
    );

    expect(written).toHaveLength(3);
    expect(progress.at(-1)?.status).toBe('done');
  });

  it('proxy 开启：m3u8 经 /api/proxy 拉取（直连被 CORS / 混合内容拦下时的兜底）', async () => {
    stubCaches();
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.startsWith('/api/proxy?')) return new Response(PLAYLIST, { status: 200 });
        return new Response(new Uint8Array([0x47]), { status: 200 });
      })
    );

    await runDownloadJob(jobOptions({ proxy: true }));

    expect(calls[0]).toBe(`/api/proxy?url=${encodeURIComponent('https://cdn.example.com/index.m3u8')}`);
    expect(calls).not.toContain('https://cdn.example.com/index.m3u8');
  });

  it('跨域或域名不可达导致的 Failed to fetch 翻译成「建议更换来源」', async () => {
    stubCaches();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );

    await expect(runDownloadJob(jobOptions())).rejects.toThrow(
      /无法直连该来源（跨域限制或域名不可达），建议更换来源/
    );
  });

  it('HTTPS 页面遇到 http 来源时提示混合内容被拦截', async () => {
    stubCaches();
    vi.stubGlobal('location', { protocol: 'https:' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );

    await expect(runDownloadJob(jobOptions({ url: 'http://cdn.example.com/index.m3u8' }))).rejects.toThrow(
      /混合内容被拦截/
    );
  });
});


describe('runDownloadJob · fMP4 初始化段与 AES Key 校验', () => {
  it('按 init.mp4 → m4s 分片顺序输出原生 fragmented MP4', async () => {
    stubCaches();
    const init = new Uint8Array([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70]);
    const fragment = new Uint8Array([0, 0, 0, 8, 0x6d, 0x6f, 0x6f, 0x66]);
    const playlist = ['#EXTM3U', '#EXT-X-MAP:URI="init.mp4"', '#EXTINF:4,', 'seg-1.m4s', '#EXT-X-ENDLIST'].join('\n');
    const written: number[][] = [];
    const progress: DownloadProgress[] = [];
    let closed = false;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('index.m3u8')) return new Response(playlist);
      if (url.endsWith('init.mp4')) return new Response(init);
      if (url.endsWith('seg-1.m4s')) return new Response(fragment);
      return new Response('', { status: 404 });
    }));

    await runDownloadJob(jobOptions({
      format: 'MP4',
      target: {
        kind: 'memory',
        write: async (data) => { written.push(Array.from(data)); },
        close: async () => { closed = true; },
        abort: async () => {},
      },
      onProgress: (entry) => progress.push(entry),
    }));

    expect(written).toEqual([Array.from(init), Array.from(fragment)]);
    expect(closed).toBe(true);
    expect(progress.map((entry) => entry.status)).toEqual(expect.arrayContaining(['validating', 'downloading', 'merging', 'done']));
  });

  it('AES-128 Key 必须恰好为 16 字节', async () => {
    stubCaches();
    const playlist = ['#EXTM3U', '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"', '#EXTINF:4,', 'seg.ts'].join('\n');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('index.m3u8')) return new Response(playlist);
      if (url.endsWith('key.bin')) return new Response(new Uint8Array(15));
      return new Response(new Uint8Array([0x47]));
    }));
    await expect(runDownloadJob(jobOptions())).rejects.toThrow('AES-128 密钥长度异常');
  });

  it('AES-128 Key 请求超时返回明确失败原因', async () => {
    stubCaches();
    const playlist = ['#EXTM3U', '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"', '#EXTINF:4,', 'seg.ts'].join('\n');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('index.m3u8')) return new Response(playlist);
      if (url.endsWith('key.bin')) throw new DOMException('The operation timed out', 'TimeoutError');
      return new Response(new Uint8Array([0x47]));
    }));
    await expect(runDownloadJob(jobOptions())).rejects.toThrow('解密密钥请求超时');
  });
});
