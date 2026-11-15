import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

const home = source('src/app/page.tsx');
const v4Header = source('src/components/home/V4HomepageHeader.tsx');
const searchModule = source('src/components/home/header/SearchModule.tsx');
const historyModule = source('src/components/home/header/HistoryModule.tsx');
const settingsModule = source('src/components/home/header/SettingsModule.tsx');
const avatarModule = source('src/components/home/header/AvatarModule.tsx');
const navModules = ['HomeNavModule', 'MoviesNavModule', 'TvNavModule', 'OverseasNavModule', 'AnimeNavModule', 'VarietyNavModule', 'LiveNavModule'].map((name) => source('src/components/home/header/' + name + '.tsx'));
const v4Styles = source('src/app/v4-homepage.css');
const watch = source('src/app/watch/page.tsx');
const watchStyles = source('src/app/pr84-watch-mobile-fix.css');
const hero = source('src/components/friday/FridayHero.tsx');
const canvas = source('src/components/home/HomeIntentCanvas.tsx');
const orb = source('src/components/friday/FridayOrb.tsx');
const assistant = source('src/components/AIFloatingBall.tsx');
const header = source('src/components/header.tsx');
const movieDetail = source('src/components/movie-detail-page.tsx');
const player = source('src/components/player-shell.tsx');
const fullscreenHelper = source('src/lib/player-fullscreen.ts');
const database = source('src/lib/db.ts');
const videoCards = source('src/components/video-card.tsx');
const spatialScreenSource = source('src/components/home/V4SpatialScreen.tsx');
const searchPageSource = source('src/app/search/page.tsx');
const searchResultsSource = source('src/app/search/results/page.tsx');
const history = source('src/components/history-panel.tsx');
const settings = source('src/components/source-manager.tsx');
const drawer = source('src/components/drawer.tsx');
const theme = source('src/components/theme.tsx');
const live = source('src/app/live/page.tsx');
const downloads = source('src/components/download-manager.tsx');
const search = source('src/components/home/useHomeSearchController.ts');
const searchHistory = source('src/components/search-history.tsx');
const styles = source('src/components/friday/FridayStyles.tsx');
const fridayConversation = source('src/components/friday/FridayConversation.tsx');
const movieAgents = source('src/lib/friday/movie-agents.ts');
const movieWorkflow = source('src/lib/friday/movie-workflow.ts');
const voiceController = source('src/components/friday/useFridayVoiceController.ts');
const browserAsr = source('src/components/friday/browserAsr.ts');

const spatialScreen = source('src/components/home/V4SpatialScreen.tsx');
const resourceStudio = source('src/app/resource-studio/page.tsx');
const resourceAgentRoute = source('src/app/api/resource-collector/agent/route.ts');
const resourceCollectorRoute = source('src/app/api/resource-collector/route.ts');
const collectorWorker = source('services/scrapling-collector/worker.py');
const collectorQueue = source('services/scrapling-collector/registry_queue.py');
const seedhubCollector = source('services/scrapling-collector/seedhub.py');

const channelStyles = source('src/app/eight-screen-glass.css');
const ipadStyles = source('src/app/ipad-glass.css');
const channelHeaderStyles = source('src/app/iphone-glass.css');
const homepageHeroStyles = source('src/app/v4-homepage.css');
const inlineHomeStyles = source('src/app/iphone-home-inline.css');
const mobileUiStyles = source('src/app/iphone-minimal-ui.css');
const categoryPage = source('src/app/categories/page.tsx');
const featuredHero = source('src/components/home/V4HomepageHero.tsx');
const previewConfig = source('wrangler.preview.toml');
const previewWorkflow = source('.github/workflows/deploy-homepage-preview.yml');
const rootLayout = source('src/app/layout.tsx');
const glassStyles = source('src/app/eight-screen-glass.css');
const sharedHeaderStyles = source('src/app/v4-shared-header.css');
const chatSession = source('src/components/friday/useFridayChatSession.ts');
const fridayPanel = source('src/components/friday/FridayPanel.tsx');

