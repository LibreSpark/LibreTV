#!/usr/bin/env node
import { chromium } from 'playwright';

const rawUrl = process.env.LIBRETV_4K_TEST_URL || '';
const allowedHosts = new Set(
  (process.env.LIBRETV_4K_ALLOWED_HOSTS || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
);
const durationSeconds = Number(process.env.LIBRETV_4K_DURATION_SECONDS || '600');

function validateTarget() {
  if (!rawUrl || allowedHosts.size === 0) {
    throw new Error('Configure LIBRETV_4K_TEST_URL and LIBRETV_4K_ALLOWED_HOSTS as repository secrets.');
  }
  if (!Number.isInteger(durationSeconds) || durationSeconds < 60 || durationSeconds > 3600) {
    throw new Error('LIBRETV_4K_DURATION_SECONDS must be an integer from 60 to 3600.');
  }
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('The authorized media URL must be an absolute HTTP(S) URL without credentials.');
  }
  const expectedPort = url.protocol === 'https:' ? '443' : '80';
  if (url.port && url.port !== expectedPort) {
    throw new Error('Only the default port for the selected HTTP(S) scheme is permitted.');
  }
  if (!allowedHosts.has(url.hostname.toLowerCase())) {
    throw new Error('The media host is not present in the exact hostname allowlist.');
  }
  return url;
}

const target = validateTarget();
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
let failure;
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
  });
  page.setDefaultTimeout(60_000);
  // Enforce the exact hostname allowlist on every media, manifest, segment, and
  // redirect request—not only on the initial URL supplied to the workflow.
  await page.route('**/*', async (route) => {
    let requestUrl;
    try {
      requestUrl = new URL(route.request().url());
    } catch {
      await route.abort('blockedbyclient');
      return;
    }
    const requestPort = requestUrl.protocol === 'https:' ? '443' : '80';
    if (
      !['http:', 'https:'].includes(requestUrl.protocol) ||
      requestUrl.username ||
      requestUrl.password ||
      (requestUrl.port && requestUrl.port !== requestPort) ||
      !allowedHosts.has(requestUrl.hostname.toLowerCase())
    ) {
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  await page.setContent(
    '<!doctype html><html><body style="margin:0;background:#000">' +
      '<video id="v" muted playsinline controls style="width:100vw;height:100vh"></video>' +
      '</body></html>',
  );
  const isHls = new URL(target).pathname.toLowerCase().endsWith('.m3u8');
  if (isHls) {
    await page.addScriptTag({ path: 'node_modules/hls.js/dist/hls.min.js' });
    await page.evaluate(async (url) => {
      const video = document.querySelector('#v');
      const Hls = window.Hls;
      if (!Hls || !Hls.isSupported()) throw new Error('HLS MediaSource is unavailable.');
      const hls = new Hls({
        enableWorker: false,
        lowLatencyMode: false,
        capLevelToPlayerSize: false,
        maxBufferLength: 60,
      });
      window.__libretvHls = hls;
      hls.loadSource(url);
      hls.attachMedia(video);
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('HLS manifest load timed out.')), 60000);
        hls.once(Hls.Events.MANIFEST_PARSED, () => {
          clearTimeout(timeout);
          const candidates = hls.levels
            .map((level, index) => ({ index, height: level.height || 0, bitrate: level.bitrate || 0 }))
            .filter((level) => level.height >= 2160)
            .sort((a, b) => b.height - a.height || b.bitrate - a.bitrate);
          if (!candidates.length) {
            reject(new Error('The HLS manifest has no rendition at or above 2160p.'));
            return;
          }
          const chosen = candidates[0];
          hls.currentLevel = chosen.index;
          window.__libretvExpectedLevel = chosen;
          resolve();
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            clearTimeout(timeout);
            reject(new Error('Fatal HLS playback error: ' + data.type + '/' + data.details));
          }
        });
      });
    }, target.href);
  } else {
    await page.locator('#v').evaluate((video, url) => {
      video.src = url;
      video.load();
    }, target.href);
  }

  // HLS level selection is asynchronous: MANIFEST_PARSED only confirms that
  // renditions were discovered, not that the selected 2160p stream is decoded.
  // Wait for actual browser-decoded dimensions before starting the timed run.
  await page.waitForFunction(
    () => {
      const video = document.querySelector('#v');
      return (
        video &&
        video.readyState >= 2 &&
        video.videoWidth >= 3840 &&
        video.videoHeight >= 2160
      );
    },
    null,
    { timeout: 60_000 },
  );
  await page.locator('#v').evaluate(async (video) => {
    await video.play();
  });

  const startedAt = Date.now();
  let lastProgressAt = Date.now();
  let lastTime = 0;
  let samples = 0;
  while ((Date.now() - startedAt) / 1000 < durationSeconds) {
    await page.waitForTimeout(1000);
    const state = await page.locator('#v').evaluate((video) => ({
      currentTime: video.currentTime,
      paused: video.paused,
      readyState: video.readyState,
      width: video.videoWidth,
      height: video.videoHeight,
      bufferedEnd: video.buffered.length ? video.buffered.end(video.buffered.length - 1) : 0,
    }));
    if (state.height < 2160 || state.width < 3840) {
      throw new Error('Decoded frame no longer meets the 3840x2160 4K threshold.');
    }
    if (state.currentTime > lastTime + 0.1) {
      lastTime = state.currentTime;
      lastProgressAt = Date.now();
      samples += 1;
    } else if (Date.now() - lastProgressAt > 30_000) {
      throw new Error('Playback timeline made no progress for 30 seconds.');
    }
    if (state.paused && state.currentTime < durationSeconds) {
      throw new Error('Playback unexpectedly paused during the sustained 4K run.');
    }
  }

  const result = await page.locator('#v').evaluate((video) => ({
    width: video.videoWidth,
    height: video.videoHeight,
    currentTime: video.currentTime,
    readyState: video.readyState,
  }));
  console.log(JSON.stringify({
    status: 'passed',
    verification_level: 'real_chromium_4k_decode_and_sustained_playback',
    decoded_width: result.width,
    decoded_height: result.height,
    observed_seconds: Math.round((Date.now() - startedAt) / 1000),
    media_timeline_seconds: Math.round(result.currentTime),
    progressing_samples: samples,
    target_host: target.hostname,
  }));
} catch (error) {
  failure = error;
  console.error(JSON.stringify({
    status: 'failed',
    error_type: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message.slice(0, 300) : 'Playback verification failed.',
  }));
} finally {
  await browser.close();
}
if (failure) process.exitCode = 1;
