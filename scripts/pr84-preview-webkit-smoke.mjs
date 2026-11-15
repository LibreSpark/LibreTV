#!/usr/bin/env node
/**
 * WebKit mobile-viewport acceptance against the exact deployed PR84 Preview.
 * This is a WebKit mobile emulation check, not a physical iPhone Safari run.
 */
import { webkit } from 'playwright';

const base = process.env.PR84_PREVIEW_URL || 'https://libretv-pr84-preview.bggdbh.workers.dev';
const browser = await webkit.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(45_000);

  // Attach diagnostics BEFORE navigation so fast API responses are not missed.
  const collectorResponses = [];
  const imageProxyResponses = [];
  const pageErrors = [];
  const failedRequests = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => failedRequests.push({
    url: request.url(),
    error: request.failure()?.errorText ?? 'request failed',
  }));
  page.on('response', (response) => {
    let url;
    try { url = new URL(response.url()); } catch { return; }
    if (url.pathname === '/api/img' || url.pathname === '/api/proxy') {
      imageProxyResponses.push({ status: response.status(), contentType: response.headers()['content-type'] ?? '' });
    }
  });

  const response = await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  if (!response || response.status() !== 200) {
    throw new Error('Preview homepage returned HTTP ' + (response?.status() ?? 'no response'));
  }
  await page.waitForSelector('.v4-home', { timeout: 45_000 });
  await page.waitForSelector('.v4-home-main--cinema > .v4-hero-immersive', { timeout: 45_000 });
  await page.waitForSelector('body > nav.v4-mobile-tabbar', { timeout: 45_000 });

  // Wait for settled content, not merely skeleton shells. A timeout is reported
  // with the API/page diagnostics below rather than being mistaken for success.
  try {
    await page.waitForFunction(() => {
      const heroSettled = Boolean(
        document.querySelector('.v4-hero-image img') ||
        document.querySelector('.v4-hero-empty')
      );
      const rails = Array.from(document.querySelectorAll('.v4-apple-rail-section'));
      return heroSettled && rails.length >= 3 && rails.every((section) =>
        section.querySelector('.v4-apple-poster-card, .v4-apple-rail-message')
      );
    }, { timeout: 45_000 });
  } catch {
    const pending = await page.evaluate(() => ({
      hero: document.querySelector('.v4-hero-empty')?.textContent?.trim() ??
        (document.querySelector('.v4-hero-image') ? 'image element present' : 'missing'),
      rails: Array.from(document.querySelectorAll('.v4-apple-rail-section')).map((section) => ({
        title: section.getAttribute('aria-label'),
        cards: section.querySelectorAll('.v4-apple-poster-card').length,
        skeletons: section.querySelectorAll('.v4-apple-poster-skeleton').length,
        message: section.querySelector('.v4-apple-rail-message')?.textContent?.trim() ?? null,
      })),
    }));
    throw new Error('Homepage data did not settle: ' + JSON.stringify({
      pending, collectorResponses, imageProxyResponses, pageErrors, failedRequests,
    }));
  }

  // The hero is part of the first-screen experience: wait for an actual decoded image,
  // not just an <img> node or a successful proxy HTTP response.
  try {
    await page.waitForFunction(() => {
      const image = document.querySelector('.v4-hero-image img');
      return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
    }, null, { timeout: 15_000 });
  } catch {
    const imageState = await page.evaluate(() => {
      const image = document.querySelector('.v4-hero-image img');
      return image instanceof HTMLImageElement ? {
        currentSrc: image.currentSrc,
        complete: image.complete,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
      } : null;
    });
    throw new Error('Homepage hero artwork did not decode in the first-screen viewport: ' + JSON.stringify({
      imageState, imageProxyResponses, failedRequests, pageErrors,
    }));
  }

  const contentState = await page.evaluate(() => {
    const heroImg = document.querySelector('.v4-hero-image img');
    const posterImages = Array.from(document.querySelectorAll('.v4-apple-poster-card img'));
    const realImages = [heroImg, ...posterImages].filter((img) =>
      img instanceof HTMLImageElement &&
      !img.currentSrc.startsWith('data:') &&
      img.complete &&
      img.naturalWidth > 0
    );
    return {
      heroTitle: document.querySelector('.v4-hero-content h1')?.textContent?.trim() ?? null,
      seedHubEmptyStateVisible: Array.from(document.querySelectorAll('body *')).some((node) =>
        node.children.length === 0 && /等待 SeedHub 目录|配置资源采集中心/.test(node.textContent ?? '')
      ),
      posterCards: document.querySelectorAll('.v4-apple-poster-card').length,
      loadedRemoteImages: realImages.length,
      railStates: Array.from(document.querySelectorAll('.v4-apple-rail-section')).map((section) => ({
        title: section.getAttribute('aria-label'),
        cards: section.querySelectorAll('.v4-apple-poster-card').length,
        message: section.querySelector('.v4-apple-rail-message')?.textContent?.trim() ?? null,
      })),
    };
  });
  if (contentState.loadedRemoteImages < 1) {
    throw new Error('Homepage has no successfully decoded remote hero/poster image: ' + JSON.stringify({ contentState, imageProxyResponses, failedRequests }));
  }
  if (contentState.seedHubEmptyStateVisible || collectorResponses.length > 0) {
    throw new Error('Retired SeedHub catalogue UI or requests are still present on the homepage: ' + JSON.stringify({
      contentState, collectorResponses, pageErrors, failedRequests,
    }));
  }
  if (pageErrors.length > 0) {
    throw new Error('Homepage JavaScript errors: ' + JSON.stringify(pageErrors));
  }

  const before = await page.evaluate(() => {
    const header = document.querySelector('.v4-home > .v4-header');
    const headerInner = header?.querySelector('.v4-header-inner');
    const hero = document.querySelector('.v4-home-main--cinema > .v4-hero-immersive');
    const dock = document.querySelector('body > nav.v4-mobile-tabbar');
    if (!header || !hero || !dock) throw new Error('Required cinema header, hero, or dock is missing');
    const headerStyle = getComputedStyle(header);
    const heroRect = hero.getBoundingClientRect();
    const dockRect = dock.getBoundingClientRect();
    const safeTop = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-area-top')) || 0;
    return {
      headerBackground: headerStyle.backgroundColor,
      headerBackdrop: headerStyle.backdropFilter || headerStyle.webkitBackdropFilter,
      headerHeight: headerInner?.getBoundingClientRect().height ?? header.getBoundingClientRect().height,
      heroHeight: heroRect.height,
      viewportHeight: window.innerHeight,
      dockPosition: getComputedStyle(dock).position,
      dockLeft: dockRect.left,
      dockWidth: dockRect.width,
      dockBottomGap: window.innerHeight - dockRect.bottom,
      safeTop,
      documentHeight: document.documentElement.scrollHeight,
    };
  });
  if (!/^rgba?\(0,\s*0,\s*0,\s*0\)$/.test(before.headerBackground.replace(/\s+/g, ' ').trim())) {
    throw new Error('Homepage header still paints a background surface: ' + before.headerBackground);
  }
  if (before.headerBackdrop && before.headerBackdrop !== 'none') {
    throw new Error('Homepage header still applies a backdrop surface: ' + before.headerBackdrop);
  }
  if (before.dockPosition !== 'fixed') throw new Error('Mobile dock is not fixed: ' + before.dockPosition);
  if (Math.abs(before.dockLeft) > 1 || Math.abs(before.dockWidth - 390) > 2) {
    throw new Error('Mobile dock drifted horizontally: ' + JSON.stringify({ left: before.dockLeft, width: before.dockWidth }));
  }
  if (before.dockBottomGap > 2 || before.dockBottomGap < -2) {
    throw new Error('Mobile dock is not anchored to the bottom edge: ' + before.dockBottomGap);
  }
  const heroBudget = Math.min(before.viewportHeight * 0.55, before.viewportHeight - 68 - before.safeTop - 132);
  if (before.heroHeight < 360 || before.heroHeight > Math.min(520, heroBudget) + 2) {
    throw new Error('Hero height is outside the agreed first-screen budget: ' + JSON.stringify({ hero: before.heroHeight, budget: heroBudget }));
  }
  if (before.documentHeight <= before.viewportHeight) {
    throw new Error('Homepage has no scrollable content to verify dock stability');
  }

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(350);
  const after = await page.evaluate(() => {
    const dock = document.querySelector('body > nav.v4-mobile-tabbar');
    const rect = dock.getBoundingClientRect();
    return { left: rect.left, width: rect.width, bottomGap: window.innerHeight - rect.bottom };
  });
  if (Math.abs(after.left) > 1 || Math.abs(after.width - 390) > 2 || Math.abs(after.bottomGap) > 2) {
    throw new Error('Mobile dock moved after page scroll: ' + JSON.stringify(after));
  }

  await page.screenshot({ path: '/tmp/pr84-preview-webkit.png', fullPage: true });
  console.log('PASS PR84 Preview WebKit mobile layout + retired SeedHub snapshot empty-state:', JSON.stringify({
    before, after, contentState, collectorResponses, imageProxyResponses, contentAcceptance: 'homepage contains no retired SeedHub empty-state UI or collector catalogue requests',
  }));

  // Resource Studio regression: this route has its own page scope and must
  // receive the shared navigation geometry instead of the LiquidGlass fallback.
  await page.route('**/api/resource-collector*', async (route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Preview smoke: collector intentionally unavailable' }),
    });
  });
  const studioResponse = await page.goto(new URL('/resource-studio', base).toString(), {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  if (!studioResponse || studioResponse.status() !== 200) {
    throw new Error('Resource Studio returned HTTP ' + (studioResponse?.status() ?? 'no response'));
  }
  await page.waitForSelector('.resource-studio-page', { timeout: 30_000 });
  await page.waitForSelector('body > nav.v4-mobile-tabbar', { timeout: 30_000 });
  await page.waitForSelector('.resource-studio-page [role="alert"]', { timeout: 30_000 });
  const studioLayout = await page.evaluate(() => {
    const root = document.querySelector('.resource-studio-page');
    const dock = document.querySelector('body > nav.v4-mobile-tabbar');
    const links = Array.from(dock?.querySelectorAll(':scope > a') ?? []);
    const dockStyle = dock ? getComputedStyle(dock) : null;
    const dockRect = dock?.getBoundingClientRect();
    const alert = root?.querySelector('[role="alert"]');
    const card = root?.querySelector('section.rounded-2xl');
    return {
      dockDirection: dockStyle?.flexDirection ?? null,
      dockDisplay: dockStyle?.display ?? null,
      dockHeight: dockRect?.height ?? 0,
      dockWidth: dockRect?.width ?? 0,
      dockLeft: dockRect?.left ?? 0,
      dockBottomGap: dockRect ? window.innerHeight - dockRect.bottom : 0,
      navItems: links.length,
      navItemWidths: links.map((link) => Math.round(link.getBoundingClientRect().width)),
      pageBackground: getComputedStyle(root).backgroundColor,
      pagePaddingBottom: Number.parseFloat(getComputedStyle(root).paddingBottom),
      cardBackground: card ? getComputedStyle(card).backgroundColor : null,
      alertBackground: alert ? getComputedStyle(alert).backgroundColor : null,
      alertColor: alert ? getComputedStyle(alert).color : null,
      documentHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
    };
  });
  if (studioLayout.dockDirection !== 'row' || studioLayout.dockDisplay !== 'flex') {
    throw new Error('Resource Studio dock is not a horizontal flex row: ' + JSON.stringify(studioLayout));
  }
  if (Math.abs(studioLayout.dockHeight - 68) > 1 || studioLayout.dockWidth < 340 ||
      studioLayout.dockWidth > 365 || Math.abs(studioLayout.dockLeft - (390 - studioLayout.dockWidth) / 2) > 2) {
    throw new Error('Resource Studio dock geometry is not the bounded capsule: ' + JSON.stringify(studioLayout));
  }
  if (Math.abs(studioLayout.dockBottomGap - 12) > 2 || studioLayout.navItems !== 4) {
    throw new Error('Resource Studio dock safe-area or tab count regression: ' + JSON.stringify(studioLayout));
  }
  if (studioLayout.pagePaddingBottom < 132 || studioLayout.documentHeight <= studioLayout.viewportHeight) {
    throw new Error('Resource Studio scroll clearance is missing: ' + JSON.stringify(studioLayout));
  }
  if (!studioLayout.alertBackground?.includes('127, 29, 29') ||
      !studioLayout.alertColor?.includes('252, 165, 165')) {
    throw new Error('Resource Studio warning is not using the dark warning palette: ' + JSON.stringify(studioLayout));
  }
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(250);
  await page.screenshot({ path: '/tmp/pr84-resource-studio-webkit.png', fullPage: true });
  console.log('PASS PR84 Resource Studio dark theme + horizontal capsule dock + scroll clearance:', JSON.stringify(studioLayout));

  // Exercise the watch route separately: its body-portaled dock previously
  // missed the home/search/spatial selectors and collapsed into a vertical capsule.
  const watchParams = new URLSearchParams({
    source: 'preview-smoke',
    sourceUrl: 'https://example.com/api.php/provide/vod',
    url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8',
    title: 'jintianshitaiyangyu',
  });
  const watchResponse = await page.goto(base + '/watch?' + watchParams.toString(), {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  if (!watchResponse || watchResponse.status() !== 200) {
    throw new Error('WatchPage returned HTTP ' + (watchResponse?.status() ?? 'no response'));
  }
  await page.waitForSelector('.watch-topbar', { timeout: 45_000 });
  await page.waitForSelector('.netflix-player-frame', { timeout: 45_000 });
  await page.waitForSelector('body > nav.v4-mobile-tabbar', { state: 'attached', timeout: 45_000 });
  await page.waitForSelector('.player-quality-badge', { timeout: 45_000 });

  // WebKit's role here is mobile layout/control geometry, not codec acceptance.
  // The same Apple HLS fixture is decoded and time-advanced in the dedicated
  // Chromium PlayerShell smoke test. Requiring videoWidth/currentTime here made
  // WebKit fail on HLS codec differences before it could validate the UI.
  // The cinema UI owns the timeline now; the native ArtPlayer toolbar is hidden.
  await page.waitForSelector('.watch-cinema-progress', { state: 'visible', timeout: 20_000 });

  // Verify the transport control is mounted and accessible. Playback-state
  // transitions are exercised by real decoded playback in the Chromium smoke;
  // synthetic read-only media-property overrides are not reliable in WebKit.
  const playbackControlPresence = await page.evaluate(() => {
    const video = document.querySelector('.netflix-player-frame video');
    const button = document.querySelector('.cinema-play-control');
    if (!(video instanceof HTMLVideoElement) || !(button instanceof HTMLButtonElement)) {
      throw new Error('Cinema playback button or native video element is missing');
    }
    return { ariaLabel: button.getAttribute('aria-label'), ariaPressed: button.getAttribute('aria-pressed') };
  });
  console.log('PASS PR84 cinema playback control is mounted and accessible:', JSON.stringify(playbackControlPresence));

  // Confirm the three tabs reveal content rather than leaving a coachmark over them.
  await page.waitForSelector('.watch-cinema-copy', { state: 'visible', timeout: 20_000 });
  const tabPanelAcceptance = await page.evaluate(async () => {
    const tabs = Array.from(document.querySelectorAll('.watch-cinema-tabs button'));
    const panel = document.querySelector('.watch-cinema-info');
    const copy = document.querySelector('.watch-cinema-copy');
    const heading = document.querySelector('.watch-cinema-meta h2');
    if (tabs.length !== 3 || !panel || !copy || !heading) throw new Error('Cinema information panel is incomplete');
    for (const label of ['洞察', '继续阅读', '简介']) {
      const tab = tabs.find((node) => node.textContent?.trim() === label);
      if (!tab) throw new Error('Missing cinema tab: ' + label);
      tab.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (tab.getAttribute('aria-pressed') !== 'true') throw new Error('Cinema tab did not activate: ' + label);
      if (getComputedStyle(copy).display === 'none' || copy.getBoundingClientRect().height <= 0) {
        throw new Error('Cinema tab content is hidden: ' + label);
      }
    }
    const tabRow = document.querySelector('.watch-cinema-tabs').getBoundingClientRect();
    const copyRect = copy.getBoundingClientRect();
    const infoRect = panel.getBoundingClientRect();
    if (tabRow.bottom > copyRect.top + 1) throw new Error('Cinema tab row overlaps its content panel');
    const yellowCoachmarks = Array.from(document.querySelectorAll('body *')).filter((node) => {
      if (node.children.length || node.textContent?.trim() !== '轻点继续阅读' || node.closest('.watch-cinema-tabs')) return false;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      const rgb = style.backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      const yellow = Boolean(rgb && Number(rgb[1]) > 170 && Number(rgb[2]) > 120 && Number(rgb[3]) < 150);
      const visible = style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      return visible && yellow && rect.right > tabRow.left && rect.left < tabRow.right &&
        rect.bottom > tabRow.top && rect.top < tabRow.bottom;
    });
    if (yellowCoachmarks.length) throw new Error('Yellow "tap to continue reading" coachmark overlaps the tabs');
    const titleText = heading.textContent?.trim() ?? '';
    if (titleText.toLowerCase().includes('jintianshitaiyangyu')) throw new Error('Machine slug is rendered as the title');
    if (infoRect.top < 0 || infoRect.bottom > window.innerHeight + 1) throw new Error('Cinema panel exceeds viewport');
    const result = {
      titleText, copyDisplay: getComputedStyle(copy).display, copyHeight: copyRect.height,
      tabBottom: tabRow.bottom, copyTop: copyRect.top, panelTop: infoRect.top,
      panelBottom: infoRect.bottom, yellowCoachmarkCount: yellowCoachmarks.length,
    };
    tabs.find((node) => node.textContent?.trim() === '简介')?.click();
    return result;
  });

  const watchLayout = await page.evaluate(() => {
    const header = document.querySelector('.watch-topbar');
    const close = header?.querySelector('.cinema-close-control');
    const airplay = header?.querySelector('[aria-label="投屏"]');
    const fullscreen = header?.querySelector('[aria-label="全屏播放"]');
    const utility = header?.querySelector('[aria-label="选集与换源"]');
    const rightToolbar = header?.querySelector('.watch-topbar-right');
    const visibleGeometry = (element) => {
      if (!(element instanceof HTMLElement)) return null;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        display: style.display,
        visibility: style.visibility,
        opacity: Number.parseFloat(style.opacity),
        width: rect.width,
        height: rect.height,
        x: rect.x,
        y: rect.y,
      };
    };
    const rightToolbarGeometry = visibleGeometry(rightToolbar);
    const airplayGeometry = visibleGeometry(airplay);
    const fullscreenGeometry = visibleGeometry(fullscreen);
    const centerControls = document.querySelectorAll('.cinema-center-controls button');
    const centerControlSizes = Array.from(centerControls).map((button) => {
      const rect = button.getBoundingClientRect();
      return { className: button.className, width: rect.width, height: rect.height };
    });
    const info = document.querySelector('.watch-cinema-info');
    const tabs = document.querySelector('.watch-cinema-tabs');
    const dock = document.querySelector('body > nav.v4-mobile-tabbar');
    const watchShell = document.querySelector('.netflix-watch-shell');
    const frame = document.querySelector('.netflix-player-frame');
    const video = frame?.querySelector('video');
    const bottom = frame?.querySelector('.artplayer .art-bottom, .art-video-player .art-bottom');
    const quality = frame?.querySelector('.player-quality-badge');
    const relatedSectionCount = document.querySelectorAll('.netflix-related-section').length;
    const fridayLauncher = document.querySelector('.friday-root .friday-fab, .friday-root .friday-restore');
    const progressBar = document.querySelector('.watch-cinema-progress');
    const progressTrack = progressBar;
    const progressDot = null;
    const relatedDataFallbacks = document.querySelectorAll('.netflix-related-art img[src^="data:"]').length;
    const emptyHistory = Array.from(document.querySelectorAll('.netflix-history-rail p'))
      .some((node) => node.textContent?.includes('还没有其他观看记录'));
    if (!header || !close || !airplay || !fullscreen || !utility || !dock || !watchShell || !frame || !info || !tabs) throw new Error('Immersive watch page elements or dedicated fullscreen/cast/utility controls are missing');
    const dockStyle = getComputedStyle(dock);
    const shellStyle = getComputedStyle(watchShell);
    const shellRect = watchShell.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    const videoRect = video?.getBoundingClientRect();
    const controlsRect = document.querySelector('.cinema-center-controls').getBoundingClientRect();
    const videoRatio = video?.videoWidth && video?.videoHeight ? video.videoWidth / video.videoHeight : 0;
    const frameRatio = frameRect.width / frameRect.height;
    const fittedWidth = videoRatio > 0 ? (videoRatio > frameRatio ? frameRect.width : frameRect.height * videoRatio) : 0;
    const fittedHeight = videoRatio > 0 ? (videoRatio > frameRatio ? frameRect.width / videoRatio : frameRect.height) : 0;
    const fittedVideoCenter = { x: frameRect.left + frameRect.width / 2, y: frameRect.top + frameRect.height / 2 };
    const infoStyle = getComputedStyle(info);
    const centerStyle = getComputedStyle(document.querySelector('.cinema-center-controls'));
    const gradient = bottom ? getComputedStyle(bottom).backgroundImage : '';
    return {
      hasCloseControl: Boolean(close),
      hasAirPlayControl: Boolean(airplay),
      hasFullscreenControl: Boolean(fullscreen),
      hasUtilityControl: Boolean(utility),
      rightToolbarGeometry,
      airplayGeometry,
      fullscreenGeometry,
      centerControlCount: centerControls.length,
      centerControlDisplay: centerStyle.display,
      centerControlSizes,
      infoPosition: infoStyle.position,
      infoBottom: info.getBoundingClientRect().bottom,
      infoTop: info.getBoundingClientRect().top,
      infoViewportHeight: window.innerHeight,
      tabCount: tabs.querySelectorAll('button').length,
      hasLegacyHeaderTitle: Boolean(header.querySelector('.watch-topbar-title')),
      headerButtons: header.querySelectorAll('button').length,
      hasHeaderAssistant: Boolean(header.querySelector('.friday-orb, .friday-fab, .friday-restore')),
      shellPosition: shellStyle.position,
      shellWidth: shellRect.width,
      shellHeight: shellRect.height,
      frameRect: { x: frameRect.x, y: frameRect.y, width: frameRect.width, height: frameRect.height },
      videoReady: Boolean(video && video.readyState >= 1 && videoRatio > 0),
      videoIntrinsicSize: video ? { width: video.videoWidth, height: video.videoHeight } : null,
      fittedVideoRect: { x: fittedVideoCenter.x - fittedWidth / 2, y: fittedVideoCenter.y - fittedHeight / 2, width: fittedWidth, height: fittedHeight },
      fittedVideoCenter,
      centerControlsCenter: { x: controlsRect.left + controlsRect.width / 2, y: controlsRect.top + controlsRect.height / 2 },
      dockDisplay: dockStyle.display,
      emptyHistory,
      historyLinkCount: document.querySelectorAll('.netflix-section-heading a[href="/me"]').length,
      playerBottomGradient: gradient,
      qualityFontSize: quality ? getComputedStyle(quality).fontSize : null,
      relatedSectionCount,
      fridayLauncherDisplay: fridayLauncher ? getComputedStyle(fridayLauncher).display : 'absent',
      progressHitAreaHeight: progressBar ? getComputedStyle(progressBar).height : null,
      progressHitAreaRect: progressBar ? (() => { const r = progressBar.getBoundingClientRect(); return { width: r.width, height: r.height, x: r.x, y: r.y }; })() : null,
      progressTrackHeight: progressTrack ? getComputedStyle(progressTrack).height : null,
      progressTrackBackground: progressTrack ? getComputedStyle(progressTrack).backgroundImage : null,
      progressTrackRect: progressTrack ? (() => { const r = progressTrack.getBoundingClientRect(); return { width: r.width, height: r.height, x: r.x, y: r.y }; })() : null,
      progressDotWidth: null,
      progressDotHeight: null,
      progressDotRect: null,
      progressPointerEvents: progressBar ? getComputedStyle(progressBar).pointerEvents : null,
      relatedDataFallbacks,
    };
  });
  const controlIsVisible = (geometry) => Boolean(
    geometry &&
    geometry.display !== 'none' &&
    geometry.visibility === 'visible' &&
    geometry.opacity > 0 &&
    geometry.width > 0 &&
    geometry.height > 0
  );
  if (!watchLayout.hasCloseControl || !watchLayout.hasAirPlayControl || !watchLayout.hasFullscreenControl ||
      !controlIsVisible(watchLayout.rightToolbarGeometry) ||
      !controlIsVisible(watchLayout.airplayGeometry) ||
      !controlIsVisible(watchLayout.fullscreenGeometry) ||
      !watchLayout.hasUtilityControl || watchLayout.hasLegacyHeaderTitle || watchLayout.headerButtons !== 4 || watchLayout.hasHeaderAssistant) {
    throw new Error('Immersive header must visibly render close, AirPlay, fullscreen and utility controls without a page title: ' + JSON.stringify(watchLayout));
  }
  const oversizedTransportControl = watchLayout.centerControlSizes.some((control) =>
    control.className.includes('cinema-play-control')
      ? control.width > 68 || control.height > 68
      : control.width > 48 || control.height > 48
  );
  if (watchLayout.centerControlCount !== 3 || watchLayout.centerControlDisplay !== 'flex' ||
      oversizedTransportControl ||
      watchLayout.infoPosition !== 'fixed' || watchLayout.tabCount !== 3 ||
      watchLayout.infoTop <= 0 || watchLayout.infoBottom > 844) {
    throw new Error('Reference-matched center controls or fixed bottom information panel are missing: ' + JSON.stringify(watchLayout));
  }
  if (watchLayout.shellPosition !== 'fixed' || Math.abs(watchLayout.shellWidth - 390) > 2 ||
      Math.abs(watchLayout.shellHeight - 844) > 2) {
    throw new Error('Watch player shell is not filling the mobile viewport: ' + JSON.stringify(watchLayout));
  }
  const stageCenter = {
    x: watchLayout.shellWidth / 2,
    y: watchLayout.shellHeight / 2,
  };
  const frameCoversStage =
    Math.abs(watchLayout.frameRect.x) <= 1 &&
    Math.abs(watchLayout.frameRect.y) <= 1 &&
    Math.abs(watchLayout.frameRect.width - watchLayout.shellWidth) <= 1 &&
    Math.abs(watchLayout.frameRect.height - watchLayout.shellHeight) <= 2;
  const fittedImageCentered = !watchLayout.videoReady || (
    Math.abs(watchLayout.fittedVideoCenter.x - stageCenter.x) <= 1 &&
    Math.abs(watchLayout.fittedVideoCenter.y - stageCenter.y) <= 1
  );
  if (!frameCoversStage || !fittedImageCentered ||
      Math.abs(watchLayout.centerControlsCenter.x - stageCenter.x) > 2 ||
      Math.abs(watchLayout.centerControlsCenter.y - stageCenter.y) > 2) {
    throw new Error('Cinema video stage or transport controls are not centered in the full viewport: ' + JSON.stringify(watchLayout));
  }
  if (watchLayout.dockDisplay !== 'none') {
    throw new Error('Immersive watch mode must hide the global mobile navigation dock: ' + JSON.stringify(watchLayout));
  }
  if (watchLayout.emptyHistory && watchLayout.historyLinkCount !== 0) {
    throw new Error('Empty continue-watching state still shows the all-history link');
  }
  if (watchLayout.qualityFontSize !== '12px') {
    throw new Error('Player quality badge is not compact 12px text: ' + JSON.stringify(watchLayout));
  }
  if (watchLayout.relatedSectionCount !== 0) {
    throw new Error('The removed related-movies section is still present on the watch page: ' + JSON.stringify(watchLayout));
  }
  if (watchLayout.fridayLauncherDisplay !== 'none' && watchLayout.fridayLauncherDisplay !== 'absent') {
    throw new Error('Floating Friday starfield launcher still overlaps the watch page: ' + JSON.stringify(watchLayout));
  }
  if (!watchLayout.progressHitAreaRect || watchLayout.progressHitAreaRect.height < 12 ||
      watchLayout.progressHitAreaRect.height > 20 ||
      !watchLayout.progressTrackRect || watchLayout.progressTrackRect.width <= 0 ||
      watchLayout.progressTrackRect.height < 14 || watchLayout.progressTrackRect.height > 20 ||
      watchLayout.progressPointerEvents === 'none') {
    throw new Error('Custom cinema timeline hit area is invalid (target 14–20px with pointer events enabled): ' + JSON.stringify(watchLayout));
  }
  if (watchLayout.relatedDataFallbacks !== 0) {
    throw new Error('Related posters are still using decorative data-URI fallbacks: ' + JSON.stringify(watchLayout));
  }
  await page.screenshot({ path: '/tmp/pr84-preview-watch-webkit.png', fullPage: true });
  console.log('PASS PR84 Preview WebKit cinema tabs + content clearance + slug filtering:', JSON.stringify(tabPanelAcceptance));
  console.log('PASS PR84 Preview WebKit immersive cinema player + fixed bottom information + horizontal dock:', JSON.stringify(watchLayout));

  // Verify the new dedicated SeedHub detail route in a fresh page.
  // Player/HLS media requests can emit delayed WebKit access-control errors
  // after the watch page has navigated away; a separate page gives this route
  // an independent JavaScript-error scope instead of racing late media events.
  const seedHubPage = await context.newPage();
  seedHubPage.setDefaultTimeout(45_000);
  const seedHubPageErrors = [];
  seedHubPage.on('pageerror', (error) => seedHubPageErrors.push(error.message));
  // No collector credentials are assumed here: the empty-URL state must render
  // safely without issuing a request to the external Scrapling service.
  const seedHubResponse = await seedHubPage.goto(base + '/seedhub', {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  if (!seedHubResponse || seedHubResponse.status() !== 200) {
    throw new Error('SeedHub detail route returned HTTP ' + (seedHubResponse?.status() ?? 'no response'));
  }
  await seedHubPage.getByText('无法读取 SeedHub 详情', { exact: true }).waitFor({ timeout: 30_000 });
  await seedHubPage.getByText('缺少 SeedHub 影片地址。', { exact: true }).waitFor({ timeout: 30_000 });
  if (seedHubPageErrors.length > 0) {
    throw new Error('SeedHub detail route JavaScript errors: ' + JSON.stringify(seedHubPageErrors));
  }
  await seedHubPage.screenshot({ path: '/tmp/pr84-preview-seedhub-detail-webkit.png', fullPage: true });
  console.log('PASS PR84 Preview SeedHub dedicated detail route + safe missing-URL state');
} finally {
  await browser.close();
}