describe('首页与播放页回归契约', () => {
  it('首页 FridayOrb 保持可见、可访问，并将点击交给唯一语音控制器', () => {
    expect(home).toContain('<V4HomepageHeader overlay={!urlQuery} />');
    expect(v4Header).toContain("pathname !== '/detail'");
    expect(v4Header).toContain('<AIFloatingBall showFab inlineMode={false} />');
    expect(assistant).toContain('onClick={openAndListen}');
    expect(assistant).toContain('startListening(false)');
    expect(orb).toContain('createFridayOrb(canvasRef.current');
    expect(orb).toContain('engine.destroy()');
  });

  it('首页圆球点击贯通唯一语音控制器，并覆盖识别错误、停止和卸载清理', () => {
    expect(assistant).toContain('window.addEventListener("friday-home-orb-toggle", handleHomeOrbToggle)');
    expect(assistant).toContain('startListening(false)');
    expect(assistant).toContain('stopRecognition(true)');
    expect(voiceController).toContain('getBrowserAsrConstructor()');
    expect(voiceController).toContain('recognition.onstart');
    expect(voiceController).toContain('recognition.onresult');
    expect(voiceController).toContain('recognition.onerror');
    expect(voiceController).toContain('recognition.onend');
    expect(voiceController).toContain('mountedRef.current = false');
    expect(voiceController).toContain('stopAllVoice');
  });

  it('真实 data-movies 结果进入五 Agent 工作流，停止与重试沿用同一运行时', () => {
    expect(chatSession).toContain('part.type !== "data-movies"');
    expect(chatSession).toContain('runLibreTVMovieWorkflow');
    expect(chatSession).toContain('replayFailed: true');
    expect(chatSession).toContain('controller.abort()');
    expect(movieWorkflow).toContain('agent: "playback-agent"');
  });

  it('刷新后可从 IndexedDB 任务记录显式恢复只读工作流，副作用任务不提供恢复按钮', () => {
    expect(chatSession).toContain('retryInterruptedWorkflow');
    expect(chatSession).toContain('taskIdPrefix');
    expect(chatSession).toContain('storedCandidates');
    expect(chatSession).toContain('fridayTaskEventStore.read');
    expect(chatSession).toContain('replayFailed: true');
    expect(fridayPanel).toContain('onRetryInterruptedTask');
    expect(fridayPanel).toContain('task.error?.code === "TASK_INTERRUPTED"');
    expect(fridayPanel).toContain('!task.sideEffect');
  });

  it('播放器以 videoHeight 作为真实解码画质，并与清单探测结果区分', () => {
    expect(player).toContain('const reportVideoHeight');
    expect(player).toContain('art.video?.videoHeight');
    expect(player).toContain("art.on('video:loadedmetadata', reportVideoHeight)");
    expect(player).toContain("art.on('video:canplay', reportVideoHeight)");
    expect(watch).toContain("from: 'play'");
    expect(fridayConversation).toContain('manifest/segment');
    expect(fridayConversation).toContain('videoHeight');
    expect(watch).toContain("friday-player-quality");
    expect(chatSession).toContain("friday-player-quality");
    expect(chatSession).toContain("decodedPlaybackHeightsRef");
    expect(fridayConversation).toContain("decodedVideoHeight");
    expect(fridayConversation).toContain("播放器解码实测");
  });

  it('首页以豆瓣精选主视觉和真实推荐海报为主，并保留 IndexedDB 继续观看进度', () => {
    const homepageHero = source('src/components/home/V4HomepageHero.tsx');
    const homepageContent = source('src/components/home/V4HomepageContent.tsx');
    expect(home).toContain('<V4HomepageHero onPick={handleHomepagePick} />');
    expect(home).toContain('<V4HomepageContent onPick={handleHomepagePick} />');
    expect(home).not.toContain('SeedHubHomepage');
    expect(homepageHero).toContain("api.douban('movie', '热门'");
    expect(homepageHero).toContain('slide.cover');
    expect(homepageContent).toContain("api.douban('tv', '热门'");
    expect(homepageContent).toContain("api.douban('movie', '热门'");
    expect(homepageContent).toContain("api.hotList('douban_movie_weekly'");
    expect(homepageContent).toContain('url={item.cover}');
    expect(homepageContent).toContain('v4-continue-section');
    expect(homepageContent).toContain('v4-progress-percent');
    expect(homepageContent).toContain('buildWatchUrl({');
    expect(homepageContent).toContain('playbackPosition / item.duration');
    expect(v4Styles).toContain('.v4-history-row');
    expect(v4Styles).toContain('.v4-apple-rail');
    expect(v4Styles).toContain('.v4-apple-poster-card');
    expect(home).toContain("router.push('/detail?' + params.toString())");
    expect(home).toContain('api.search(movie.title, selectedSources, yellowFilter)');
    expect(movieDetail).toContain('export function MovieDetailPage()');
  });

  it('V4 首页 Header 首屏即透明沉浸，滚动时不切换状态', () => {
    expect(home).toContain('<V4HomepageHeader overlay={!urlQuery} />');
    expect(v4Header).toContain('is-overlay');
    expect(v4Header).not.toContain('setIsScrolled');
    expect(v4Header).not.toContain('is-scrolled');
    expect(inlineHomeStyles).toContain('background: transparent !important;');
    expect(inlineHomeStyles).toContain('body .v4-home .v4-header.is-overlay');
    expect(inlineHomeStyles).toContain('top: 0 !important;');
    expect(inlineHomeStyles).toContain('z-index: 50 !important;');
    expect(inlineHomeStyles).toContain('position: absolute !important;');
    expect(inlineHomeStyles).toContain('background-color: #000 !important;');
    expect(inlineHomeStyles).toContain('padding-top: calc(env(safe-area-inset-top, 0px) + 12px) !important;');
    expect(inlineHomeStyles).toContain('top: calc(env(safe-area-inset-top, 0px) + 104px) !important;');
    expect(inlineHomeStyles).toContain('display: none !important;');

    expect(inlineHomeStyles).toContain('padding-top: clamp(380px, 60svh, 520px) !important;');
    expect(inlineHomeStyles).toContain('border: 0 !important;');
    expect(inlineHomeStyles).toContain('padding-left: 20px !important;');
    expect(rootLayout).toContain("themeColor: '#000000'");
    expect(rootLayout).toContain("viewportFit: 'cover'");
    expect(rootLayout).toContain("statusBarStyle: 'black-translucent'");
    expect(v4Styles).toContain('.v4-home-main--cinema > .v4-hero');
    for (const label of ['首页', '电影', '电视剧', '海外剧', '动漫', '综艺', '直播']) {
      expect(navModules.some((module) => module.includes('label="' + label + '"'))).toBe(true);
    }
    expect(v4Styles).toContain('.v4-nav-link.is-active');
  });


  it('首页与全部频道共用同一套顶部导航外观和响应式结构', () => {
    expect(rootLayout).toContain("import './v4-shared-header.css';");
    expect(rootLayout.indexOf("import './v4-shared-header.css';")).toBeGreaterThan(rootLayout.indexOf("import './v4-homepage.css';"));
    for (const selector of ['.v4-header,', '.v4-home .v4-header,', '.v4-spatial-screen > .v4-header']) {
      expect(sharedHeaderStyles).toContain(selector);
    }
    expect(sharedHeaderStyles).toContain('background: rgba(10, 10, 13, .84) !important;');
    expect(sharedHeaderStyles).toContain('.v4-home .v4-header-inner');
    expect(sharedHeaderStyles).toContain('.v4-spatial-screen .v4-header-inner');
    expect(sharedHeaderStyles).toContain('@media screen and (max-width: 700px)');
    expect(sharedHeaderStyles).toContain('.v4-home .v4-header.is-overlay {');
    expect(sharedHeaderStyles).toContain('.v4-home .v4-header.is-overlay.is-scrolled {');
    expect(sharedHeaderStyles).toContain('background: rgba(10, 10, 13, .84) !important;');
    expect(sharedHeaderStyles).toContain('background: rgba(10, 10, 13, .92) !important;');
    expect(sharedHeaderStyles).toContain('position: absolute !important;');
    expect(sharedHeaderStyles).toContain('position: fixed !important;');
    expect(sharedHeaderStyles).not.toContain('background: rgba(246, 248, 251, 0.88)');
  });

  it('首页顶部移除搜索与我的入口，非首页 Header 仍保留原入口组件', () => {
    expect(v4Header).not.toContain('BrandModule');
    expect(v4Header).not.toContain('<nav');
    expect(v4Header).toContain('{!overlay && (');
    expect(v4Header).toContain('<SearchModule />');
    expect(v4Header).toContain('<AvatarModule pathname={pathname} />');
    expect(sharedHeaderStyles).toContain('.v4-home .v4-header-inner');
    expect(sharedHeaderStyles).toContain('.v4-home .v4-header.is-overlay');
  });

  it('首页右上角不渲染搜索与我的入口，独立搜索页和搜索逻辑仍保留', () => {
    expect(home).toContain('<V4HomepageHeader overlay={!urlQuery} />');
    expect(v4Header).toContain('{!overlay && (');
    expect(searchModule).toContain("router.push('/search')");
    expect(search).toContain('router.push(`/?q=${encodeURIComponent(query)}`');
    expect(searchHistory).toContain("queryKey: ['searchHistory']");
  });

  it('设置首页采用 Apple 式纵向分组列表，分类进入独立详情页并可返回', () => {
    expect(settings).toContain('const SETTINGS_SECTIONS');
    expect(settings).toContain('rounded-2xl border border-line bg-card divide-y');
    expect(settings).toContain("setActivePage(item.id)");
    expect(settings).toContain("setActivePage('index')");
    expect(settings).toContain("activePage === 'appearance'");
    expect(settings).toContain("activePage === 'vod' && <VodSourcesPanel />");
    expect(settings).toContain("activePage === 'live' && <LiveSourceManager />");
    expect(settings).toContain("type VodFilter = 'all' | 'enabled' | 'disabled' | 'sub' | 'manual'");
    expect(settings).toContain('const VOD_FILTERS');
  });

  it('顶部设置、主题、直播、下载和历史入口保持连接', () => {
    expect(header).toContain("href=\"/live\"");
    expect(header).toContain('<ThemeToggle />');
    expect(header).toContain('观看历史');
    expect(header).toContain('requestShowDownloadManager');
    expect(header).toContain('设置');
    expect(header).toContain('<SourceManagerDrawer');
    expect(header).toContain('<HistoryPanel');
    expect(theme).toContain("function persistTheme(choice: ThemeChoice)");
    expect(theme).toContain("window.localStorage.setItem(STORAGE_KEY, choice)");
    expect(live).toContain('<V4HomepageHeader');
    expect(downloads).toContain("window.addEventListener(ADD_TASK_EVENT, onAdd)");
  });

  it('影片详情请求成功后通过标准 watch URL 进入播放页', () => {
    expect(movieDetail).toContain('.detail(vodId, source, controller.signal)');
    expect(movieDetail).toContain('buildWatchUrl({');
    expect(movieDetail).toContain('router.push(');
    expect(movieDetail).toContain('sourceUrl: source?.url || sourceUrl || undefined');
  });

  it('播放页装载播放器、换源弹窗、进度恢复和下载入口', () => {
    expect(watch).toContain('dynamic(() => import(\'@/components/player-shell\')');
    expect(watch).toContain('<PlayerShell');
    expect(watch).toContain('<SwitchSourceModal');
    expect(watch).toContain('getRestorePosition={getRestorePosition}');
    expect(watch).toContain('setWatchClock({ position, duration })');
    expect(watch).toContain('onTimeUpdate={(position, duration) =>');
    expect(watch).toContain('onPause={(position, duration) =>');
    expect(watch).toContain('enqueueDownload({');
    expect(watch).toContain('setSwitchOpen(true)');
  });

  it('换源会校验候选资源并切换到目标源的 watch URL', () => {
    const switchSource = source('src/components/switch-source.tsx');
    expect(switchSource).toContain('const switchTo = (c: Candidate)');
    expect(switchSource).toContain('if (!c.episodes)');
    expect(switchSource).toContain('buildWatchUrl({');
    expect(switchSource).toContain('sourceKey: c.source.key');
    expect(switchSource).toContain('router.push(');
  });

  it('点播播放器保留播放、进度、音量、全屏与 HLS 恢复配置', () => {
    expect(player).toContain('volume: 0.8');
    expect(player).toContain('fullscreen: !touchPointer');
    expect(player).toContain('fullscreenWeb: !touchPointer');
    expect(player).toContain('requestNativeFullscreenWithFallback');
    expect(fullscreenHelper).toContain('webkitEnterFullscreen');
    expect(player).toContain('if (!art.fullscreenWeb) art.fullscreenWeb = true;');
    expect(player).toContain('playbackRate: true');
    expect(player).toContain('art.on(\'video:ratechange\'');
    expect(player).toContain('art.on(\'video:loadedmetadata\'');
    expect(player).toContain('onTimeUpdate');
    expect(player).toContain('setupHls(video, mediaUrl, true)');
    expect(player).toContain('artRef.current.currentTime = saved');
    expect(player).toContain('artRef.current?.pause()');
  });

  it('播放页不显示 Friday 悬浮入口，但保留语音运行时且不增加聊天面板', () => {
    expect(watch).toContain('<AIFloatingBall inlineMode showFab={false} />');
    expect(watch).not.toContain('FridayPlayerAssistantButton');
    expect(watch).not.toContain('friday-home-orb-toggle');
    expect(watch).not.toContain("from '@/components/header'");
    expect(assistant).toContain('if (inlineMode) {');
    expect(assistant).toContain('if (!showFab) return null;');
    expect(assistant).toContain('onClick={openAndListen}');
    expect(styles).toContain('z-index: 2147483647');
    expect(styles).toContain('pointer-events: none');
  });

  it('观看历史可恢复播放，播放页使用唯一返回按钮并提供首页兜底', () => {
    expect(history).toContain('buildWatchUrl({');
    expect(history).toContain('const href = buildWatchUrl({');
    expect(history).toContain('href={href}');
    expect(watch).toContain('aria-label="返回"');
    expect(watch).not.toContain('aria-label="回首页"');
    expect(watch).toContain('if (window.history.length > 1)');
    expect(watch).toContain('router.back()');
    expect(watch).toContain("router.push('/')");
  });
  it('shows evidence-ranked playback recommendations and routes the exact candidate through the shared detail center', () => {
    expect(movieWorkflow).toContain('playback: `${prefix}.playback`');
    expect(movieWorkflow).toContain('agent: "playback-agent"');
    expect(movieAgents).toContain('id: "playback-agent"');
    expect(movieAgents).toContain('"decoded-playback" as const');
    expect(movieAgents).toContain('"source-probe" as const');
    expect(movieAgents).toContain('assessmentEvidenceRank');
    expect(movieAgents).toContain('requiresUserConfirmation: true');
    expect(fridayConversation).toContain('workflow.playbackRecommendations');
    expect(fridayConversation).toContain('movies.find((item) => `${item.sourceKey}:${item.vodId}` === recommendation.candidateId)');
    expect(fridayConversation).toContain('onOpenMovie(movie)');
  });

  it('starts homepage voice recognition directly from the orb gesture without a wake-audio fetch', () => {
    expect(assistant).toContain('window.addEventListener("friday-home-orb-toggle", handleHomeOrbToggle)');
    expect(assistant).toContain('startListening(false)');
    expect(assistant).toContain('setVoiceSession(true)');
    expect(assistant).toContain('stopRecognition(true)');
    expect(assistant).not.toContain('homeWakeAudioRef');
    expect(assistant).not.toContain('homeWakeUrlRef');
  });


  it('V3 首页采用 Jarvis 式单圆球入口：回复与语音状态回到圆球，不挂载独立 AI 面板', () => {
    expect(header).toContain('<AIFloatingBall showFab={showFridayFab} inlineMode />');
    expect(watch).toContain('<AIFloatingBall inlineMode showFab={false} />');
    expect(watch).not.toContain('FridayPlayerAssistantButton');
    expect(assistant).toContain('if (inlineMode) {');
    expect(assistant).toContain('if (!showFab) return null;');
    expect(assistant).toContain('onClick={openAndListen}');
    expect(assistant).toContain('friday-home-assistant-response');
    expect(hero).toContain('friday-home-assistant-response');
    expect(hero).toContain('friday-orb-response');
    expect(hero).toContain('friday-home-orb-toggle');
  });

  it('首页圆球订阅真实语音状态和音量事件，而不是永久停留在默认空闲态', () => {
    expect(assistant).toContain('friday-home-voice-state');
    expect(assistant).toContain('friday-audio-level');
    expect(hero).toContain("window.addEventListener('friday-home-voice-state', onVoiceState)");
    expect(hero).toContain("window.addEventListener('friday-audio-level', onAudioLevel)");
    expect(hero).toContain('setRuntimeVoiceState(next[normalized])');
    expect(hero).toContain('setRuntimeAudioLevel(Math.max(0, Math.min(1, value)))');
    expect(canvas).toContain('voiceState, audioLevel');
  });

  it('设置中可选择界面语言、助手角色和语音风格，顶部搜索默认收起', () => {
    expect(settings).toContain("{ id: 'language', label: '语言设置', detail: '界面语言与显示偏好'");
    expect(settings).toContain('function LanguageSettingsPanel()');
    expect(settings).toContain('label="界面语言"');
    expect(settings).toContain('label="助手角色"');
    expect(settings).toContain('label="启用唤醒词确认"');
    expect(header).toContain('home-v2-mobile-search-toggle');
    expect(header).toContain('home-v2-header-search-slot');
    expect(header).toContain('is-open');
  });

  it('播放实测证据任务中断后可从独立 checkpoint 安全恢复', () => {
    expect(chatSession).toContain('taskId.endsWith(".playback-evidence")');
    expect(chatSession).toContain('createPlaybackEvidenceAgent()');
    expect(chatSession).toContain('replayFailed: true');
  });

  it('默认清晰度设置持久化并限制 HLS 自适应档位', () => {
    expect(settings).toContain('label="默认清晰度"');
    expect(settings).toContain('libretv-quality-preference');
    expect(player).toContain('applyHlsQualityPreference(hls!, readQualityPreference(), video)');
    expect(player).toContain('autoLevelCapping');
    expect(player).toContain('hls.currentLevel = selection.selectedIndex');
    expect(player).toContain('libretv-quality-preference-change');
    expect(player).toContain('video.videoHeight');
    expect(player).toContain('networkQualityWarning');
    expect(player).toContain('源站 4K：');
    expect(player).toContain('Safari 会自行选择档位');
  });

  it('Friday 语音识别语言设置实际写入浏览器 ASR 实例', () => {
    expect(settings).toContain('label="语音识别语言"');
    expect(settings).toContain('friday-asr-language');
    expect(voiceController).toContain('preferredRecognitionLanguage');
    expect(voiceController).toContain('recognition.lang = preferredRecognitionLanguage');
    expect(browserAsr).toContain('window.webkitSpeechRecognition');
  });

  it('设置页直接内嵌完整设置模块，不再显示冗余入口按钮', () => {
    expect(glassStyles).toContain('.v4-brand-mark');
    expect(settingsModule).toContain('onOpen');
    expect(v4Header).not.toContain('<SettingsModule');
    expect(v4Header).toContain('<SourceManagerDrawer');
    expect(spatialScreenSource).toContain("screen === 'settings'");
    expect(spatialScreenSource).not.toContain('打开完整设置');
    expect(spatialScreenSource).toContain('<SourceManagerDrawer open embedded');
  });

  it('浅色、深色与系统主题均有显式选择，并提供浅色毛玻璃表面', () => {
    expect(theme).toContain("{ value: 'light', label: '浅色' }");
    expect(theme).toContain("{ value: 'dark', label: '深色' }");
    expect(theme).toContain("{ value: 'system', label: '跟随系统' }");
    expect(theme).toContain('function readStoredTheme()');
    expect(theme).toContain('media.addListener(onChange)');
    expect(theme).toContain('persistTheme(t)');
    expect(settings).toContain('浅色、深色与系统外观');
    expect(settings).toContain('<ThemeToggle />');
    expect(settings).toContain("activePage === 'appearance'");
    expect(settings).toContain('浅色、深色，或跟随设备系统设置');
    expect(glassStyles).toContain('html:not(.dark)');
    expect(glassStyles).toContain('linear-gradient(145deg,#f7f8fa 0%,#e9edf2 100%)');
  });


  it('V4 空间频道与首页共用根布局样式，客户端路由切换不会卸载频道 CSS', () => {
    expect(rootLayout).toContain("import './v4-homepage.css'");
    expect(home).not.toContain("import './v4-homepage.css'");
    expect(channelStyles).toContain('.v4-spatial-screen');
    expect(channelStyles).toContain('.v4-spatial-main');
    expect(homepageHeroStyles).toContain('.v4-header-inner');
    expect(spatialScreen).toContain('<V4HomepageHeader />');
  });

  it('电影与动漫频道不预留不存在的 Banner 空间，导航保持文档流并兼容 Safari', () => {
    expect(spatialScreen).toContain('<V4HomepageHeader />');
    expect(spatialScreen).toContain('<main className="v4-spatial-main">');
    expect(spatialScreen).not.toContain('<V4HomepageHero');
    expect(channelStyles).toContain('.v4-spatial-screen > .v4-header');
    expect(channelStyles).toContain('position: -webkit-sticky');
    expect(channelStyles).toContain('padding-block-start: clamp(20px, 2.5vw, 32px)');
    expect(channelStyles).toContain('@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))');
    expect(channelHeaderStyles).toContain('background: rgba(246, 248, 251, 0.88)');
    expect(channelHeaderStyles).toContain('background: rgba(35,45,60,.09)');
  });

  it('首页精选 Banner 始终使用渐变遮罩与白色文案，并保留无数据占位高度', () => {
    expect(featuredHero).toContain('<div className="v4-hero-veil"');
    expect(featuredHero).toContain('v4-hero-empty');
    expect(homepageHeroStyles).toContain('.v4-home .v4-hero-veil');
    expect(homepageHeroStyles).toContain('rgba(4, 8, 15, .94)');
    expect(homepageHeroStyles).toContain('-webkit-text-fill-color: #fff');
  });


  it('Preview 必须保持密码保护，且部署前先通过完整检查', () => {
    expect(previewConfig).toContain('AUTH_DISABLED = "false"');
    expect(previewWorkflow).toContain('workflow_dispatch:');
    expect(previewWorkflow).toContain('  push:');
    expect(previewWorkflow).toContain('feature/libretv-eight-screen-glass-2026-11-09');
    expect(previewWorkflow).toContain('run: npm test -- --reporter=dot');
    expect(previewWorkflow).toContain('Verify preview authentication remains enabled');
    expect(previewWorkflow).toContain('Deploy password-protected isolated preview Worker');
    expect(previewWorkflow).toContain('password-protected');
    expect(previewWorkflow).not.toContain('Deploy isolated public preview Worker');
  });

  it('设置页直接展示全部二级设置并复用现有设置面板', () => {
    expect(spatialScreen).toContain('<SourceManagerDrawer open embedded');
    expect(settings).toContain('embedded = false');
    expect(settings).toContain("{ id: 'playback', label: '播放与过滤'");
    expect(settings).toContain("{ id: 'image', label: '封面图加载'");
    expect(settings).toContain("{ id: 'live', label: '直播源管理'");
    expect(settings).toContain("{ id: 'subs', label: '资源订阅'");
    expect(settings).toContain("{ id: 'cache', label: '本机缓存'");
    expect(settings).toContain("{ id: 'collector', label: '资源采集中心'");
    expect(settings).toContain("activePage === 'voice' && <VoiceSettingsPanel />");
    expect(settings).toContain("activePage === 'about'");
  });

  it('彻底下线 SeedHub 批量采集，并将下载管理固定在设置页最底部', () => {
    const settingsScreen = spatialScreen.slice(spatialScreen.indexOf('function SettingsScreen()'));
    expect(settingsScreen).not.toContain('SeedHubCollectorPanel');
    expect(settingsScreen).not.toContain('seedhubSync');
    expect(settingsScreen.indexOf('<SourceManagerDrawer open embedded')).toBeLessThan(
      settingsScreen.indexOf('settings-downloads-title'),
    );
    expect(settingsScreen.lastIndexOf('settings-downloads-title')).toBeGreaterThan(
      settingsScreen.lastIndexOf('<section'),
    );

    expect(resourceStudio).not.toContain('syncSeedHub');
    expect(spatialScreenSource).not.toContain('请先到设置中的 SeedHub 内容采集');
    expect(resourceStudio).not.toContain('SeedHub');
    expect(resourceAgentRoute).not.toContain('seedhub_sync');
    expect(resourceCollectorRoute).not.toContain('seedhubSync');
    expect(resourceCollectorRoute).not.toContain('data/seedhub/');
    expect(resourceCollectorRoute).not.toContain('seedhubSnapshots');
    expect(existsSync(resolve(process.cwd(), 'data/seedhub/movies.json'))).toBe(false);
    expect(existsSync(resolve(process.cwd(), 'data/seedhub/series.json'))).toBe(false);
    expect(existsSync(resolve(process.cwd(), 'data/seedhub/anime.json'))).toBe(false);
    expect(collectorWorker).not.toContain('seedhub_sync');
    expect(collectorWorker).not.toContain('seedhub_detail_sync');
    expect(seedhubCollector).not.toContain('sync_seedhub_pages');
    expect(seedhubCollector).not.toContain('sync_seedhub_details');
    expect(seedhubCollector).not.toContain('/v1/seedhub/sync');
    expect(collectorQueue).toContain('seedhub_collection_retired');
    expect(collectorQueue).toContain('job_type not in {"crawl", "discover"}');
  });

  it('首页与分类页底部导航固定在视口水平居中，并避开 iPhone 安全区域', () => {
    const tabBar = source('src/components/home/header/MobileTabBar.tsx');
    expect(categoryPage).toContain('<V4HomepageHeader />');
    expect(tabBar).toContain('className={active ? \'is-active\' : \'\'}');
    const dockStyles = source('src/app/pr84-apple-tv-dock.css');
    expect(dockStyles).toContain('> nav.v4-mobile-tabbar {');
    expect(dockStyles).toContain('position: fixed !important;');
    expect(dockStyles).toContain('inset: auto 0 0 0 !important;');
    expect(dockStyles).toContain('width: 100% !important;');
    expect(dockStyles).toContain('bottom: 0 !important;');
    expect(dockStyles).toContain('var(--safe-area-bottom)');
    expect(tabBar).toContain("className={active ? 'is-filled' : ''}");
    expect(tabBar).toContain('{active && <i aria-hidden="true" />}');
  });

  it('移动端七项底部导航可横向滚动，不压缩或换行', () => {
    expect(channelStyles).toContain('.v4-mobile-tabs {');
    expect(channelStyles).toContain('overflow-x: auto !important');
    expect(channelStyles).toContain('white-space: nowrap');
    expect(channelStyles).toContain('flex: 0 0 auto !important');
  });

  it('页面允许用户缩放，避免移动端强制禁止放大', () => {
    expect(rootLayout).not.toContain('maximumScale: 1');
    expect(rootLayout).not.toContain('userScalable: false');
  });


  it('iPad 横屏资源页只对资源内容区应用双栏布局，不把页面标题塞进网格', () => {
    expect(spatialScreen).toContain('className="v4-resources-layout space-y-5"');
    expect(ipadStyles).toContain('.v4-spatial-screen[data-screen="resources"] .v4-resources-layout');
    expect(ipadStyles).not.toContain('.v4-spatial-screen[data-screen="resources"] .v4-spatial-main > div');
    expect(ipadStyles).toContain('.v4-spatial-screen[data-screen="movies"] .v4-spatial-panel > .grid.grid-cols-3');
    expect(ipadStyles.match(/\.v4-spatial-screen\[data-screen="movies"\] \.v4-spatial-panel > \.grid\.grid-cols-3/g)).toHaveLength(2);
  });


  it('播放页进度条使用唯一的 16px seek 热区、2px 轨道和 6px 播放头', () => {
    expect(watchStyles).toContain('PR84 single source of truth for ArtPlayer timeline geometry');
    expect(watchStyles).toContain('height: 16px !important;');
    expect(watchStyles).toContain('height: 2px !important;');
    expect(watchStyles).toContain('rgba(255,255,255,.42)');
    expect(watchStyles).toContain('width: 6px !important;');
    expect(watchStyles).not.toContain('margin-block: -4px !important;');
  });

  it('无 vodId 的直连视频也能保存、恢复和清理播放进度', () => {
    expect(watch).toContain('const progressId = vodId || currentUrl');
    expect(watch).toContain('progressKeyOf(sourceKey, progressId, currentIndex)');
    expect(watch).toContain('saveProgress(\n        sourceKey,\n        progressId');
    expect(watch).toContain('clearProgress(sourceKey, progressId, currentIndex)');
  });


  it('精选轮播数据缩减时仍有有效选中项，加载失败可重试', () => {
    expect(featuredHero).toContain('activeSlide % slides.length');
    expect(featuredHero).toContain('aria-pressed={normalizedActiveSlide === index}');
    expect(featuredHero).toContain('featuredQuery.refetch()');
  });


  it('iOS Safari 模态抽屉锁定背景滚动并在关闭后恢复页面位置', () => {
    expect(drawer).toContain("body.style.position = 'fixed'");
    expect(drawer).toContain('body.style.top = `-${scrollY}px`');
    expect(drawer).toContain('window.scrollTo(0, scrollY)');
    expect(drawer).toContain('if (!mounted || !modal) return;');
  });


  it('紧凑桌面窗口宽度下 Header 三列布局不会挤出视口', () => {
    expect(homepageHeroStyles).toContain('@media screen and (min-width: 1101px) and (max-width: 1180px)');
    expect(homepageHeroStyles).toContain('grid-template-columns: minmax(150px, .7fr) auto minmax(300px, .9fr)');
  });
  it('iPad 13 英寸横屏宽视口仍命中平板专属布局', () => {
    expect(ipadStyles).toContain('max-width: 1440px');
    expect(ipadStyles).toContain('(any-pointer: coarse)');
    expect(ipadStyles).toContain('orientation: landscape');
    expect(rootLayout).toContain("import './ipad-glass.css'");
  });



  it('影视收藏按资源站与影片 ID 独立存储，并连接卡片和个人中心', () => {
    expect(database).toContain('favorites: EntityTable<FavoriteEntry, \'id\'>');
    expect(database).toContain('db.version(6).stores({');
    expect(database).toContain('export async function addFavorite');
    expect(database).toContain('export async function removeFavorite');
    expect(videoCards).toContain('aria-pressed={isFavorite}');
    expect(videoCards).toContain('addFavorite({');
    expect(videoCards).toContain('toggleItemFavorite(item, event)');
    expect(videoCards).toContain('aria-pressed={itemFavorite}');
    expect(videoCards).toContain('const favoriteCandidate = multi ? group.items[0] : sortedItems[0]');
    expect(videoCards).toContain('favoriteCandidate?.sourceName');
    expect(spatialScreenSource).toContain('影视收藏');
    expect(spatialScreenSource).toContain('MeFavoriteCard');
  });

  it('搜索页面显示独立结果入口及可重试错误状态', () => {
    expect(searchPageSource).toContain('/search/results?q=');
    expect(searchResultsSource).toContain("import HomePage from '@/app/page'");
    expect(home).toContain('searchQuery.isError || failures.length > 0');
    expect(home).toContain('重试搜索');
  });

  it('iPad 适配覆盖 1440px 宽屏触控设备，并分别定义横竖屏布局', () => {
    expect(ipadStyles).toContain('(min-width: 701px) and (max-width: 1440px) and (any-pointer: coarse)');
    expect(ipadStyles).toContain('(max-width: 1440px) and (any-pointer: coarse) and (orientation: portrait)');
    expect(ipadStyles).toContain('(min-width: 1024px) and (max-width: 1440px) and (any-pointer: coarse) and (orientation: landscape)');
    expect(rootLayout).toContain("width: 'device-width'");
    expect(rootLayout).not.toContain('maximumScale: 1');
  });

});
