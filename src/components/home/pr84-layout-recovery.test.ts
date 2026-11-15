import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('PR #84 homepage blocking layout recovery', () => {
  const layout = read('src/app/layout.tsx');
  const recovery = read('src/app/pr84-layout-recovery.css');
  const dock = read('src/components/home/header/MobileTabBar.tsx');
  const page = read('src/app/page.tsx');
  const globalLayout = read('src/app/pr84-global-layout.css');
  const dockFix = read('src/app/pr84-dock-fix.css');
  const appleDock = read('src/app/pr84-apple-tv-dock.css');
  const inlineHome = read('src/app/iphone-home-inline.css');
  const nonOwnerDockStyles = [
    'src/app/iphone-home-inline.css',
    'src/app/iphone-minimal-ui.css',
    'src/app/iphone-glass.css',
    'src/app/v4-homepage.css',
    'src/app/pr84-layout-recovery.css',
    'src/app/pr84-search-polish.css',
    'src/app/pr84-dock-fix.css',
    'src/app/pr84-global-layout.css',
    'src/app/pr84-liquid-refraction.css',
  ].map(read);
  const header = read('src/components/home/V4HomepageHeader.tsx');
  const settings = read('src/components/source-manager.tsx');

  it('loads the recovery contract after all legacy homepage and mobile overrides', () => {
    expect(layout.indexOf("import './iphone-home-inline.css';")).toBeGreaterThan(-1);
    expect(layout.indexOf("import './pr84-layout-recovery.css';")).toBeGreaterThan(
      layout.indexOf("import './iphone-home-inline.css';"),
    );
  });

  it('keeps all four navigation destinations visible in a four-column viewport dock', () => {
    expect(dock).toContain("{ href: '/', label: '首页', icon: 'home' }");
    expect(dock).toContain("{ href: '/search', label: '搜索', icon: 'search' }");
    expect(dock).toContain("{ href: '/settings', label: '设置', icon: 'settings' }");
    expect(dock).toContain("{ href: '/me', label: '我的', icon: 'user' }");
    expect(dock).toContain('createPortal(navigation, portalTarget)');
    expect(dock).toContain('setPortalTarget(document.body)');
    expect(appleDock).toContain('grid-template-columns: repeat(4, minmax(0, 1fr)) !important;');
    expect(appleDock).toContain('position: fixed !important;');
    expect(recovery).not.toContain('[data-homepage-dock="true"]');
    expect(recovery).not.toContain('.v4-mobile-tabbar');
  });

  it('mounts exactly one shared mobile navigation and gives dock geometry one stylesheet owner', () => {
    expect(layout).toContain("import { MobileTabBar } from '@/components/home/header/MobileTabBar';");
    expect(layout).toContain('<MobileTabBar />');
    expect(header).not.toContain('<MobileTabBar />');
    expect(layout).toContain("import './pr84-global-layout.css';");
    expect(layout.indexOf("import './pr84-apple-tv-dock.css';")).toBeGreaterThan(
      layout.indexOf("import './pr84-liquid-refraction.css';"),
    );

    expect(appleDock).toContain('--tabbar-height: 68px;');
    expect(appleDock).toContain('--safe-area-bottom: env(safe-area-inset-bottom, 0px);');
    expect(appleDock).toContain('height: calc(var(--tabbar-height) + var(--safe-area-bottom)) !important;');
    expect(appleDock).toContain('padding-bottom: var(--tabbar-scroll-clearance) !important;');
    expect(appleDock).toContain('position: fixed !important;');

    const splitTopLevel = (value: string, delimiter: string) => {
      const parts: string[] = [];
      let depth = 0;
      let quote = '';
      let start = 0;
      for (let index = 0; index < value.length; index += 1) {
        const char = value[index];
        if (quote) {
          if (char === quote && value[index - 1] !== '\\') quote = '';
          continue;
        }
        if (char === '"' || char === "'") quote = char;
        else if (char === '(') depth += 1;
        else if (char === ')') depth = Math.max(0, depth - 1);
        else if (char === delimiter && depth === 0) {
          parts.push(value.slice(start, index));
          start = index + 1;
        }
      }
      parts.push(value.slice(start));
      return parts;
    };
    const selectorSubject = (selector: string) => {
      let depth = 0;
      let quote = '';
      let start = 0;
      for (let index = 0; index < selector.length; index += 1) {
        const char = selector[index];
        if (quote) {
          if (char === quote && selector[index - 1] !== '\\') quote = '';
          continue;
        }
        if (char === '"' || char === "'") quote = char;
        else if (char === '(') depth += 1;
        else if (char === ')') depth = Math.max(0, depth - 1);
        else if (depth === 0 && (char === '>' || char === '+' || char === '~' || /\s/.test(char))) {
          start = index + 1;
        }
      }
      return selector.slice(start).trim();
    };
    const hasDockGeometry = (css: string) => {
      const geometry = /\b(?:position|inset|width|height|min-height|max-height|left|right|top|bottom|transform)\s*:/;
      return Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/gs)).some(([, selector, declarations]) =>
        geometry.test(declarations) &&
        splitTopLevel(selector, ',').some((part) => {
          const subject = selectorSubject(part);
          return subject.includes('.v4-mobile-tabbar') &&
            !subject.includes('::before') &&
            !subject.includes('::after');
        }),
      );
    };
    for (const css of nonOwnerDockStyles) {
      expect(hasDockGeometry(css)).toBe(false);
    }
    expect(globalLayout).not.toContain('position: fixed !important;');
    expect(globalLayout).toContain('var(--tabbar-scroll-clearance)');
    expect(globalLayout).toContain('.v4-spatial-screen[data-screen="me"] > .v4-spatial-main');
  });

  it('keeps mobile hero height and crop ownership in the final Apple Dock stylesheet', () => {
    expect(appleDock).toContain('height: min(55svh, calc(100svh - 68px - env(safe-area-inset-top, 0px) - 132px)) !important;');
    expect(appleDock).toContain('object-position: center 85% !important;');
    for (const staleHeight of [
      'height: clamp(360px,55svh,520px) !important;',
      'height: clamp(380px, 55svh, 520px) !important;',
      'height: clamp(380px, 60svh, 520px) !important;',
      'height: clamp(520px, 68svh, 620px) !important;',
      'height: clamp(560px, 74svh, 640px) !important;',
      'height: clamp(570px, 76svh, 660px) !important;',
      'height: min(88svh,780px) !important;',
    ]) expect(inlineHome).not.toContain(staleHeight);
    for (const staleCrop of ['center 0%', 'center 68%', 'center 80%', 'center 85%', 'center 24%']) {
      expect(inlineHome).not.toContain(`object-position: ${staleCrop} !important;`);
    }
  });

  it('removes the empty black header surface and pins the dock to the viewport', () => {
    expect(globalLayout).toContain('background: transparent !important;');
    expect(globalLayout).toContain('backdrop-filter: none !important;');
    expect(appleDock).toContain('position: fixed !important;');
    expect(appleDock).toContain('bottom: 0 !important;');
    expect(appleDock).toContain('translate: none !important;');
    expect(appleDock).toContain('height: min(55svh, calc(100svh - 68px - env(safe-area-inset-top, 0px) - 132px)) !important;');
  });

  it('keeps dock scroll clearance in one shared CSS token', () => {
    expect(appleDock).toContain('--tabbar-scroll-clearance: calc(var(--tabbar-height) + var(--safe-area-bottom) + 52px);');
    for (const stylesheet of [globalLayout, dockFix, recovery, appleDock]) {
      expect(stylesheet).not.toContain('calc(var(--tabbar-height) + var(--safe-area-bottom) + 52px) !important');
    }
    expect(globalLayout).toContain('var(--tabbar-scroll-clearance)');
    expect(dockFix).toContain('var(--tabbar-scroll-clearance)');
    expect(recovery).toContain('var(--tabbar-scroll-clearance)');
  });

  it('does not repeat identical adjacent dock selectors in the dock fix stylesheet', () => {
    const lines = dockFix.split('\n').map((line) => line.trim());
    const hasDuplicateSelectorPair = lines.some(
      (line, index) =>
        line.endsWith(',') && line.slice(0, -1) === lines[index + 1],
    );
    expect(hasDuplicateSelectorPair).toBe(false);
  });

  it('protects hero artwork from the iOS status and brand area', () => {
    expect(globalLayout).toContain('position: absolute !important;');
    expect(globalLayout).toContain('inset: 0 0 auto !important;');
    expect(globalLayout).toContain('padding: calc(env(safe-area-inset-top, 0px) + 12px) 12px 0 !important;');
    expect(globalLayout).toContain('padding-top: 0 !important;');
    expect(globalLayout).toContain('height: 100% !important;');
    expect(globalLayout).toContain('object-position: center 30% !important;');
    expect(globalLayout).not.toContain('top: calc(env(safe-area-inset-top, 0px) + 54px) !important;');
  });

  it('prioritizes live hot poster rails before local watch history on the cinema lobby', () => {
    const content = read('src/components/home/V4HomepageContent.tsx');
    const hotTv = content.indexOf('id="apple-tv-top10"');
    const hotMovies = content.indexOf('id="apple-movie-top10"');
    const newReleases = content.indexOf('id="apple-new-releases"');
    const continueWatching = content.indexOf('className="v4-content-section v4-continue-section"');
    expect(hotTv).toBeGreaterThan(-1);
    expect(hotMovies).toBeGreaterThan(hotTv);
    expect(newReleases).toBeGreaterThan(hotMovies);
    expect(continueWatching).toBeGreaterThan(newReleases);
  });

  it('uses the same left-aligned Large Title hierarchy on Settings and Search', () => {
    expect(settings).toContain('<header className="settings-large-title">');
    expect(settings).toContain('<h1>设置</h1>');
    expect(globalLayout).toContain('.settings-embedded-root .settings-large-title h1');
    expect(globalLayout).toContain('.v4-search-page .v4-search-heading h1');
  });

  it('keeps the homepage and hero in natural document flow with a real scrollable page', () => {
    expect(recovery).not.toContain('overflow-y: auto !important;');
    expect(recovery).not.toContain('position: static !important;');
    expect(recovery).toContain('height: auto !important;');
    expect(recovery).toContain('flex: 0 0 auto !important;');
    expect(recovery).toContain('padding: 0 0 24px !important;');
    expect(recovery).not.toContain('height: min(55svh, calc(100svh - 68px - env(safe-area-inset-top, 0px) - 132px)) !important;');
    expect(recovery).not.toContain('min-height: 360px !important;');
    expect(recovery).not.toContain('max-height: 520px !important;');
    expect(appleDock).toContain('height: min(55svh, calc(100svh - 68px - env(safe-area-inset-top, 0px) - 132px)) !important;');
    expect(appleDock).toContain('min-height: 360px !important;');
    expect(appleDock).toContain('max-height: 520px !important;');
    expect(recovery).toContain('overflow: visible !important;');
    expect(page).toContain('<V4HomepageHero onPick={handleHomepagePick} />');
    expect(page).toContain('<V4HomepageContent onPick={handleHomepagePick} />');
    expect(page).not.toContain('SeedHubHomepage');
  });

  it('uses the same body-level viewport portal on homepage and routed catalogue screens', () => {
    expect(dock).toContain('return portalTarget ? createPortal(navigation, portalTarget) : null;');
    expect(dock).not.toContain('return navigation;');
    expect(dock).not.toContain('data-homepage-dock');
    expect(globalLayout).not.toContain('data-homepage-dock');
  });
});
