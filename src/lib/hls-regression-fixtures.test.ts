import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseM3u8Playlist, pickVariant, inferHeightFromBitrate } from './m3u8-parse';
import { rewriteM3u8 } from './m3u8';

const ORIGIN = 'https://media.example.test';
const MASTER = [
  '#EXTM3U',
  '#EXT-X-VERSION:6',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",DEFAULT=YES,AUTOSELECT=YES,URI="audio/en.m3u8"',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",DEFAULT=NO,AUTOSELECT=YES,URI="subs/en.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aud",SUBTITLES="subs"',
  'variant/720.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=5200000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="aud",SUBTITLES="subs"',
  'variant/1080.m3u8',
].join('\n');

const MEDIA_TS = [
  '#EXTM3U',
  '#EXT-X-TARGETDURATION:6',
  '#EXT-X-MEDIA-SEQUENCE:42',
  '#EXT-X-KEY:METHOD=AES-128,URI="../keys/live.key",IV=0x0000000000000000000000000000002a',
  '#EXTINF:6.0,',
  'seg-42.ts',
  '#EXTINF:6.0,',
  'seg-43.ts',
  '#EXT-X-ENDLIST',
].join('\n');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('HLS fixture regression matrix', () => {
  it('解析 Master 多档 Variant，并按用户偏好选择最接近档位', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(MASTER))
      .mockResolvedValueOnce(new Response(MEDIA_TS));
    vi.stubGlobal('fetch', fetchMock);

    const parsed = await parseM3u8Playlist(`${ORIGIN}/master.m3u8`, 0, 720);
    expect(parsed.variants).toHaveLength(2);
    expect(parsed.variants?.map((item) => item.height)).toEqual([720, 1080]);
    expect(parsed.segments.map((item) => item.url)).toEqual([
      `${ORIGIN}/variant/seg-42.ts`,
      `${ORIGIN}/variant/seg-43.ts`,
    ]);
    expect(fetchMock).toHaveBeenNthCalledWith(2, `${ORIGIN}/variant/720.m3u8`, expect.any(Object));
  });

  it('解析 TS 分片、媒体序列号与 AES-128 密钥引用', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(MEDIA_TS)));
    const parsed = await parseM3u8Playlist(`${ORIGIN}/variant/index.m3u8`);

    expect(parsed.mediaSequence).toBe(42);
    expect(parsed.totalDuration).toBe(12);
    expect(parsed.aesConf).toEqual({
      method: 'AES-128',
      uri: `${ORIGIN}/keys/live.key`,
      iv: '0000000000000000000000000000002a',
    });
    expect(parsed.segments[0].url).toBe(`${ORIGIN}/variant/seg-42.ts`);
  });

  it('重写音轨、字幕、Variant、AES Key、TS 与 fMP4 初始化段 URI', () => {
    const input = [
      MASTER,
      '#EXT-X-KEY:METHOD=AES-128,URI="../keys/live.key"',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXTINF:6,',
      'segment.m4s',
    ].join('\n');
    const output = rewriteM3u8(input, `${ORIGIN}/hls/master.m3u8`, 0, '/api/live/stream?url=');

    for (const uri of [
      `${ORIGIN}/hls/audio/en.m3u8`,
      `${ORIGIN}/hls/subs/en.m3u8`,
      `${ORIGIN}/hls/variant/720.m3u8`,
      `${ORIGIN}/keys/live.key`,
      `${ORIGIN}/hls/init.mp4`,
      `${ORIGIN}/hls/segment.m4s`,
    ]) {
      expect(output).toContain(encodeURIComponent(uri));
    }
  });

  it('解析 fMP4 初始化段与相对媒体分片 URI', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response([
      '#EXTM3U',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXTINF:4,',
      'segment.m4s',
      '#EXT-X-ENDLIST',
    ].join('\n'))));

    const parsed = await parseM3u8Playlist(`${ORIGIN}/fmp4/index.m3u8`);
    expect(parsed.initSegment).toBe(`${ORIGIN}/fmp4/init.mp4`);
    expect(parsed.segments.map((segment) => segment.url)).toEqual([`${ORIGIN}/fmp4/segment.m4s`]);
  });

  it('拒绝缺少 URI 或使用 BYTERANGE 的 fMP4 初始化段', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response([
      '#EXTM3U',
      '#EXT-X-MAP:BYTERANGE="100@0"',
      '#EXTINF:4,',
      'segment.m4s',
    ].join('\n'))));
    await expect(parseM3u8Playlist(`${ORIGIN}/fmp4/no-uri.m3u8`))
      .rejects.toThrow('缺少初始化分段 URI');

    vi.stubGlobal('fetch', vi.fn(async () => new Response([
      '#EXTM3U',
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="100@0"',
      '#EXTINF:4,',
      'segment.m4s',
    ].join('\n'))));
    await expect(parseM3u8Playlist(`${ORIGIN}/fmp4/range.m3u8`))
      .rejects.toThrow('初始化分段 BYTERANGE 暂不支持');
  });

  it('允许首个媒体分片前重置 METHOD=NONE 并启用单一 AES-128 Key', async () => {
    const playlist = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=NONE',
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
      '#EXTINF:4,',
      'segment.ts',
    ].join('\n');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(playlist)));
    const parsed = await parseM3u8Playlist(ORIGIN + '/encryption-state/index.m3u8');
    expect(parsed.aesConf).toEqual({ method: 'AES-128', uri: ORIGIN + '/encryption-state/key.bin' });
  });

  it('拒绝媒体分片开始后的 AES Key 轮换或 METHOD=NONE 切换', async () => {
    const keyRotation = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=AES-128,URI="key-a.bin"',
      '#EXTINF:4,',
      'segment-1.ts',
      '#EXT-X-KEY:METHOD=AES-128,URI="key-b.bin"',
      '#EXTINF:4,',
      'segment-2.ts',
    ].join('\n');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(keyRotation)));
    await expect(parseM3u8Playlist(ORIGIN + '/rotation/index.m3u8'))
      .rejects.toThrow('暂不支持 HLS 分片级密钥轮换或加密状态切换');

    const clearSwitch = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
      '#EXTINF:4,',
      'encrypted.ts',
      '#EXT-X-KEY:METHOD=NONE',
      '#EXTINF:4,',
      'clear.ts',
    ].join('\n');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(clearSwitch)));
    await expect(parseM3u8Playlist(ORIGIN + '/mixed/index.m3u8'))
      .rejects.toThrow('暂不支持 HLS 分片级密钥轮换或加密状态切换');
  });

  it('明确拒绝 SAMPLE-AES DRM/加密变体', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response([
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="sample.key"',
      '#EXTINF:4,',
      'segment.ts',
    ].join('\n'))));

    await expect(parseM3u8Playlist(`${ORIGIN}/sample-aes/index.m3u8`))
      .rejects.toThrow('暂不支持 HLS 加密方式：SAMPLE-AES');
  });

  it('分片清单 HTTP 404 明确失败', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
    await expect(parseM3u8Playlist(`${ORIGIN}/expired/index.m3u8`))
      .rejects.toThrow('m3u8 拉取失败：HTTP 404');
  });

  it('上游超时/连接中断时向调用方传播失败，不返回空成功清单', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new DOMException('The operation timed out', 'TimeoutError');
    }));
    await expect(parseM3u8Playlist(`${ORIGIN}/timeout/index.m3u8`))
      .rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('码率缺少 RESOLUTION 时使用明确的高度估算，并按档位选取', () => {
    expect(inferHeightFromBitrate(5_200_000)).toBe(1080);
    expect(inferHeightFromBitrate(1_900_000)).toBe(540);
    const variants = [
      { url: 'low.m3u8', height: 480, bandwidth: 800_000 },
      { url: 'mid.m3u8', height: 720, bandwidth: 2_800_000 },
      { url: 'high.m3u8', height: 1080, bandwidth: 5_200_000 },
    ];
    expect(pickVariant(variants, 720).url).toBe('mid.m3u8');
    expect(pickVariant(variants).url).toBe('high.m3u8');
  });
});
