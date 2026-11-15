#!/usr/bin/env node
/**
 * Exercise LibreTV's actual WatchPage + PlayerShell + ArtPlayer + hls.js
 * against real public HLS streams. The URL query is changed in-place so the
 * React PlayerShell must switch sources while retaining its video element.
 */
import { chromium } from 'playwright';

const base = process.env.PR84_PREVIEW_URL || 'https://libretv-pr84-preview.bggdbh.workers.dev';
const streams = {
  fmp4: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8',
  alternateRendition: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/v9/prog_index.m3u8',
};
const browserChannel = process.env.PR84_BROWSER_CHANNEL?.trim();
const browser = await chromium.launch({
  ...(browserChannel ? { channel: browserChannel } : {}),
  headless: true,
});
const errors = [];
const mediaResponses = [];
const failedRequests = [];
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: [],
  });
  const page = await context.newPage();
  page.setDefaultTimeout(45_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('requestfailed', (request) => {
    const url = new URL(request.url());
    if (url.hostname.includes('apple.com') || url.hostname.includes('unified-streaming.com')) {
      failedRequests.push({ url: url.origin + url.pathname, error: request.failure()?.errorText ?? 'request failed' });
    }
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.hostname.includes('apple.com') || url.hostname.includes('unified-streaming.com')) {
      mediaResponses.push({ url: url.origin + url.pathname, status: response.status(), contentType: response.headers()['content-type'] ?? '' });
    }
  });

  const params = new URLSearchParams({
    source: 'preview-smoke',
    sourceUrl: 'https://example.com/api.php/provide/vod',
    url: streams.fmp4,
    title: 'LibreTV Player Acceptance',
  });
  const response = await page.goto(base + '/watch?' + params.toString(), {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  if (!response || response.status() !== 200) {
    throw new Error('WatchPage returned HTTP ' + (response?.status() ?? 'no response'));
  }

  await page.waitForSelector('video', { timeout: 45_000 });
  await page.evaluate(() => {
    const video = document.querySelector('video');
    if (!video) throw new Error('PlayerShell video element is missing');
    video.muted = true;
    video.volume = 0;
    void video.play().catch(() => undefined);
  });
  try {
    await page.waitForFunction(() => {
      const video = document.querySelector('video');
      return Boolean(video && video.readyState >= 2 && video.currentTime >= 1.5 &&
        video.videoWidth > 0 && video.videoHeight > 0);
    }, null, { timeout: 45_000 });
  } catch (error) {
    const state = await page.evaluate(() => {
      const video = document.querySelector('video');
      return video ? {
        currentTime: video.currentTime,
        readyState: video.readyState,
        networkState: video.networkState,
        width: video.videoWidth,
        height: video.videoHeight,
        paused: video.paused,
        currentSrc: video.currentSrc,
        mediaError: video.error ? { code: video.error.code, message: video.error.message } : null,
      } : null;
    });
    throw new Error('PlayerShell fMP4 fixture did not reach decoded frames: ' + JSON.stringify({
      state, mediaResponses, failedRequests, pageErrors: errors.slice(0, 8),
      cause: error instanceof Error ? error.message : String(error),
    }));
  }

  const first = await page.evaluate(() => {
    const video = document.querySelector('video');
    if (!video) throw new Error('PlayerShell video disappeared');
    window.__pr84PlayerVideo = video;
    return {
      currentTime: video.currentTime,
      readyState: video.readyState,
      width: video.videoWidth,
      height: video.videoHeight,
      currentSrc: video.currentSrc,
    };
  });
  console.log('PASS LibreTV PlayerShell fMP4 playback:', JSON.stringify(first));

  // Record actual media and pointer events, then use the same pause/resume gesture
  // a viewer would perform before leaving the screen untouched.
  await page.evaluate(() => {
    const shell = document.querySelector('.netflix-watch-shell');
    const video = document.querySelector('video');
    window.__pr84OverlayEventLog = [];
    const record = (event) => window.__pr84OverlayEventLog.push({
      type: event.type,
      target: event.target instanceof Element ? event.target.className?.toString?.() || event.target.tagName : 'unknown',
      at: Math.round(performance.now()),
      paused: video?.paused ?? null,
    });
    for (const name of ['pointerdown', 'pointermove', 'touchstart', 'click', 'keydown']) {
      shell?.addEventListener(name, record, true);
    }
    for (const name of ['play', 'playing', 'pause', 'waiting', 'stalled', 'ended']) {
      video?.addEventListener(name, record);
    }
  });
  const transportButton = page.locator('.cinema-play-control');
  await transportButton.click();
  await page.waitForFunction(() => document.querySelector('video')?.paused === true, null, { timeout: 3_000 });
  await transportButton.click();
  await page.waitForFunction((start) => {
    const video = document.querySelector('video');
    return Boolean(video && !video.paused && video.currentTime >= start + 0.5);
  }, first.currentTime, { timeout: 8_000 });
  // Move once, then wait for the real 3s hide deadline (with scheduling slack).
  // A predicate wait avoids asserting at an arbitrary point before the deadline.
  await page.mouse.move(720, 450);
  let hideWaitError = null;
  try {
    await page.waitForFunction(() => {
      const shell = document.querySelector('.netflix-watch-shell');
      const video = document.querySelector('video');
      return Boolean(shell?.classList.contains('cinema-controls-hidden') && video && !video.paused);
    }, null, { timeout: 8_000, polling: 100 });
  } catch (error) {
    hideWaitError = error instanceof Error ? error.message : String(error);
  }
  const hiddenOverlay = await page.evaluate(() => {
    const shell = document.querySelector('.netflix-watch-shell');
    const topbar = document.querySelector('.watch-topbar');
    const center = document.querySelector('.cinema-center-controls');
    const info = document.querySelector('.watch-cinema-info');
    const qualityControls = document.querySelector('.player-quality-controls');
    const state = (element) => {
      if (!(element instanceof HTMLElement)) return null;
      const style = getComputedStyle(element);
      return { opacity: Number.parseFloat(style.opacity), visibility: style.visibility };
    };
    return {
      hiddenClass: Boolean(shell?.classList.contains('cinema-controls-hidden')),
      paused: document.querySelector('video')?.paused ?? true,
      topbar: state(topbar), center: state(center), info: state(info), qualityControls: state(qualityControls),
      currentTime: document.querySelector('video')?.currentTime ?? 0,
      controlsDebug: shell?.dataset.controlsHideDebug ?? 'missing',
      eventLog: window.__pr84OverlayEventLog ?? [],
    };
  });
  if (hideWaitError || hiddenOverlay.controlsDebug === 'missing' ||
      !hiddenOverlay.hiddenClass || hiddenOverlay.paused ||
      [hiddenOverlay.topbar, hiddenOverlay.center, hiddenOverlay.info, hiddenOverlay.qualityControls].some((item) =>
        !item || item.visibility !== 'hidden' || item.opacity > 0.05)) {
    throw new Error('Cinema controls did not auto-hide after 3s of uninterrupted playback: ' + JSON.stringify({
      waitError: hideWaitError,
      ...hiddenOverlay,
    }));
  }
  await page.mouse.move(721, 451);
  await page.waitForFunction(() => !document.querySelector('.netflix-watch-shell')?.classList.contains('cinema-controls-hidden'), null, { timeout: 3_000 });
  const revealedOverlay = await page.evaluate(() => ({
    hiddenClass: Boolean(document.querySelector('.netflix-watch-shell')?.classList.contains('cinema-controls-hidden')),
    topbarVisibility: getComputedStyle(document.querySelector('.watch-topbar')).visibility,
    centerVisibility: getComputedStyle(document.querySelector('.cinema-center-controls')).visibility,
    infoVisibility: getComputedStyle(document.querySelector('.watch-cinema-info')).visibility,
    qualityVisibility: getComputedStyle(document.querySelector('.player-quality-controls')).visibility,
  }));
  if (revealedOverlay.hiddenClass || revealedOverlay.topbarVisibility !== 'visible' ||
      revealedOverlay.centerVisibility !== 'visible' || revealedOverlay.infoVisibility !== 'visible' ||
      revealedOverlay.qualityVisibility !== 'visible') {
    throw new Error('Cinema controls did not return after pointer interaction: ' + JSON.stringify(revealedOverlay));
  }
  await page.evaluate(() => document.querySelector('video')?.pause());
  await page.waitForFunction(() => document.querySelector('video')?.paused === true, null, { timeout: 3_000 });
  const pausedOverlay = await page.evaluate(() => ({
    hiddenClass: Boolean(document.querySelector('.netflix-watch-shell')?.classList.contains('cinema-controls-hidden')),
    topbarVisibility: getComputedStyle(document.querySelector('.watch-topbar')).visibility,
    centerVisibility: getComputedStyle(document.querySelector('.cinema-center-controls')).visibility,
    infoVisibility: getComputedStyle(document.querySelector('.watch-cinema-info')).visibility,
    qualityVisibility: getComputedStyle(document.querySelector('.player-quality-controls')).visibility,
  }));
  if (pausedOverlay.hiddenClass || pausedOverlay.topbarVisibility !== 'visible' ||
      pausedOverlay.centerVisibility !== 'visible' || pausedOverlay.infoVisibility !== 'visible' ||
      pausedOverlay.qualityVisibility !== 'visible') {
    throw new Error('Cinema controls did not remain visible after pause: ' + JSON.stringify(pausedOverlay));
  }
  console.log('PASS cinema controls auto-hide / interaction reveal / pause visibility:', JSON.stringify({ hiddenOverlay, revealedOverlay, pausedOverlay }));

  // Measure the real ArtPlayer timeline, then seek through its actual control.
  const timelineBefore = await page.evaluate(() => {
    const frame = document.querySelector('.netflix-player-frame');
    const video = frame?.querySelector('video');
    const progress = document.querySelector('.watch-cinema-progress');
    if (!video || !progress) {
      throw new Error('Custom cinema timeline/video is missing');
    }
    const rect = (element) => {
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    return {
      duration: video.duration,
      currentTime: video.currentTime,
      progress: rect(progress),

      progressPointerEvents: getComputedStyle(progress).pointerEvents,
    };
  });
  if (timelineBefore.progress.height < 12 || timelineBefore.progress.height > 20) {
    throw new Error('Actual ArtPlayer seek hit area is outside 12–20px: ' + JSON.stringify(timelineBefore));
  }

  const seekTarget = await page.evaluate(() => {
    const progress = document.querySelector('.watch-cinema-progress');
    const video = document.querySelector('.netflix-player-frame video');
    if (!progress || !video) throw new Error('Cannot seek: progress control/video missing');
    const r = progress.getBoundingClientRect();
    return { x: r.left + r.width * 0.72, y: r.top + r.height / 2, before: video.currentTime };
  });
  await page.mouse.click(seekTarget.x, seekTarget.y);
  await page.waitForFunction((before) => {
    const video = document.querySelector('.netflix-player-frame video');
    return Boolean(video && Math.abs(video.currentTime - before) > 2);
  }, seekTarget.before, { timeout: 12_000 });
  const timelineAfter = await page.evaluate(() => ({
    currentTime: document.querySelector('.netflix-player-frame video')?.currentTime ?? 0,
  }));
  console.log('PASS custom cinema timeline geometry + pointer seek:', JSON.stringify({
    timelineBefore, seekTarget, timelineAfter,
  }));

  await page.evaluate((url) => {
    const video = document.querySelector('video');
    if (!video) throw new Error('PlayerShell video disappeared before source switch');
    window.__pr84SwitchEvents = [];
    for (const name of ['emptied', 'loadstart', 'loadedmetadata', 'playing']) {
      video.addEventListener(name, () => window.__pr84SwitchEvents.push(name));
    }
    const next = new URL(window.location.href);
    next.searchParams.set('url', url);
    window.history.pushState({}, '', next.toString());
  }, streams.alternateRendition);

  try {
    await page.waitForFunction(() => {
      const video = document.querySelector('video');
      return Boolean(video && video === window.__pr84PlayerVideo &&
        window.__pr84SwitchEvents?.includes('loadstart') &&
        video.readyState >= 2 && video.currentTime >= 1.5 &&
        video.videoWidth > 0 && video.videoHeight > 0);
    }, null, { timeout: 60_000 });
  } catch (error) {
    const state = await page.evaluate(() => {
      const video = document.querySelector('video');
      return {
        sameVideoElement: video === window.__pr84PlayerVideo,
        locationSearch: window.location.search,
        switchEvents: window.__pr84SwitchEvents ?? [],
        currentSrc: video?.currentSrc ?? '',
        currentTime: video?.currentTime ?? 0,
        readyState: video?.readyState ?? 0,
        networkState: video?.networkState ?? 0,
        videoWidth: video?.videoWidth ?? 0,
        videoHeight: video?.videoHeight ?? 0,
        mediaError: video?.error ? { code: video.error.code, message: video.error.message } : null,
      };
    });
    throw new Error('Alternate HLS rendition source-switch playback did not reach decoded frames: ' +
      JSON.stringify({ state, mediaResponses, failedRequests, pageErrors: errors.slice(0, 8), cause: error instanceof Error ? error.message : String(error) }));
  }

  const second = await page.evaluate(() => {
    const video = document.querySelector('video');
    return {
      sameVideoElement: video === window.__pr84PlayerVideo,
      switchEvents: window.__pr84SwitchEvents,
      currentTime: video?.currentTime ?? 0,
      readyState: video?.readyState ?? 0,
      width: video?.videoWidth ?? 0,
      height: video?.videoHeight ?? 0,
      currentSrc: video?.currentSrc ?? '',
    };
  });
  if (!second.sameVideoElement) throw new Error('PlayerShell replaced the video element during source switching');

  const encodedKkphimUrl = process.env.PR84_KKPHIM_M3U8;
  if (encodedKkphimUrl) {
    const kkphimUrl = decodeURIComponent(encodedKkphimUrl);
    await page.evaluate((url) => {
      const video = document.querySelector('video');
      if (!video) throw new Error('PlayerShell video disappeared before KKPhim source switch');
      window.__pr84KkphimEvents = [];
      for (const name of ['emptied', 'loadstart', 'loadedmetadata', 'playing']) {
        video.addEventListener(name, () => window.__pr84KkphimEvents.push(name));
      }
      const next = new URL(window.location.href);
      next.searchParams.set('url', url);
      window.history.pushState({}, '', next.toString());
    }, kkphimUrl);

    try {
      await page.waitForFunction(() => {
        const video = document.querySelector('video');
        return Boolean(video && video === window.__pr84PlayerVideo &&
          window.__pr84KkphimEvents?.includes('loadstart') &&
          video.readyState >= 2 && video.currentTime >= 1.5 &&
          video.videoWidth > 0 && video.videoHeight > 0);
      }, null, { timeout: 60_000 });
    } catch (error) {
      const state = await page.evaluate(() => {
        const video = document.querySelector('video');
        return {
          sameVideoElement: video === window.__pr84PlayerVideo,
          switchEvents: window.__pr84KkphimEvents ?? [],
          currentSrc: video?.currentSrc ?? '',
          currentTime: video?.currentTime ?? 0,
          readyState: video?.readyState ?? 0,
          networkState: video?.networkState ?? 0,
          videoWidth: video?.videoWidth ?? 0,
          videoHeight: video?.videoHeight ?? 0,
          mediaError: video?.error ? { code: video.error.code, message: video.error.message } : null,
        };
      });
      throw new Error('KKPhim HLS did not reach decoded frames in LibreTV PlayerShell: ' +
        JSON.stringify({ state, pageErrors: errors.slice(0, 8), cause: error instanceof Error ? error.message : String(error) }));
    }

    const third = await page.evaluate(() => {
      const video = document.querySelector('video');
      return {
        sameVideoElement: video === window.__pr84PlayerVideo,
        switchEvents: window.__pr84KkphimEvents,
        currentTime: video?.currentTime ?? 0,
        readyState: video?.readyState ?? 0,
        width: video?.videoWidth ?? 0,
        height: video?.videoHeight ?? 0,
        currentSrc: video?.currentSrc ?? '',
      };
    });
    if (!third.sameVideoElement) throw new Error('PlayerShell replaced the video element during KKPhim source switching');
    console.log('PASS LibreTV PlayerShell KKPhim HLS decoded playback:', JSON.stringify(third));
  }

  if (!process.env.PR84_KKPHIM_M3U8) {
    console.log('SKIP KKPhim PlayerShell decode: no freshly verified HLS candidate was produced by this run.');
  }

  if (errors.length > 0) throw new Error('Player console errors: ' + errors.slice(0, 8).join(' | '));

  await page.screenshot({ path: '/tmp/pr84-preview-player.png', fullPage: false });
  // A source reload must rebind media lifecycle listeners and restart the same overlay timer.
  await page.waitForFunction(() => {
    const video = document.querySelector('video');
    return Boolean(video && !video.paused && video.readyState >= 2 && video.currentTime >= 1.5);
  }, null, { timeout: 8_000 });
  await page.waitForTimeout(3_500);
  const switchedHidden = await page.evaluate(() => {
    const shell = document.querySelector('.netflix-watch-shell');
    const video = document.querySelector('video');
    const selectors = ['.watch-topbar', '.cinema-center-controls', '.watch-cinema-info', '.player-quality-controls'];
    return { hiddenClass: Boolean(shell?.classList.contains('cinema-controls-hidden')), paused: video?.paused ?? true,
      controls: selectors.map((selector) => { const element = document.querySelector(selector); const style = element ? getComputedStyle(element) : null; return { selector, visibility: style?.visibility, opacity: style ? Number.parseFloat(style.opacity) : 1 }; }) };
  });
  if (!switchedHidden.hiddenClass || switchedHidden.paused || switchedHidden.controls.some((item) => item.visibility !== 'hidden' || item.opacity > 0.05)) {
    throw new Error('Cinema controls lifecycle did not restart after source switch: ' + JSON.stringify(switchedHidden));
  }
  await page.mouse.move(722, 452);
  await page.waitForFunction(() => !document.querySelector('.netflix-watch-shell')?.classList.contains('cinema-controls-hidden'), null, { timeout: 3_000 });
  await page.evaluate(() => document.querySelector('video')?.pause());
  await page.waitForFunction(() => document.querySelector('video')?.paused === true, null, { timeout: 3_000 });
  const switchedPausedVisible = await page.evaluate(() => ({
    hiddenClass: Boolean(document.querySelector('.netflix-watch-shell')?.classList.contains('cinema-controls-hidden')),
    controlsVisible: ['.watch-topbar', '.cinema-center-controls', '.watch-cinema-info', '.player-quality-controls'].every((selector) => {
      const element = document.querySelector(selector); return Boolean(element && getComputedStyle(element).visibility === 'visible');
    }),
  }));
  if (switchedPausedVisible.hiddenClass || !switchedPausedVisible.controlsVisible) {
    throw new Error('Controls did not remain visible after pausing the switched source: ' + JSON.stringify(switchedPausedVisible));
  }
  console.log('PASS cinema controls lifecycle after source switch:', JSON.stringify({ switchedHidden, switchedPausedVisible }));

  console.log('PASS LibreTV PlayerShell alternate HLS rendition source switch on the same video element:', JSON.stringify(second));
} finally {
  await browser.close();
}
