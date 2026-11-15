#!/usr/bin/env node
/**
 * External HLS smoke test. Checks live HTTP resources and playlist structure only;
 * it does not claim browser decoding or real playback.
 */
const streams = {
  appleFmp4: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8',
  muxAes128: 'https://test-streams.mux.dev/dai-discontinuity-deltatre/manifest.m3u8',
  unifiedLive: 'https://demo.unified-streaming.com/k8s/live/stable/live.isml/.m3u8',
};

const timeoutMs = 10000;
const report = [];
const fail = (name, message) => { report.push({ name, ok: false, message }); };
const pass = (name, message) => { report.push({ name, ok: true, message }); };

async function get(url, range = false) {
  const headers = range ? { Range: 'bytes=0-1' } : {};
  let lastStatus = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) return response;
    lastStatus = response.status;
    await response.body?.cancel().catch(() => {});
    if (response.status < 500 || attempt === 2) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
  }
  throw new Error(`HTTP ${lastStatus} for ${url} after retries`);
}
async function playlist(url) {
  const response = await get(url);
  const text = await response.text();
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error(`Invalid HLS manifest: ${url}`);
  return { text, finalUrl: response.url || url };
}
function uriAttrs(line) {
  return [...line.matchAll(/URI="([^"]+)"/g)].map((m) => m[1]);
}
function absolute(uri, base) { return new URL(uri, base).href; }
function firstMediaUri(text, base) {
  return text.split(/\r?\n/).map((line) => line.trim())
    .find((line) => line && !line.startsWith('#'))
    ? absolute(text.split(/\r?\n/).map((line) => line.trim())
      .find((line) => line && !line.startsWith('#')), base)
    : undefined;
}
async function resolveMedia(url) {
  let current = await playlist(url);
  for (let depth = 0; depth < 4 && current.text.includes('#EXT-X-STREAM-INF'); depth++) {
    const lines = current.text.split(/\r?\n/);
    const idx = lines.findIndex((line) => line.startsWith('#EXT-X-STREAM-INF'));
    const variant = lines.slice(idx + 1).map((line) => line.trim()).find((line) => line && !line.startsWith('#'));
    if (!variant) throw new Error('Master has no Variant URI');
    current = await playlist(absolute(variant, current.finalUrl));
  }
  return current;
}
async function verifyApple() {
  const master = await playlist(streams.appleFmp4);
  if (!master.text.includes('#EXT-X-STREAM-INF')) throw new Error('Apple master has no variants');
  const media = await resolveMedia(streams.appleFmp4);
  if (!media.text.includes('#EXT-X-MAP')) throw new Error('Apple media playlist has no EXT-X-MAP');
  const audio = master.text.includes('TYPE=AUDIO') || media.text.includes('TYPE=AUDIO');
  const subtitles = master.text.includes('TYPE=SUBTITLES') || media.text.includes('TYPE=SUBTITLES');
  if (!audio || !subtitles) throw new Error(`Audio/subtitle declarations missing (audio=${audio}, subtitles=${subtitles})`);
  const initUri = media.text.split(/\r?\n/).filter((l) => l.startsWith('#EXT-X-MAP')).flatMap(uriAttrs)[0];
  if (!initUri) throw new Error('EXT-X-MAP URI missing');
  const init = await get(absolute(initUri, media.finalUrl), true);
  await init.body?.cancel();
  const segment = firstMediaUri(media.text, media.finalUrl);
  if (!segment) throw new Error('No fMP4 media segment');
  const seg = await get(segment, true);
  await seg.body?.cancel();
  pass('Apple BipBop fMP4', 'Master/Variant, EXT-X-MAP, audio/subtitle declarations, init and media segment reachable');
}
async function verifyAes() {
  const master = await playlist(streams.muxAes128);
  const media = await resolveMedia(streams.muxAes128);
  const keyLine = media.text.split(/\r?\n/).find((line) => line.startsWith('#EXT-X-KEY:') && line.includes('METHOD=AES-128'));
  if (!keyLine) throw new Error('No METHOD=AES-128 key declaration found in selected media playlist');
  const keyUri = uriAttrs(keyLine)[0];
  if (!keyUri) throw new Error('AES-128 key URI missing');
  const keyResponse = await get(absolute(keyUri, media.finalUrl));
  const key = await keyResponse.arrayBuffer();
  if (key.byteLength !== 16) throw new Error(`AES-128 key must be 16 bytes, got ${key.byteLength}`);
  const segment = firstMediaUri(media.text, media.finalUrl);
  if (!segment) throw new Error('No encrypted media segment');
  const seg = await get(segment, true);
  await seg.body?.cancel();
  pass('Mux DAI AES-128', 'AES-128 declaration, 16-byte key and encrypted media segment reachable (decryption is not asserted)');
}
async function verifyLive() {
  const media = await resolveMedia(streams.unifiedLive);
  if (media.text.includes('#EXT-X-ENDLIST')) throw new Error('Expected a sliding live playlist, found ENDLIST');
  if (!/^#EXT-X-MEDIA-SEQUENCE:/m.test(media.text)) throw new Error('Live media sequence missing');
  const segments = media.text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (!segments.length) throw new Error('Live playlist has no segments');
  const latest = absolute(segments[segments.length - 1], media.finalUrl);
  const response = await get(latest, true);
  await response.body?.cancel();
  pass('Unified Streaming Live', 'Sliding window and latest segment reachable');
}

for (const [name, run] of Object.entries({ appleFmp4: verifyApple, muxAes128: verifyAes, unifiedLive: verifyLive })) {
  try { await run(); } catch (error) { fail(name, error instanceof Error ? error.message : String(error)); }
}
for (const item of report) console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}: ${item.message}`);
if (report.some((item) => !item.ok)) process.exitCode = 1;
