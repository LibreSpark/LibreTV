#!/usr/bin/env node
/**
 * Headless browser HLS playback smoke test.
 * Verifies actual MSE demux/decode and timeline progress in Chromium for:
 * - public fMP4 HLS with declared audio/subtitle renditions
 * - public AES-128 HLS (the browser must fetch the 16-byte key and decrypt)
 * - switching the same video element from the fMP4 source to the AES source
 *
 * This is a desktop Chromium browser test, not a physical iPhone Safari test.
 */
import { chromium } from 'playwright';
import { resolve } from 'node:path';

const streams = {
  fmp4: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8',
  aes128: 'https://test-streams.mux.dev/dai-discontinuity-deltatre/manifest.m3u8',
};
const timeoutMs = 45_000;
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
let failed = false;

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('requestfailed', (request) => console.error('HLS request failed:', request.url(), request.failure()?.errorText));
  page.on('response', (response) => { if (response.status() >= 400) console.error('HLS HTTP error:', response.status(), response.url()); });
  page.setDefaultTimeout(timeoutMs);
  await page.setContent('<!doctype html><html><body style="margin:0;background:#000"><video id="video" muted playsinline controls style="width:960px;height:540px"></video></body></html>');
  await page.addScriptTag({ path: resolve('node_modules/hls.js/dist/hls.min.js') });
  const codecSupport = await page.evaluate(() => ({
    h264: MediaSource.isTypeSupported('video/mp4; codecs="avc1.64001e"'),
    aac: MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"'),
  }));
  console.log('Browser codec support:', JSON.stringify(codecSupport));
  if (!codecSupport.h264 || !codecSupport.aac) throw new Error('Chrome runtime lacks baseline H.264/AAC MSE codec support');
  await page.evaluate(() => {
    const Hls = window.Hls;
    if (!Hls || !Hls.isSupported()) throw new Error('hls.js MediaSource is not supported in this browser');
    const video = document.querySelector('#video');
    window.runHlsStream = (url) => new Promise((resolve, reject) => {
      if (window.__hls) {
        window.__hls.destroy();
        window.__hls = undefined;
      }
      video.pause();
      video.removeAttribute('src');
      video.load();
      const hls = new Hls({ enableWorker: false, lowLatencyMode: false, backBufferLength: 30 });
      window.__hls = hls;
      let settled = false;
      const startedAt = performance.now();
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearInterval(progressTimer);
        clearTimeout(timeout);
        hls.off(Hls.Events.ERROR, onError);
        if (error) reject(error);
        else resolve(value);
      };
      const onError = (_event, data) => {
        if (data.fatal) finish(new Error('Fatal HLS error: ' + data.type + ' / ' + data.details + (data.reason ? ' / ' + data.reason : '')));
      };
      const timeout = setTimeout(() => finish(new Error('Playback progress timeout; currentTime=' + video.currentTime)), 45000);
      const progressTimer = setInterval(() => {
        if (video.readyState >= 2 && video.currentTime >= 1.5 && !video.paused) {
          finish(null, {
            currentTime: video.currentTime,
            readyState: video.readyState,
            width: video.videoWidth,
            height: video.videoHeight,
            audioTracks: hls.audioTracks.length,
            subtitleTracks: hls.subtitleTracks.length,
            elapsedMs: Math.round(performance.now() - startedAt),
          });
        }
      }, 250);
      hls.on(Hls.Events.ERROR, onError);
      hls.on(Hls.Events.MANIFEST_PARSED, async () => {
        // Select the lowest rendition first to avoid high-profile codec variants
        // masking whether the baseline H.264/AAC path is playable in Chrome.
        hls.currentLevel = 0;
        try { await video.play(); } catch (error) { finish(error); }
      });
      hls.loadSource(url);
      hls.attachMedia(video);
    });
  });

  const fmp4 = await page.evaluate((url) => window.runHlsStream(url), streams.fmp4);
  if (fmp4.width <= 0 || fmp4.height <= 0) throw new Error('fMP4 decoded frame has no dimensions');
  if (fmp4.audioTracks < 1) throw new Error('fMP4 manifest did not expose an audio track');
  if (fmp4.subtitleTracks < 1) throw new Error('fMP4 manifest did not expose a subtitle track');
  console.log(`PASS browser fMP4 decode: ${fmp4.width}x${fmp4.height}, audio=${fmp4.audioTracks}, subtitles=${fmp4.subtitleTracks}, t=${fmp4.currentTime.toFixed(2)}s`);

  const aes = await page.evaluate((url) => window.runHlsStream(url), streams.aes128);
  if (aes.width <= 0 || aes.height <= 0) throw new Error('AES-128 stream decoded frame has no dimensions');
  console.log(`PASS browser AES-128 decrypt + decode: ${aes.width}x${aes.height}, t=${aes.currentTime.toFixed(2)}s`);

  console.log('PASS browser source switch: same video element transitioned from fMP4 to AES-128 and resumed timeline progress');
} catch (error) {
  failed = true;
  console.error('FAIL browser HLS playback:', error instanceof Error ? error.stack || error.message : String(error));
} finally {
  await browser.close();
}
if (failed) process.exitCode = 1;
