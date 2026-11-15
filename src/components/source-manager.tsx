'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { Drawer } from './drawer';
import { ConfirmDialog } from './confirm-dialog';
import { Dropdown, type DropdownOption } from './dropdown';
import { Icon, type IconName } from './icon';
import { LiveSourceManager } from './live-source-manager';
import { ThemeToggle } from './theme';
import {
  HealthBadge,
  SearchInput,
  SectionTitle,
  SelectRow,
  TestBadge,
  ToggleRow,
  Switch,
  useSourceTests,
  type TestState,
} from './settings-shared';
import { loadCacheSettings, saveCacheSettings, getCacheSummary, clearVideoCache, type CacheSummary } from '@/lib/video-cache';
import { isCandidatePreviewEligible } from '@/lib/collector-playback-eligibility';
import { EmptyState, Spinner } from './states';
import { useSourceProbe } from './use-source-probe';
import { allLiveSources, isSourceDisabled, keyBelongsToSubscription, resolveSource, subKeyPrefix, useAppStore } from '@/lib/store';
import type { SourceConfig } from '@/lib/types';
import { useToast } from './toast';
import { formatRelativeTime, hostnameOf, validateSourceUrl, cn } from '@/lib/utils';
import { exportConfig, importConfig } from '@/lib/db';
import { PERSIST_KEY } from '@/lib/persist-storage';
import { copyToClipboard } from '@/lib/clipboard';
import { useAuth } from './auth';
import { api } from '@/lib/client-api';
import { AUTO_REFRESH_MAX_FAIL_STREAK, syncSourceSubscription } from '@/lib/subscription-sync';
import { describeParseStats } from '@/lib/tvbox-parser';
import { collectorFetch, clearScraplingConfig, normalizeScraplingBase, readScraplingConfig, saveScraplingConfig } from '@/lib/collector-browser-config';
import { registerValidatedCmsSource } from '@/lib/resource-collector-workflow';
import { ResourceStatsPanel } from '@/components/resource-stats-panel';
import { requestShowDownloadManager } from '@/components/download-manager';


const CollectorPlayerShell = dynamic(
  () => import('@/components/player-shell').then((module) => module.PlayerShell),
  { ssr: false, loading: () => <div className="aspect-video w-full animate-pulse bg-black" /> },
);

/**
 * Apple-inspired 设置抽屉：纵向分组首页 → 独立详情页。
 * 具体设置面板继续复用现有业务组件与持久化逻辑。
 */
type SecondaryTab = 'vod' | 'live' | 'subs' | 'playback' | 'image' | 'home' | 'voice' | 'language' | 'io' | 'cache' | 'collector' | 'downloads';
type SettingsPage = SecondaryTab | 'index' | 'appearance' | 'about';

const SETTINGS_SECTIONS: { title: string; color: string; items: { id: SettingsPage; label: string; detail: string; icon: IconName }[] }[] = [
  { title: '播放设置', color: '#32D7A0', items: [
    { id: 'playback', label: '播放与过滤', detail: '默认画质、自动连播、片段跳过与缓存', icon: 'play' },
    { id: 'downloads', label: '下载管理', detail: '查看下载任务、真实进度与保存状态', icon: 'download' },
  ] },
  { title: '资源站', color: '#55A7FF', items: [
    { id: 'vod', label: '点播源管理', detail: '资源站、优先级与健康检测', icon: 'database' },
    { id: 'live', label: '直播源管理', detail: '直播源与频道管理', icon: 'radio' },
    { id: 'subs', label: '资源订阅', detail: '管理已配置的数据源订阅', icon: 'rss' },
  ] },
  { title: '外观设置', color: '#BF91FF', items: [
    { id: 'appearance', label: '外观模式', detail: '浅色、深色与系统外观', icon: 'palette' },
    { id: 'image', label: '封面图加载', detail: '海报与图片加载偏好', icon: 'image' },
    { id: 'language', label: '语言设置', detail: '界面语言与显示偏好', icon: 'languages' },
    { id: 'home', label: '首页与内容', detail: '首页展示与内容偏好', icon: 'house' },
  ] },
  { title: 'Friday AI', color: '#E7A0D7', items: [
    { id: 'voice', label: 'Friday 语音', detail: '助手角色、语音音色与对话偏好', icon: 'audio-lines' },
  ] },
  { title: '隐私与数据', color: '#E8B45E', items: [
    { id: 'io', label: '配置导入与导出', detail: '备份或恢复本机配置', icon: 'shield-check' },
    { id: 'cache', label: '本机缓存', detail: '查看和管理本机视频缓存', icon: 'database-backup' },
  ] },
  { title: '网络连接', color: '#62C8D5', items: [
    { id: 'collector', label: '资源采集中心', detail: 'FMHY 目录、Collector 地址与连接测试', icon: 'network' },
  ] },
  { title: '关于 LibreTV', color: '#A6ADB8', items: [
    { id: 'about', label: '关于 LibreTV', detail: '项目简介与版本信息', icon: 'info' },
  ] },
];

const SETTINGS_PAGE_META: Record<Exclude<SettingsPage, 'index'>, { title: string; description: string }> = {
  appearance: { title: '外观', description: '自定义 LibreTV 的显示方式。' },
  playback: { title: '播放设置', description: '管理播放体验、画质与内容过滤。' },
  downloads: { title: '下载管理', description: '查看下载任务、进度、失败原因与文件保存状态。' },
  image: { title: '封面图加载', description: '管理海报和图片的加载行为。' },
  language: { title: '语言设置', description: '选择界面与助手使用的语言。' },
  vod: { title: '影视源管理', description: '管理点播来源及其可用状态。' },
  live: { title: '直播设置', description: '管理直播来源与频道。' },
  subs: { title: '资源订阅', description: '管理已经配置的数据源订阅。' },
  home: { title: '首页与内容', description: '调整首页展示和内容偏好。' },
  voice: { title: '语音与声音', description: '配置 Friday 的语音识别和声音偏好。' },
  io: { title: '配置导入与导出', description: '备份或恢复 LibreTV 本机配置。' },
  cache: { title: '本机缓存', description: '查看并管理本机缓存数据。' },
  collector: { title: '采集服务连接', description: '配置 Collector 地址、认证信息并测试连接。' },
  about: { title: '关于 LibreTV', description: 'LibreTV 是一个以本机配置和个人观影体验为核心的影视浏览与播放界面。' },
};

const SETTINGS_PAGE_ICONS: Record<Exclude<SettingsPage, 'index'>, { icon: IconName; color: string }> = {
  playback: { icon: 'play', color: '#32D7A0' },
  downloads: { icon: 'download', color: '#32D7A0' },
  vod: { icon: 'database', color: '#55A7FF' },
  live: { icon: 'radio', color: '#55A7FF' },
  subs: { icon: 'rss', color: '#55A7FF' },
  appearance: { icon: 'palette', color: '#BF91FF' },
  image: { icon: 'image', color: '#BF91FF' },
  language: { icon: 'languages', color: '#BF91FF' },
  home: { icon: 'house', color: '#BF91FF' },
  voice: { icon: 'audio-lines', color: '#E7A0D7' },
  io: { icon: 'shield-check', color: '#E8B45E' },
  cache: { icon: 'database-backup', color: '#E8B45E' },
  collector: { icon: 'network', color: '#62C8D5' },
  about: { icon: 'info', color: '#A6ADB8' },
};

const SETTINGS_OPEN_PAGE_KEY = 'libretv-settings-open-page';

export function SourceManagerDrawer({ open, onClose, embedded = false }: { open: boolean; onClose: () => void; embedded?: boolean }) {
  const [activePage, setActivePage] = useState<SettingsPage>('index');

  useEffect(() => {
    if (!open) return;
    let nextPage: SettingsPage = 'index';
    try {
      const requestedPage = window.localStorage.getItem(SETTINGS_OPEN_PAGE_KEY);
      if (requestedPage && Object.prototype.hasOwnProperty.call(SETTINGS_PAGE_META, requestedPage)) {
        nextPage = requestedPage as SettingsPage;
      }
      window.localStorage.removeItem(SETTINGS_OPEN_PAGE_KEY);
    } catch {
      // Storage may be unavailable in private browsing; keep the settings index usable.
    }
    setActivePage(nextPage);
  }, [open]);

  const pageTitle = activePage === 'index' ? '设置' : SETTINGS_PAGE_META[activePage].title;

  const settingsContent = (
    <>
      {activePage === 'index' ? (
        <>
        <header className="settings-large-title">
          <h1>设置</h1>
          <p>管理 LibreTV 的外观、播放与资源偏好。</p>
        </header>
        <div className="ipad-settings-content mx-auto w-full max-w-2xl space-y-7 pb-3">
          {SETTINGS_SECTIONS.map((section) => (
            <section key={section.title} className="space-y-2">
              <h3 className="px-1 text-xs font-semibold tracking-wide text-muted">{section.title}</h3>
              <div className="overflow-hidden rounded-2xl border border-line bg-card divide-y divide-line">
                {section.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="group flex min-h-[68px] w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
                    onClick={() => item.id === 'downloads' ? requestShowDownloadManager() : setActivePage(item.id)}
                    aria-label={item.label}
                  >
                    <span className="settings-apple-icon" style={{ color: section.color }}>
                      <Icon name={item.icon} className="h-5 w-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-content">{item.label}</span>
                      <span className="mt-0.5 block text-xs text-muted">{item.detail}</span>
                    </span>
                    <span aria-hidden="true" className="shrink-0 text-xl leading-none text-[#8E8E93] transition-transform group-hover:translate-x-0.5">›</span>
                  </button>
                ))}
              </div>
            </section>
          ))}
          <p className="px-1 text-center text-xs text-faint">LibreTV · 本机设置</p>
        </div>
        </>
      ) : (
        <>
        <header className="settings-nav-bar">
          <button type="button" className="settings-nav-back" onClick={() => setActivePage('index')} aria-label="返回设置">
            <span aria-hidden="true">‹</span><span>设置</span>
          </button>
          <span className="settings-nav-center">设置</span>
        </header>
        <div className="ipad-settings-content settings-apple-detail mx-auto w-full max-w-2xl space-y-5 pb-3">
          <div className="settings-apple-detail-heading space-y-1 border-b border-line pb-4">
            <div className="settings-apple-page-title">
              <span className="settings-apple-icon" style={{ color: SETTINGS_PAGE_ICONS[activePage].color }}>
                <Icon name={SETTINGS_PAGE_ICONS[activePage].icon} className="h-5 w-5" />
              </span>
              <h2 className="text-2xl font-semibold tracking-tight text-content">{pageTitle}</h2>
            </div>
            <p className="text-sm text-muted">{SETTINGS_PAGE_META[activePage].description}</p>
          </div>
          {activePage === 'appearance' && (
            <section className="rounded-2xl border border-line bg-card p-4">
              <div className="mb-3">
                <h3 className="text-sm font-semibold text-content">外观模式</h3>
                <p className="mt-1 text-xs text-muted">选择浅色、深色，或跟随设备系统设置。</p>
              </div>
              <ThemeToggle />
            </section>
          )}
          {activePage === 'vod' && <VodSourcesPanel />}
          {activePage === 'live' && <LiveSourceManager />}
          {activePage === 'playback' && <PlaybackPanel />}
          {activePage === 'image' && <ImagePanel />}
          {activePage === 'home' && <HomePanel />}
          {activePage === 'voice' && <VoiceSettingsPanel />}
          {activePage === 'language' && <LanguageSettingsPanel />}
          {activePage === 'subs' && <SourceSubscriptions />}
          {activePage === 'io' && <ConfigIoPanel />}
          {activePage === 'cache' && <VideoCachePanel />}
          {activePage === 'collector' && <ResourceCollectorPanel />}
          {activePage === 'about' && <section className="settings-apple-about"><h3>LibreTV</h3><p>为个人观影而设计的开放式影视浏览与播放体验。</p><p className="settings-apple-about-note">播放记录、收藏与偏好设置按现有功能保存在当前设备；资源站和网络连接由你配置与管理。</p></section>}
        </div>
        </>
      )}
    </>
  );

  if (embedded) {
    return <div className="settings-embedded-root" data-settings-embedded="true">{settingsContent}</div>;
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="设置"
      width="max-w-2xl ipad-settings-drawer"
      resetScrollKey={activePage}
    >
      {settingsContent}
    </Drawer>
  );
}


type CollectorSite = { title: string; url: string; host: string; directory: string };
type CollectorCandidate = { id?: string; url: string; kind: string; host: string; title?: string; status?: string; access_state?: string; reason?: string; next_action?: string; drm_systems?: string[]; validation?: { cms_shape?: boolean; reachable?: boolean | null; public_host?: boolean; source_url?: string | null; note?: string; media_format?: string; content_type?: string; manifest_valid?: boolean; rejected_reference_count?: number; access?: { access_state?: string; reason?: string } } };
type CollectorTask = { id: string; url: string; host: string; status: string; created_at: number; updated_at: number; error?: string | null; result_count: number };
type CollectorJob = { id: string; job_type: string; status: string; error?: string | null; created_at: number; updated_at: number };

function ResourceCollectorPanel() {
  const store = useAppStore();
  const [centerPage, setCenterPage] = useState<string>('index');
  const [sites, setSites] = useState<CollectorSite[]>([]);
  const [selectedSite, setSelectedSite] = useState<CollectorSite | null>(null);
  const [playingCandidate, setPlayingCandidate] = useState<CollectorCandidate | null>(null);
  const [candidates, setCandidates] = useState<CollectorCandidate[]>([]);
  const [tasks, setTasks] = useState<CollectorTask[]>([]);
  const [seedHubJobs, setSeedHubJobs] = useState<CollectorJob[]>([]);
  const [seedHubPages, setSeedHubPages] = useState(50);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [resultMessage, setResultMessage] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [collectorBase, setCollectorBase] = useState('');
  const [collectorToken, setCollectorToken] = useState('');
  const [showCollectorToken, setShowCollectorToken] = useState(false);
  const [configSaved, setConfigSaved] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState('');
  const [crawlDiagnostics, setCrawlDiagnostics] = useState<{
    pageTitle?: string; finalUrl?: string; mode?: string; capturedRequestCount?: number;
    httpSpider?: { status?: string; candidate_count?: number; error?: string | null };
    browser?: { status?: string; candidate_count?: number; error?: string | null };
    errors?: string[];
  } | null>(null);

  useEffect(() => {
    const config = readScraplingConfig();
    setCollectorBase(config.base);
    setCollectorToken(config.token);
    setConfigSaved(Boolean(config.base && config.token));
  }, []);

  const saveCollectorSettings = () => {
    try {
      const base = normalizeScraplingBase(collectorBase);
      saveScraplingConfig({ base, token: collectorToken });
      setCollectorBase(base);
      setConfigSaved(true);
      setConnectionStatus('配置已保存在当前浏览器。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '配置保存失败。');
    }
  };

  const clearCollectorSettings = () => {
    clearScraplingConfig();
    setCollectorBase('');
    setCollectorToken('');
    setConfigSaved(false);
    setConnectionStatus('本机配置已清除，将回退到服务端环境变量（如已配置）。');
  };

  const testCollectorConnection = async () => {
    setTestingConnection(true);
    setConnectionStatus('正在测试 Collector 连接…');
    setError('');
    try {
      const base = normalizeScraplingBase(collectorBase);
      if (!collectorToken.trim()) throw new Error('请先填写 SCRAPLING_API_TOKEN。');
      saveScraplingConfig({ base, token: collectorToken });
      setCollectorBase(base);
      setConfigSaved(true);
      const response = await collectorFetch('/api/resource-collector/health');
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail = typeof payload.detail === 'string' ? payload.detail :
          typeof payload.error === 'string' ? payload.error : '未提供错误详情';
        const statusHint = response.status === 401 ? '请先登录 LibreTV。' :
          response.status === 403 ? '当前 Preview 策略禁止访问资源采集功能。' :
          response.status === 503 ? '检查 Collector 地址、Token 配置及服务端出口闸门。' :
          response.status === 502 ? '检查 Collector 网络连通性、TLS 和响应格式。' : '';
        throw new Error(`连接测试失败（HTTP ${response.status}）：${detail}${statusHint ? `。${statusHint}` : ''}`);
      }
      if (payload.ok !== true) throw new Error('Collector 已响应，但健康状态未确认（缺少 ok=true）。');

      // /health is intentionally public and does not validate the configured bearer token.
      // /v1/tasks is authenticated but read-only and does not trigger external crawling.
      const authResponse = await collectorFetch('/api/resource-collector/tasks', { cache: 'no-store' });
      const authPayload = await authResponse.json().catch(() => ({}));
      if (!authResponse.ok) {
        const detail = typeof authPayload.detail === 'string' ? authPayload.detail :
          typeof authPayload.error === 'string' ? authPayload.error : '未提供错误详情';
        const authHint = authResponse.status === 401 ? 'Collector 拒绝了 Token，请核对 SCRAPLING_API_TOKEN。' :
          authResponse.status === 403 ? 'Preview 认证策略拒绝了资源采集请求，请确认已登录受保护 Preview。' :
          authResponse.status === 503 ? 'Collector 服务端配置或安全出口闸门未就绪。' : '';
        throw new Error(`健康检查通过，但 Token/采集 API 验证失败（HTTP ${authResponse.status}）：${detail}${authHint ? `。${authHint}` : ''}`);
      }
      if (!Array.isArray(authPayload.tasks)) throw new Error('Collector Token 已接受，但任务 API 返回格式不正确。');
      setConnectionStatus('连接成功：Collector 健康检查和 Token 认证均通过。');
    } catch (reason) {
      setConnectionStatus('连接测试未通过。');
      setError(reason instanceof Error ? reason.message : 'Collector 连接测试失败。');
    } finally {
      setTestingConnection(false);
    }
  };

  const loadSeedHubJobs = async () => {
    try {
      const response = await collectorFetch('/api/resource-collector?action=jobs&limit=50', { cache: 'no-store' });
      const payload = await response.json();
      if (response.ok) setSeedHubJobs(Array.isArray(payload.jobs)
        ? payload.jobs.filter((job: CollectorJob) => job.job_type === 'seedhub_sync' || job.job_type === 'seedhub_detail_sync').slice(0, 8)
        : []);
    } catch {
      // Job history is optional; a failed refresh must not hide the collection controls.
    }
  };

  const syncSeedHub = async (category: 'movies' | 'series' | 'anime') => {
    setBusy(true);
    setError('');
    setResultMessage('正在提交 SeedHub 目录采集任务…');
    try {
      const response = await collectorFetch('/api/resource-collector', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          seedhubSync: true,
          category,
          startPage: 1,
          pages: seedHubPages,
          idempotencyKey: `seedhub:${category}:${Date.now()}`,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || payload.detail || `SeedHub 任务提交失败（HTTP ${response.status}）。`);
      setResultMessage(`SeedHub ${category === 'movies' ? '电影' : category === 'series' ? '电视剧' : '动漫'}目录采集任务已提交（${payload.id || payload.job_id || '已排队'}）。请在下方刷新任务状态。`);
      await loadSeedHubJobs();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'SeedHub 目录采集任务提交失败。');
      setResultMessage('');
    } finally {
      setBusy(false);
    }
  };

  const syncAllSeedHub = async () => {
    setBusy(true);
    setError('');
    setResultMessage('正在提交电影、电视剧和动漫三个目录的全量分页采集任务…');
    try {
      const categories = ['movies', 'series', 'anime'] as const;
      const results = await Promise.all(categories.map(async (category) => {
        const response = await collectorFetch('/api/resource-collector', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            seedhubSync: true,
            category,
            startPage: 1,
            pages: seedHubPages,
            idempotencyKey: `seedhub:${category}:all:${Date.now()}`,
          }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || payload.detail || `SeedHub ${category} 任务提交失败（HTTP ${response.status}）。`);
        return payload;
      }));
      setResultMessage(`已提交三个分类的采集任务（${results.map((item) => item.id || item.job_id || '已排队').join('、')}）。后台将自动分页推进至目录末页，并持续补全详情。`);
      await loadSeedHubJobs();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'SeedHub 全分类任务提交失败。');
      setResultMessage('');
    } finally {
      setBusy(false);
    }
  };

  const loadTasks = async () => {
    try {
      const response = await collectorFetch('/api/resource-collector/tasks', { cache: 'no-store' });
      const payload = await response.json();
      if (response.ok) setTasks(Array.isArray(payload.tasks) ? payload.tasks : []);
    } catch {
      // Keep the discovery and collection panel usable if task history is temporarily unavailable.
    }
  };

  useEffect(() => { void loadTasks(); }, []);

  const discover = async () => {
    setBusy(true);
    setError('');
    setSelectedSite(null);
    setCandidates([]);
    try {
      const response = await collectorFetch('/api/resource-collector', { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'FMHY 目录加载失败。');
      setSites(Array.isArray(payload.sites) ? payload.sites : []);
      setLoaded(true);
      await loadTasks();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法连接资源采集服务。');
    } finally {
      setBusy(false);
    }
  };

  const crawl = async (site: CollectorSite) => {
    setBusy(true);
    setError('');
    setResultMessage('');
    setSelectedSite(site);
    setCandidates([]);
    try {
      const response = await collectorFetch('/api/resource-collector', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: site.url }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || payload.detail || `Scrapling 采集失败（HTTP ${response.status}）。`);
      const discoveredCandidates: CollectorCandidate[] = Array.isArray(payload.candidates) ? payload.candidates : [];
      setCandidates(discoveredCandidates);
      setCrawlDiagnostics({
        pageTitle: payload.page_title, finalUrl: payload.final_url || payload.page_url,
        mode: payload.mode, capturedRequestCount: payload.captured_request_count,
        httpSpider: payload.diagnostics?.http_spider, browser: payload.diagnostics?.browser,
        errors: Array.isArray(payload.errors) ? payload.errors : [],
      });
      await loadTasks();
      const cmsCandidates = discoveredCandidates.filter((candidate) => candidate.kind === 'cms-api-candidate');
      for (const candidate of cmsCandidates.slice(0, 10)) {
        await validateCandidate(candidate, site.url, true);
      }
      if (cmsCandidates.length > 10) {
        setResultMessage((current) => [current, `另有 ${cmsCandidates.length - 10} 个 CMS 候选未自动验证，可逐项手动验证。`].filter(Boolean).join(' '));
      }
      if (!discoveredCandidates.length) setError(
        Array.isArray(payload.errors) && payload.errors.length
          ? `采集未提取到候选资源：${payload.errors.join('；')}`
          : '采集已完成，但没有发现可识别的公开媒体或播放器地址。请查看下方诊断信息。'
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Scrapling 采集失败。');
    } finally {
      setBusy(false);
    }
  };

  const retryTask = async (task: CollectorTask) => {
    setBusy(true);
    setError('');
    setResultMessage('');
    try {
      const response = await collectorFetch(`/api/resource-collector/tasks/${task.id}/retry`, { method: 'POST' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || payload.detail || '任务重试失败。');
      setSelectedSite({ title: task.host, host: task.host, url: task.url, directory: 'FMHY / Movies-TV-Anime' });
      const retryCandidates: CollectorCandidate[] = Array.isArray(payload.candidates) ? payload.candidates : [];
      setCandidates(retryCandidates);
      await loadTasks();
      const cmsCandidates = retryCandidates.filter((candidate) => candidate.kind === 'cms-api-candidate');
      for (const candidate of cmsCandidates.slice(0, 10)) {
        await validateCandidate(candidate, task.url, true);
      }
      if (cmsCandidates.length > 10) {
        setResultMessage((current) => [current, `另有 ${cmsCandidates.length - 10} 个 CMS 候选未自动验证，可逐项手动验证。`].filter(Boolean).join(' '));
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '任务重试失败。');
    } finally {
      setBusy(false);
    }
  };

  const validateCandidate = async (candidate: CollectorCandidate, detailUrl = selectedSite?.url, quiet = false) => {
    if (!candidate.id) {
      setError('采集服务没有返回候选资源 ID，请重新采集。');
      return;
    }
    if (!quiet) setBusy(true);
    if (!quiet) {
      setError('');
      setResultMessage('');
    }
    try {
      const response = await collectorFetch(`/api/resource-collector/candidates/${candidate.id}/validate`, { method: 'POST' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '资源验证失败。');
      const validation = payload.validation ?? {};
      const accessState = validation.access?.access_state ?? candidate.access_state ?? 'ACCESS_UNKNOWN';
      const cmsValidated = candidate.kind === 'cms-api-candidate'
        && validation.cms_shape === true
        && validation.reachable === true
        && accessState === 'PUBLIC';
      const directMediaValidated = isCandidatePreviewEligible({
        ...candidate,
        status: 'validated',
        access_state: accessState,
        validation,
      });
      setCandidates((current) => current.map((item) => item.id === candidate.id
        ? {
            ...item,
            status: cmsValidated || directMediaValidated ? 'validated' : 'rejected',
            access_state: accessState,
            reason: validation.access?.reason || item.reason,
            validation,
          }
        : item));
      if (cmsValidated) {
        const registration = registerValidatedCmsSource(
          useAppStore.getState(),
          candidate,
          validation,
          detailUrl,
        );
        if (registration.registered) {
          setResultMessage((current) => [current, `CMS 点播源已注册并默认启用：${registration.sourceUrl}`].filter(Boolean).join('；'));
        } else if (registration.duplicate) {
          setResultMessage((current) => [current, '该 CMS 点播源已经存在于影视源管理中，无需重复添加。'].filter(Boolean).join('；'));
        } else {
          setError(registration.reason || 'CMS 点播源注册失败。');
        }
      } else if (candidate.kind === 'cms-api-candidate') {
        setError(validation.reason || validation.access?.reason || '该地址未通过公开访问与 CMS API 结构验证，没有加入点播源。');
      } else if (candidate.kind === 'direct-media' && !directMediaValidated) {
        setError(validation.note || '该媒体未通过访问权限、格式或媒体清单检查，不能预览。');
      } else if (directMediaValidated) {
        setResultMessage('直接媒体地址已通过公开访问检查；它不会被注册为 CMS 点播源。');
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '资源验证失败。');
    } finally {
      if (!quiet) setBusy(false);
    }
  };

  const centerItems = [
    { id: 'overview', title: '数据总览', detail: '所有网站和影视资源统计', icon: 'search' as IconName },
    { id: 'directory', title: 'FMHY 网站目录', detail: '公开资源站网站发现入口', icon: 'home' as IconName },
    { id: 'seedhub', title: 'SeedHub 内容采集', detail: '同步电影、电视剧、动漫目录与真实元数据', icon: 'database' as IconName },
    { id: 'archives', title: '网站采集档案', detail: '每个网站独立抓取记录', icon: 'database' as IconName },
    { id: 'library', title: '影视资源库', detail: '电影、电视剧、动漫及去重', icon: 'download' as IconName },
    { id: 'monitor', title: '实时任务监控', detail: 'Spider、浏览器和任务队列', icon: 'bolt' as IconName },
    { id: 'quality', title: '资源质量检测', detail: '预检、播放确认和质量评分', icon: 'check' as IconName },
    { id: 'history', title: '采集历史', detail: '每次任务的完整审计记录', icon: 'clock' as IconName },
    { id: 'strategy', title: '采集策略', detail: '增量抓取、频率、重试和限额', icon: 'filter' as IconName },
    { id: 'connection', title: '连接配置', detail: 'Scrapling 地址、Token 和连接测试', icon: 'link' as IconName },
  ];
  const activeCenterItem = centerItems.find((item) => item.id === centerPage);

  if (centerPage === 'index') {
    return (
      <section className="overflow-hidden rounded-2xl border border-line bg-card">
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-4 sm:px-5">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-chip text-content">
              <Icon name="search" className="h-6 w-6" />
            </span>
            <h3 className="truncate text-lg font-semibold tracking-tight text-content">资源采集中心</h3>
          </div>
          <span className="rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-600">V2.0</span>
        </header>
        <nav aria-label="资源采集中心功能导航" className="divide-y divide-line px-3 py-1 sm:px-4">
          {centerItems.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => { setCenterPage(item.id); if (item.id === 'seedhub') void loadSeedHubJobs(); }}
              className="group flex min-h-[64px] w-full items-center gap-3 rounded-xl px-1 py-2 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              aria-label={item.title}
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-chip text-content">
                <Icon name={item.icon} className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-content">{item.title}</span>
                <span className="mt-0.5 block text-xs text-muted">{item.detail}</span>
              </span>
              <span aria-hidden="true" className="shrink-0 text-xl leading-none text-faint transition-transform group-hover:translate-x-0.5">›</span>
            </button>
          ))}
        </nav>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <button
        type="button"
        onClick={() => setCenterPage('index')}
        className="collector-subnav-back"
      >
        <span aria-hidden="true">‹</span>
        <span>资源采集中心</span>
      </button>
      <div className="collector-subpage-heading border-b border-line pb-3">
        <h3 className="text-lg font-semibold text-content">{activeCenterItem?.title}</h3>
        <p className="mt-1 text-xs text-muted">{activeCenterItem?.detail}</p>
      </div>
      {['overview', 'archives', 'quality'].includes(centerPage) ? <ResourceStatsPanel /> : null}
      <div hidden={centerPage !== 'connection'} className="rounded-2xl border border-line bg-card p-4 space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-content">Scrapling 连接配置 · 本机 Preview 测试</h3>
          <p className="mt-1 text-xs leading-5 text-muted">填写已经部署并启用 HTTPS 的 Scrapling Collector 公网地址与访问 Token。SeedHub 是公开目录，不需要 SeedHub 账号或密码；这里的 Token 只用于 LibreTV 与你自己的 Collector 服务认证。配置仅保存在当前浏览器 LocalStorage，通过已登录的 LibreTV Worker 代理转发；不会写入 Git 或 Cloudflare 环境变量。当前仅用于独立 Preview 测试。</p>
        </div>
        <label className="block space-y-1">
          <span className="text-xs font-semibold text-content">SCRAPLING_API_BASE · 采集服务地址</span>
          <input className="input w-full" type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false}
            placeholder="https://your-scrapling-collector.example.com" value={collectorBase}
            onChange={(event) => { setCollectorBase(event.target.value); setConfigSaved(false); }} />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-semibold text-content">SCRAPLING_API_TOKEN · 采集服务密钥</span>
          <div className="flex gap-2">
            <input className="input min-w-0 flex-1" type={showCollectorToken ? 'text' : 'password'} autoComplete="off"
              autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="粘贴 Collector Bearer Token"
              value={collectorToken} onChange={(event) => { setCollectorToken(event.target.value); setConfigSaved(false); }} />
            <button type="button" className="btn-ghost btn-sm shrink-0" onClick={() => setShowCollectorToken((value) => !value)}>{showCollectorToken ? '隐藏' : '显示'}</button>
          </div>
        </label>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-primary btn-sm" onClick={saveCollectorSettings}>保存到本机</button>
          <button type="button" className="btn-ghost btn-sm" onClick={() => void testCollectorConnection()} disabled={testingConnection}>{testingConnection ? '测试中…' : '保存并测试连接'}</button>
          <button type="button" className="btn-ghost btn-sm" onClick={clearCollectorSettings}>清除本机配置</button>
        </div>
        {configSaved ? <p className="text-[11px] text-success">已保存到此设备的浏览器</p> : null}
        {connectionStatus ? <p className="text-xs text-muted" role="status">{connectionStatus}</p> : null}
        <p className="text-[11px] leading-5 text-muted">仅接受公网 HTTPS 域名（443 端口）；Token 通过 HTTPS Header 发送给 LibreTV Worker，再由 Worker 转发给 Collector。清除后回退到服务端 SCRAPLING_API_BASE / SCRAPLING_API_TOKEN。LocalStorage 中的 Token 可被本机浏览器脚本读取，请只在可信设备的测试 Preview 使用。</p>
      </div>

      <div hidden={centerPage !== 'seedhub'} className="rounded-2xl border border-line bg-card p-4 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-content">SeedHub 公开目录采集</h3>
            <p className="mt-1 text-xs leading-5 text-muted">自动分页采集电影、电视剧和动漫的名称、真实海报、详情简介、剧照与元数据；按批次持续推进到目录末页。不提取下载地址，不把下载地址当作在线播放源。</p>
          </div>
          <a className="text-xs text-accent underline" href="https://www.seedhub.cc" target="_blank" rel="noreferrer">打开 SeedHub</a>
        </div>
        <label className="flex items-center gap-3 text-xs text-muted">
          每批采集页数
          <select className="input w-24" value={seedHubPages} onChange={(event) => setSeedHubPages(Math.max(1, Math.min(50, Number(event.target.value) || 1)))}>
            {[1, 3, 5, 10, 20, 50].map((count) => <option key={count} value={count}>{count} 页</option>)}
          </select>
        </label>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => void syncAllSeedHub()}>采集全部分类</button>
          <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => void syncSeedHub('movies')}>采集电影目录</button>
          <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => void syncSeedHub('series')}>采集电视剧目录</button>
          <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => void syncSeedHub('anime')}>采集动漫目录</button>
          <button type="button" className="btn-ghost btn-sm" disabled={busy} onClick={() => void loadSeedHubJobs()}>刷新任务</button>
        </div>
        <p className="text-[11px] leading-5 text-muted">采集需要已部署的 Scrapling Collector、有效 Token、持续运行的 Worker，以及服务端出口防火墙确认。出口安全闸门未通过时任务会拒绝访问 SeedHub，不会绕过限制。</p>
        {seedHubJobs.length ? <div className="space-y-2">
          <h4 className="text-xs font-semibold text-content">最近 SeedHub 采集任务</h4>
          {seedHubJobs.map((job) => <div key={job.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-chip p-3">
            <div className="min-w-0"><span className="block truncate text-xs text-content">任务 {job.id.slice(0, 12)}</span>{job.error ? <span className="mt-1 block text-[10px] text-warning">{job.error}</span> : null}</div>
            <span className={'shrink-0 text-[10px] font-semibold ' + (job.status === 'succeeded' ? 'text-success' : job.status === 'failed' || job.status === 'partial' ? 'text-warning' : 'text-muted')}>{job.status}</span>
          </div>)}
        </div> : <p className="text-xs text-muted">暂无 SeedHub 采集任务记录。</p>}
      </div>

      <div hidden={centerPage !== 'directory'} className="rounded-2xl border border-line bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-content">FMHY · 唯一网站发现目录</h3>
            <p className="mt-1 text-xs text-muted">目录来源固定为 FMHY Movies / TV / Anime，不从其他目录扩展发现。</p>
            <a className="mt-2 inline-flex text-xs text-accent underline" href="https://fmhy.net/video" target="_blank" rel="noreferrer">打开 FMHY 视频目录</a>
          </div>
          <button type="button" className="btn-primary btn-sm" onClick={() => void discover()} disabled={busy}>
            {busy ? '处理中…' : loaded ? '刷新 FMHY 目录' : '发现网站'}
          </button>
        </div>
      </div>

      {error ? <p className="rounded-xl border border-line bg-card px-3 py-2 text-xs text-muted" role="status">{error}</p> : null}
      {resultMessage ? <p className="rounded-xl border border-line bg-card px-3 py-2 text-xs text-muted" role="status">{resultMessage}</p> : null}

      {sites.length > 0 ? (
        <div hidden={centerPage !== 'directory'} className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-content">发现的网站</h3>
            <span className="text-xs text-muted">{sites.length} 个候选站点</span>
          </div>
          <div className="max-h-80 space-y-2 overflow-y-auto">
            {sites.map((site) => (
              <div key={site.host} className="flex items-center gap-3 rounded-xl border border-line bg-card p-3">
                <div className="min-w-0 flex-1">
                  <strong className="block truncate text-sm text-content">{site.title}</strong>
                  <span className="block truncate text-xs text-muted">{site.host}</span>
                </div>
                <button type="button" className="btn-ghost btn-sm shrink-0" onClick={() => void crawl(site)} disabled={busy}>
                  {selectedSite?.host === site.host && busy ? '采集中…' : 'Scrapling 检查'}
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : loaded ? (
        <p className="text-xs text-muted">FMHY 当前没有返回可用的外部站点链接。</p>
      ) : null}

      {tasks.length > 0 ? (
        <div hidden={centerPage !== 'monitor' && centerPage !== 'history'} className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-content">{centerPage === 'monitor' ? '实时任务监控' : '采集历史'}</h3>
            <button type="button" className="btn-ghost btn-sm" onClick={() => void loadTasks()}>刷新</button>
          </div>
          <div className="max-h-52 space-y-2 overflow-y-auto">
            {tasks.map((task) => (
              <div key={task.id} className="rounded-xl border border-line bg-card p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs text-content">{task.host}</span>
                  <span className="shrink-0 text-[10px] text-muted">{task.status} · {task.result_count} 项</span>
                </div>
                <p className="mt-1 truncate text-[10px] text-muted">{task.url}</p>
                {task.error ? <p className="mt-1 text-[10px] text-warning">{task.error}</p> : null}
                {['failed', 'interrupted', 'partial'].includes(task.status) ? (
                  <button type="button" className="mt-2 btn-ghost btn-sm" disabled={busy} onClick={() => void retryTask(task)}>重试任务</button>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {selectedSite ? (
        <div hidden={centerPage !== 'library'} className="space-y-2 rounded-2xl border border-line bg-card p-4">
          <div>
            <h3 className="text-sm font-semibold text-content">采集结果 · {selectedSite.title}</h3>
            <p className="mt-1 truncate text-xs text-muted">{selectedSite.url}</p>
          </div>
          {crawlDiagnostics ? (
            <div className="rounded-lg border border-line bg-chip/60 p-3 text-[11px] text-muted space-y-1.5">
              <p><strong className="text-content">页面标题：</strong>{crawlDiagnostics.pageTitle || '未获取（HTTP Spider 未提供页面元数据）'}</p>
              <p className="break-all"><strong className="text-content">最终访问地址：</strong>{crawlDiagnostics.finalUrl || selectedSite.url}</p>
              <p><strong className="text-content">采集模式：</strong>{crawlDiagnostics.mode || '未知'} · <strong className="text-content">捕获请求：</strong>{crawlDiagnostics.capturedRequestCount ?? 0}</p>
              <p><strong className="text-content">HTTP Spider：</strong>{crawlDiagnostics.httpSpider?.status || '未运行'} · 候选 {crawlDiagnostics.httpSpider?.candidate_count ?? 0}{crawlDiagnostics.httpSpider?.error ? ` · ${crawlDiagnostics.httpSpider.error}` : ''}</p>
              <p><strong className="text-content">浏览器采集：</strong>{crawlDiagnostics.browser?.status || '未运行'} · 候选 {crawlDiagnostics.browser?.candidate_count ?? 0}{crawlDiagnostics.browser?.error ? ` · ${crawlDiagnostics.browser.error}` : ''}</p>
              {crawlDiagnostics.errors?.map((item, index) => <p key={index} className="text-warning">{item}</p>)}
            </div>
          ) : null}
          {candidates.length > 0 ? candidates.map((candidate) => (
            <div key={candidate.url} className="flex min-w-0 items-center gap-2 rounded-lg bg-chip p-2">
              <div className="min-w-0 flex-1">
                <span className="block text-[10px] text-muted">{candidate.kind} · {candidate.host} · {candidate.status === 'validated' ? (candidate.kind === 'cms-api-candidate' ? 'CMS 结构通过' : '媒体预检通过，待实际播放验证') : candidate.status === 'rejected' ? '验证失败 / 不可预览' : '待验证'}</span>
                {candidate.access_state ? <span className="block text-[10px] font-semibold text-content">{candidate.access_state}{candidate.drm_systems?.length ? ` · ${candidate.drm_systems.join(', ')}` : ''}</span> : null}
                {candidate.reason ? <span className="block text-[10px] text-muted">{candidate.reason}</span> : null}
                {candidate.next_action ? <span className="block text-[10px] text-muted">{candidate.next_action}</span> : null}
                {candidate.validation?.note ? <span className="block text-[10px] text-muted">{candidate.validation.note}</span> : null}
                <a className="block truncate text-xs text-content underline" href={candidate.url} target="_blank" rel="noreferrer">{candidate.url}</a>
              </div>
              <div className="flex shrink-0 flex-wrap gap-1">
                {isCandidatePreviewEligible(candidate) ? (
                  <button type="button" className="btn-primary btn-sm" onClick={() => setPlayingCandidate(candidate)}>播放</button>
                ) : null}
                <button type="button" className="btn-ghost btn-sm" disabled={busy || !candidate.id || ['AUTH_REQUIRED', 'SUBSCRIPTION_REQUIRED', 'DRM_PROTECTED', 'ENCRYPTED_STREAM', 'CHALLENGE'].includes(candidate.access_state || '')} onClick={() => void validateCandidate(candidate)}>
                  {candidate.status === 'validated' ? '已验证' : candidate.status === 'checked' ? '已检查' : '验证'}
                </button>
                <button type="button" className="btn-ghost btn-sm" onClick={() => void copyToClipboard(candidate.url)}>复制</button>
              </div>
              {candidate.validation?.cms_shape ? <span className="text-[10px] text-success">CMS API 可用，已加入点播源</span> : null}
            </div>
          )) : <p className="text-xs text-muted">尚未发现可直接识别的媒体链接。</p>}
        </div>
      ) : null}

      {centerPage === 'strategy' ? (
        <section className="rounded-2xl border border-line bg-card p-4 space-y-2">
          <h4 className="text-sm font-semibold text-content">采集策略</h4>
          <p className="text-xs leading-5 text-muted">增量指纹、失败重试和任务限额由 Scrapling Collector 服务端策略执行。当前页面先展示已启用的策略说明，不提供浏览器端修改服务端安全限制的入口。</p>
          <p className="text-xs leading-5 text-muted">现有采集链路记录页面内容指纹，内容未变化时跳过重复提取；任务重试沿用 Collector 持久队列的重试与租约机制。</p>
        </section>
      ) : null}
      {centerPage === 'library' && !selectedSite ? (
        <p className="rounded-xl border border-line bg-card p-4 text-xs text-muted">请先进入 FMHY 网站目录，选择一个已发现网站并启动 Scrapling 检查，采集到的电影、剧集和动漫候选会显示在这里。</p>
      ) : null}
      <p className="text-xs leading-6 text-muted">底层引擎：Scrapling Python 服务。仅提取公开可访问的媒体/播放器链接，不绕过登录、付费墙、DRM 或访问控制。可直接播放的媒体直链使用 LibreTV 原有 PlayerShell 预览；这类直链不会冒充 CMS 点播 API 源。</p>
      {playingCandidate ? <CollectorDirectPlayer candidate={playingCandidate} onClose={() => setPlayingCandidate(null)} /> : null}
    </section>
  );
}

function CollectorDirectPlayer({ candidate, onClose }: { candidate: CollectorCandidate; onClose: () => void }) {
  const adFilter = useAppStore((state) => state.adFilter);
  const [pendingStart, setPendingStart] = useState<number | null>(null);
  const [playbackEvidence, setPlaybackEvidence] = useState<{
    mediaType: string; observedSeconds: number; progressedSeconds: number;
    decodedWidth?: number; decodedHeight?: number;
    selectedRenditionHeight?: number; selectedRenditionBitrateKbps?: number;
  } | null>(null);
  const [playbackEvidenceSaved, setPlaybackEvidenceSaved] = useState(false);
  const [playbackEvidenceError, setPlaybackEvidenceError] = useState('');
  const handlePlaybackConfirmed = async (evidence: {
    mediaType: string; observedSeconds: number; progressedSeconds: number;
    decodedWidth: number; decodedHeight: number;
    selectedRenditionHeight: number; selectedRenditionBitrateKbps: number;
  }) => {
    setPlaybackEvidence(evidence);
    setPlaybackEvidenceSaved(false);
    setPlaybackEvidenceError('');
    if (!candidate.id) {
      setPlaybackEvidenceError('本次播放已确认，但候选记录缺少 ID，无法写入采集记录。');
      return;
    }
    try {
      const response = await collectorFetch(
        `/api/resource-collector/candidates/${candidate.id}/playback`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(evidence),
        },
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || payload.error || '播放证据写入失败。');
      setPlaybackEvidenceSaved(true);
    } catch (reason) {
      setPlaybackEvidenceError(reason instanceof Error ? reason.message : '播放证据写入失败。');
    }
  };
  return (
    <div className="fixed inset-0 z-[2000] flex items-center justify-center overflow-y-auto bg-black/95 p-3 sm:p-6" role="presentation">
      <section className="w-full max-w-5xl overflow-hidden rounded-2xl border border-white/15 bg-[#101014] text-white shadow-2xl" role="dialog" aria-modal="true" aria-label="资源采集结果预览">
        <header className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">资源预览</h3>
            <p className="truncate text-xs text-white/55">{candidate.host} · {candidate.kind}</p>
          </div>
          <button type="button" className="h-10 w-10 rounded-full bg-white/10 text-xl" onClick={onClose} aria-label="关闭预览">×</button>
        </header>
        <CollectorPlayerShell
          url={candidate.url}
          title={candidate.host}
          mediaType={candidate.validation?.media_format === 'hls' ? 'hls' : (candidate.validation?.content_type || '').includes('webm') || /\.webm(?:$|\?)/i.test(candidate.url) ? 'webm' : 'mp4'}
          onPlaybackConfirmed={handlePlaybackConfirmed}
          adFilter={adFilter}
          autoplayNext={false}
          autoSkipSegments={false}
          pendingStart={pendingStart}
          onPendingStart={setPendingStart}
          episodeKey={`collector:${candidate.host}`}
        />
        {playbackEvidence ? (
          <div className="border-t border-white/10 px-4 py-3 text-xs text-emerald-300">
            <p>已确认真实播放：{playbackEvidence.mediaType}，观察 {playbackEvidence.observedSeconds}s，播放进度推进 {playbackEvidence.progressedSeconds.toFixed(1)}s</p>
            <p>实际解码：{playbackEvidence.decodedWidth && playbackEvidence.decodedHeight ? playbackEvidence.decodedWidth + '×' + playbackEvidence.decodedHeight : '分辨率未知'} · HLS 档位：{playbackEvidence.selectedRenditionHeight ? playbackEvidence.selectedRenditionHeight + 'P' : '未知'}</p>
            {playbackEvidenceSaved ? <p className="mt-1 text-emerald-200">播放证据已写入 Scrapling 采集记录。</p> : null}
            {playbackEvidenceError ? <p className="mt-1 text-amber-300">{playbackEvidenceError}</p> : null}
            {!playbackEvidenceSaved && !playbackEvidenceError ? <p className="mt-1 text-white/55">正在保存播放证据…</p> : null}
          </div>
        ) : (
          <p className="border-t border-white/10 px-4 py-3 text-xs text-white/55">
            正在等待真实播放验证：播放器必须保持播放并持续推进进度，单纯 HTTP 200 不算成功。
          </p>
        )}
      </section>
    </div>
  );
}

// —— 点播源面板 ——

type VodFilter = 'all' | 'enabled' | 'disabled' | 'sub' | 'manual';

// 与直播源面板保持同一组筛选项与顺序：先状态（已启用 / 已停用），后来源（来自订阅 / 手动添加）
const VOD_FILTERS: { id: VodFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'enabled', label: '已启用' },
  { id: 'disabled', label: '已停用' },
  { id: 'sub', label: '来自订阅' },
  { id: 'manual', label: '手动添加' },
];

function VodSourcesPanel() {
  const store = useAppStore();
  const { toast } = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<VodFilter>('all');
  const { tests, runTest } = useSourceTests();
  const { progress, probe, cancel, isProbing } = useSourceProbe();

  const envKeys = useMemo(() => new Set(store.envSources.map((s) => s.key)), [store.envSources]);
  const all = useMemo(() => [...store.envSources, ...store.customAPIs], [store.envSources, store.customAPIs]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((s) => {
      const fromSub = s.key.startsWith('sub_');
      // 已启用 = 勾选中且当前未被自动停用（即真正在参与搜索的源）
      if (filter === 'enabled' && !(store.selectedKeys.includes(s.key) && !isSourceDisabled(store, s.key))) return false;
      if (filter === 'disabled' && !isSourceDisabled(store, s.key)) return false;
      if (filter === 'sub' && !fromSub) return false;
      // 手动添加 = 既非订阅导入、也非部署者预置
      if (filter === 'manual' && (fromSub || envKeys.has(s.key))) return false;
      if (!q) return true;
      return s.name.toLowerCase().includes(q) || s.url.toLowerCase().includes(q);
    });
  }, [all, query, filter, store, envKeys]);

  const visibleKeys = filtered.map((s) => s.key);
  const allSelected = visibleKeys.length > 0 && visibleKeys.every((k) => store.selectedKeys.includes(k));

  const toggleAll = () => {
    if (allSelected) {
      store.setSelectedKeys(store.selectedKeys.filter((k) => !visibleKeys.includes(k)));
      return;
    }
    // 成人过滤开启时成人源不可勾选，与行内复选框保持一致
    const eligible = filtered.filter((s) => !(s.isAdult && store.yellowFilter)).map((s) => s.key);
    const skipped = filtered.length - eligible.length;
    store.setSelectedKeys([...new Set([...store.selectedKeys, ...eligible])]);
    if (skipped > 0) toast(`已启用 ${eligible.length} 个；${skipped} 个成人源因过滤开启被跳过`, 'info');
  };

  const runAll = async () => {
    if (isProbing) {
      cancel();
      return;
    }
    const result = await probe(filtered.map((s) => ({ key: s.key, url: s.url })));
    if (!result) return; // 被取消则无汇总
    toast(`测活完成：${result.ok}/${result.total} 个可用`, result.ok === result.total ? 'success' : 'info');
  };

  /** 一键恢复被自动停用的源（仅「已停用」筛选下提供） */
  const restoreAll = () => {
    const keys = filtered.filter((s) => isSourceDisabled(store, s.key)).map((s) => s.key);
    if (keys.length === 0) return;
    keys.forEach((k) => useAppStore.getState().clearSourceHealth(k));
    toast(`已恢复 ${keys.length} 个源`, 'success');
  };

  const empty = store.envSources.length === 0 && store.customAPIs.length === 0;

  return (
    <section>
      <SectionTitle
        title="点播源"
        hint={empty ? undefined : `共 ${all.length} 个 · 已启用 ${all.filter((s) => store.selectedKeys.includes(s.key)).length}`}
        extra={
          <button className="btn-primary btn-sm" onClick={() => setEditing('__new__')}>
            <Icon name="plus" className="w-3.5 h-3.5" />
            添加 API
          </button>
        }
      />

      <SourceForm
        visible={editing === '__new__'}
        onCancel={() => setEditing(null)}
        onSubmit={(data) => {
          store.addCustomApi(data);
          setEditing(null);
        }}
      />

      {empty && editing !== '__new__' ? (
        <EmptyState
          icon="link"
          title="还没有添加任何点播源"
          description="添加一个 Apple CMS 采集站 API 即可开始搜索影片；也可到「数据源订阅」一次导入点播源与直播源"
          action={
            <button className="btn-primary btn-sm" onClick={() => setEditing('__new__')}>
              添加第一个点播源
            </button>
          }
        />
      ) : (
        <>
          <div className="space-y-2 mb-3">
            <SearchInput value={query} onChange={setQuery} placeholder="搜索名称或地址" />
            <div className="flex flex-wrap items-center gap-1">
              {VOD_FILTERS.map((f) => (
                <button
                  key={f.id}
                  className={cn(
                    'chip',
                    filter === f.id ? 'bg-accent/10 text-accent font-medium' : 'text-muted hover:text-content hover:bg-hover'
                  )}
                  onClick={() => setFilter(f.id)}
                  aria-pressed={filter === f.id}
                >
                  {f.label}
                </button>
              ))}
              <span className="ml-auto text-[11px] text-faint">显示 {filtered.length} 个</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button className="btn-ghost btn-sm" onClick={toggleAll} disabled={filtered.length === 0}>
                {allSelected ? '全部停用' : '全部启用'}
              </button>
              <button
                className="btn-ghost btn-sm"
                onClick={runAll}
                disabled={filtered.length === 0}
              >
                {isProbing ? '取消测活' : '批量测活'}
              </button>
              {/* 查看「已停用」时提供一键恢复，省去逐个点击 */}
              {filter === 'disabled' && (
                <button className="btn-ghost btn-sm" onClick={restoreAll} disabled={filtered.length === 0}>
                  全部恢复
                </button>
              )}
            </div>
            {progress && (
              <div className="flex items-center gap-2 text-[11px] text-muted">
                <div className="flex-1 h-1.5 bg-chip rounded-full overflow-hidden">
                  <div
                    className="h-full bg-accent transition-[width] duration-200"
                    style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
                  />
                </div>
                <span className="tabular-nums shrink-0">
                  {progress.done}/{progress.total} · 可用 {progress.ok}
                  {formatEta(progress.done, progress.total, progress.startedAt)}
                </span>
                <button className="btn-ghost btn-sm shrink-0" onClick={cancel}>
                  取消
                </button>
              </div>
            )}
          </div>

          {filtered.length === 0 ? (
            <EmptyState variant="plain" title="没有符合条件的源" />
          ) : (
            <ul className="space-y-2">
              {filtered.map((source) => (
                <VodSourceRow
                  key={source.key}
                  api={source}
                  isEnv={envKeys.has(source.key)}
                  editing={editing === source.key}
                  onEdit={setEditing}
                  onCancelEdit={() => setEditing(null)}
                  onUpdate={(data) => {
                    store.updateCustomApi(source.key, data);
                    setEditing(null);
                  }}
                  testState={tests[source.key]}
                  onTest={() =>
                    runTest(source.key, async () => {
                      const r = await api.testSource(source.url);
                      // 手动测试也写入健康度，与搜索 / 批量测活共用同一份模型（不再存在两套健康度）
                      useAppStore.getState().recordSourceHealth([
                        { sourceKey: source.key, ok: r.ok, ms: r.ms, error: r.error, list: [] },
                      ]);
                      return r;
                    })
                  }
                />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function formatEta(done: number, total: number, startedAt: number): string {
  if (done <= 0 || done >= total) return '';
  const elapsed = Date.now() - startedAt;
  const remainSec = Math.max(0, Math.round((elapsed / done) * (total - done) / 1000));
  return remainSec > 0 ? ` · 约 ${remainSec}s` : '';
}

/** 单条点播源行：勾选 / 名称标签 / 健康度 / 探活 / 编辑删除（订阅源与预置源按来源限制操作） */
function VodSourceRow({
  api,
  isEnv,
  editing,
  onEdit,
  onCancelEdit,
  onUpdate,
  testState,
  onTest,
}: {
  api: SourceConfig;
  isEnv: boolean;
  editing: boolean;
  onEdit: (key: string) => void;
  onCancelEdit: () => void;
  onUpdate: (data: { name: string; url: string; detail?: string; isAdult?: boolean }) => void;
  testState?: TestState;
  onTest: () => void;
}) {
  const selected = useAppStore((s) => s.selectedKeys.includes(api.key));
  const yellowFilter = useAppStore((s) => s.yellowFilter);
  const toast = useToast().toast;
  const fromSubscription = api.key.startsWith('sub_');
  const adultBlocked = !!api.isAdult && yellowFilter;

  const remove = () => {
    const snapshot = useAppStore.getState().removeCustomApi(api.key);
    if (!snapshot) return;
    // 轻操作：不做确认弹窗，给 6 秒撤销窗口
    toast(`已移除「${api.name}」`, 'info', {
      action: {
        label: '撤销',
        onClick: () => {
          const ok = useAppStore.getState().restoreCustomApi(snapshot);
          toast(ok ? '已恢复' : '恢复失败：该源位置已被重新占用', ok ? 'success' : 'warning');
        },
      },
    });
  };

  if (editing) {
    return (
      <li className="bg-card rounded-lg p-3">
        <SourceForm visible initial={api} onCancel={onCancelEdit} onSubmit={onUpdate} />
      </li>
    );
  }

  return (
    <li
      className={cn(
        'bg-card rounded-lg p-3 transition-colors hover:bg-hover/50',
        // 未勾选 = 不参与搜索：整行淡显，长列表里才能一眼扫出哪些没启用
        !selected && 'opacity-70'
      )}
    >
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          className="h-4 w-4 accent-accent shrink-0"
          checked={selected}
          onChange={() => useAppStore.getState().toggleSourceSelected(api.key)}
          disabled={adultBlocked}
          title={adultBlocked ? '成人内容过滤开启中，需先关闭过滤才能启用此源' : undefined}
          aria-label={`选择 ${api.name}`}
        />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-content truncate">
            {api.name}
            {api.isAdult && <span className="text-pink-400 text-xs ml-1">(18+)</span>}
            {isEnv && (
              <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-chip text-faint align-middle">
                部署者预置
              </span>
            )}
            {fromSubscription && (
              <span
                className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent align-middle"
                title="来自数据源订阅，重新同步时此源的名称/地址会以订阅内容为准"
              >
                订阅
              </span>
            )}
          </div>
          <div className="text-xs text-faint truncate">{api.url}</div>
        </div>
        <HealthBadge sourceKey={api.key} />
        <TestBadge
          state={testState}
          onTest={onTest}
          title="测试可用性（搜索耗时与结果量）"
          badgeWhenOk={({ ms }) => `✓ ${ms}ms`}
        />
        {!isEnv &&
          (fromSubscription ? (
            // 订阅源由远端列表管理：编辑会被下次同步覆盖、删除会复活，故置为禁用态并说明去处
            <>
              <button
                className="rounded-md p-2 text-muted/30 cursor-not-allowed shrink-0"
                disabled
                aria-label="订阅源不可单独编辑"
                title="该源来自订阅，修改会在下次同步时被覆盖；请修改远端订阅后重新同步"
              >
                <Icon name="edit" className="w-4 h-4" />
              </button>
              <button
                className="rounded-md p-2 text-muted/30 cursor-not-allowed shrink-0"
                disabled
                aria-label="订阅源不可单独删除"
                title="该源来自订阅，单独删除会在下次同步时恢复；请到「数据源订阅」删除整个订阅"
              >
                <Icon name="trash" className="w-4 h-4" />
              </button>
            </>
          ) : (
            <>
              <button
                className="rounded-md p-2 text-muted transition-colors hover:bg-hover hover:text-accent shrink-0"
                onClick={() => onEdit(api.key)}
                aria-label="编辑"
                title="编辑"
              >
                <Icon name="edit" className="w-4 h-4" />
              </button>
              <button
                className="rounded-md p-2 text-muted transition-colors hover:bg-hover hover:text-danger shrink-0"
                onClick={remove}
                aria-label="删除"
                title="移除（可在提示中撤销）"
              >
                <Icon name="trash" className="w-4 h-4" />
              </button>
            </>
          ))}
      </div>
    </li>
  );
}

// —— 偏好设置面板 ——

function PlaybackPanel() {
  const store = useAppStore();
  const { toast } = useToast();
  const [clearMarksOpen, setClearMarksOpen] = useState(false);
  const [qualityPreference, setQualityPreference] = useState("auto");
  const markCount = Object.keys(store.skipMarks).length;

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("libretv-quality-preference");
      if (saved === "480" || saved === "720" || saved === "1080" || saved === "2160") setQualityPreference(saved);
    } catch { /* Adaptive quality remains the default. */ }
  }, []);

  const updateQualityPreference = (value: string) => {
    const next = ["480", "720", "1080", "2160"].includes(value) ? value : "auto";
    setQualityPreference(next);
    try { window.localStorage.setItem("libretv-quality-preference", next); } catch { /* Session-only preference. */ }
    window.dispatchEvent(new CustomEvent("libretv-quality-preference-change", { detail: { maxHeight: next === "auto" ? null : Number(next) } }));
  };

  return (
    <section>
      <SectionTitle title="播放与过滤" />
      <div className="space-y-3">
        <SelectRow
          label="默认清晰度"
          value={qualityPreference}
          onChange={updateQualityPreference}
          options={[
            { value: "auto", label: "自动", hint: "根据网络与设备自适应" },
            { value: "2160", label: "4K · 2160p", hint: "有可用档位时优先使用" },
            { value: "1080", label: "1080p", hint: "最高不超过 1080p" },
            { value: "720", label: "720p", hint: "最高不超过 720p" },
            { value: "480", label: "480p", hint: "最高不超过 480p" },
          ]}
        />
        <p className="text-xs text-faint leading-relaxed">仅对提供多档清晰度的 HLS 播放源生效；播放器会按源实际提供的档位选择不高于此上限的最高可用画质。直链或单码率源不受此项控制。</p>
        <ToggleRow
          label="广告切片过滤"
          description="剔除播放列表中的广告分片段落（按分片 URL 特征、片头插入与长片间超短中插识别，不动 DISCONTINUITY 时间轴）"
          checked={store.adFilter}
          onChange={(v) => store.updateSettings({ adFilter: v })}
        />
        <ToggleRow
          label="自动连播"
          description="单集播放结束后自动播放下一集"
          checked={store.autoplayNext}
          onChange={(v) => store.updateSettings({ autoplayNext: v })}
        />
        <ToggleRow
          label="自动跳过片段"
          description="命中片头/中段标记时跳到片段末尾，命中片尾标记时结束本集（是否连播下一集由「自动连播」决定）；关闭后三类都只显示跳过按钮（标记在播放页「跳过标记」中设置）"
          checked={store.autoSkipSegments}
          onChange={(v) => store.updateSettings({ autoSkipSegments: v })}
        />
      </div>

      {markCount > 0 && (
        <div className="flex items-center justify-between gap-3 pt-3 mt-3 border-t border-line">
          <div className="min-w-0">
            <div className="text-sm text-content">跳过片段标记</div>
            <div className="text-xs text-faint">已记录 {markCount} 部；在播放页「跳过标记」中设置，可逐剧关闭</div>
          </div>
          <button className="btn-ghost btn-sm shrink-0" onClick={() => setClearMarksOpen(true)}>
            清除全部
          </button>
        </div>
      )}

      <ConfirmDialog
        open={clearMarksOpen}
        danger
        title="清除全部跳过片段？"
        message={`将删除已记录的 ${markCount} 部剧的跳过片段，之后播放不再自动跳过；可重新在播放页标记。`}
        confirmLabel="清除全部"
        onCancel={() => setClearMarksOpen(false)}
        onConfirm={() => {
          store.clearAllSkipMarks();
          setClearMarksOpen(false);
          toast('已清除全部跳过片段标记', 'success');
        }}
      />

      <VideoCachePanel />
    </section>
  );
}

/** 片段缓存：开启/关闭 + 用量展示 + 清理（数据在浏览器本地，独立于配置导出） */
function VideoCachePanel() {
  const [enabled, setEnabled] = useState(() => loadCacheSettings().enabled);
  const [summary, setSummary] = useState<CacheSummary>({ segments: 0, bytes: 0, episodes: 0 });
  const [clearing, setClearing] = useState(false);

  const refresh = useCallback(() => {
    void getCacheSummary().then(setSummary);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const formatBytes = (bytes: number): string => {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
    return `${(bytes / 1024).toFixed(0)} KB`;
  };

  return (
    <div className="space-y-3 pt-3 mt-3 border-t border-line">
      <ToggleRow
        label="片段本地缓存"
        description="暂停或观看时把后续分片缓存到浏览器本地，二次播放与断网卡顿时直接命中（存储于本机，不计入配置导出）"
        checked={enabled}
        onChange={(v) => {
          const next = saveCacheSettings({ enabled: v });
          setEnabled(next.enabled);
        }}
      />
      <div className="flex items-center justify-between text-xs text-faint">
        <span>
          已缓存 {summary.segments} 个分片 · {formatBytes(summary.bytes)} · {summary.episodes} 集
        </span>
        <button
          type="button"
          className="px-2 py-1 rounded bg-chip text-content hover:bg-hover transition-colors disabled:opacity-50"
          disabled={clearing || summary.segments === 0}
          onClick={async () => {
            setClearing(true);
            await clearVideoCache();
            refresh();
            setClearing(false);
          }}
        >
          清理缓存
        </button>
      </div>
    </div>
  );
}

function ImagePanel() {
  const store = useAppStore();
  const mode = store.imageProxyMode;
  const description: Record<'direct' | 'proxy' | 'custom', string> = {
    direct: '封面与逐集剧照原站直连；豆瓣封面自动换公共镜像，仍失败回退内置代理。最省服务器流量',
    proxy: '封面与逐集剧照优先经本站服务器转发并伪装来源，失败自动回退公共镜像/直连。最稳定，消耗服务器流量',
    custom: '使用你填写的模板转发封面与逐集剧照，包括风暴等资源站的剧集图片',
  };
  return (
    <section>
      <SectionTitle title="外观与封面" hint="主题、封面与剧集图片加载策略" />
      <div className="space-y-2">
        <SelectRow
          label="加载方式"
          value={mode}
          description={description[mode]}
          onChange={(v) => store.updateSettings({ imageProxyMode: v as 'direct' | 'proxy' | 'custom' })}
          options={[
            { value: 'direct', label: '直连优先', hint: '最省服务器流量' },
            { value: 'proxy', label: '内置代理', hint: '最稳定' },
            { value: 'custom', label: '自定义', hint: '自建转发模板' },
          ]}
        />
        {mode === 'custom' && <CustomProxyInput />}
      </div>
    </section>
  );
}

/**
 * 自定义代理模板输入：本地即时回显 + 300ms 防抖写 store。
 * 直接每次按键写 store 会让全站封面 URL 重算并触发一轮图片重载（模板输入时缩略图持续闪烁）。
 */
function CustomProxyInput() {
  const value = useAppStore((s) => s.customImageProxy);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const [draft, setDraft] = useState(value);

  // 外部值变化（如导入配置）时同步回显
  useEffect(() => setDraft(value), [value]);

  useEffect(() => {
    if (draft === value) return;
    const timer = setTimeout(() => updateSettings({ customImageProxy: draft }), 300);
    return () => clearTimeout(timer);
  }, [draft, value, updateSettings]);

  return (
    <input
      className="input w-full"
      aria-label="自定义代理模板"
      placeholder="代理模板，如 https://p.example.com/?url={url}"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
    />
  );
}



function LanguageSettingsPanel() {
  const [language, setLanguage] = useState<"zh" | "en">("zh");
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("libretv-language") || window.localStorage.getItem("friday-language");
      if (saved === "zh" || saved === "en") setLanguage(saved);
    } catch { /* Keep the default language. */ }
  }, []);
  const updateLanguage = (value: string) => {
    const next = value === "en" ? "en" : "zh";
    setLanguage(next);
    try {
      window.localStorage.setItem("libretv-language", next);
      window.localStorage.setItem("friday-language", next);
    } catch { /* Session-only preference. */ }
    document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
    window.dispatchEvent(new CustomEvent("friday-language-preference-change", { detail: { language: next } }));
  };
  return (
    <section>
      <SectionTitle title="语言设置" hint="选择站点与 Friday 的首选语言；设置保存在当前设备" />
      <div className="space-y-3">
        <SelectRow
          label="界面语言"
          value={language}
          onChange={updateLanguage}
          description={language === "zh" ? "当前选择：简体中文" : "Selected: English"}
          options={[
            { value: "zh", label: "简体中文", hint: "Chinese (Simplified)" },
            { value: "en", label: "English", hint: "英语" },
          ]}
        />
        <p className="text-xs text-faint leading-relaxed">Friday 的识别语言、回复语言和语音播报会同步切换。部分站点页面文案目前仍为中文，完整站点翻译需要后续补齐。</p>
      </div>
    </section>
  );
}

function VoiceSettingsPanel() {
  const [assistantId, setAssistantId] = useState<"friday" | "jarvis" | "lin-meimei">("friday");
  const [wakeWordEnabled, setWakeWordEnabled] = useState(false);
  const [voiceStyle, setVoiceStyle] = useState<"auto" | "jarvis" | "warm" | "clear">("auto");
  const [asrLanguage, setAsrLanguage] = useState<"auto" | "zh-CN" | "en-GB">("auto");

  useEffect(() => {
    try {
      const savedAsrLanguage = window.localStorage.getItem("friday-asr-language");
      if (savedAsrLanguage === "zh-CN" || savedAsrLanguage === "en-GB") setAsrLanguage(savedAsrLanguage);
      const savedAssistant = window.localStorage.getItem("friday-assistant");
      if (savedAssistant === "friday" || savedAssistant === "jarvis" || savedAssistant === "lin-meimei") setAssistantId(savedAssistant);
      setWakeWordEnabled(window.localStorage.getItem("friday-wake-word") === "true");
      const savedVoice = window.localStorage.getItem("friday-voice-style");
      if (savedVoice === "jarvis" || savedVoice === "warm" || savedVoice === "clear" || savedVoice === "auto") setVoiceStyle(savedVoice);
    } catch { /* Keep defaults when storage is unavailable. */ }
  }, []);

  const updateAsrLanguage = (value: string) => {
    const next = value === "zh-CN" || value === "en-GB" ? value : "auto";
    setAsrLanguage(next);
    try { window.localStorage.setItem("friday-asr-language", next); } catch { /* Session-only preference. */ }
  };

  const updateAssistant = (value: string) => {
    const next = value === "jarvis" || value === "lin-meimei" ? value : "friday";
    setAssistantId(next);
    try { window.localStorage.setItem("friday-assistant", next); } catch { /* Session-only preference. */ }
    window.dispatchEvent(new CustomEvent("friday-assistant-preference-change", { detail: { assistantId: next } }));
  };
  const updateWakeWord = (value: boolean) => {
    setWakeWordEnabled(value);
    try { window.localStorage.setItem("friday-wake-word", String(value)); } catch { /* Session-only preference. */ }
    window.dispatchEvent(new CustomEvent("friday-wake-word-preference-change", { detail: { enabled: value } }));
  };
  const updateVoiceStyle = (value: string) => {
    const next = value === "jarvis" || value === "warm" || value === "clear" ? value : "auto";
    setVoiceStyle(next);
    try { window.localStorage.setItem("friday-voice-style", next); } catch { /* Session-only preference. */ }
    window.dispatchEvent(new CustomEvent("friday-voice-preference-change", { detail: { voiceStyle: next } }));
  };

  const descriptions: Record<typeof voiceStyle, string> = {
    auto: "跟随助手角色：Jarvis 使用沉稳男声，Friday / 林妹妹使用各自默认声线",
    jarvis: "中文：云希男声 · English：Ryan 英式男声",
    warm: "中文：晓晓女声 · English：Sonia 英式女声",
    clear: "中文：晓伊女声 · English：Ava 美式女声",
  };

  return (
    <section>
      <SectionTitle title="语音设置" hint="助手角色、音色与唤醒方式" />
      <div className="space-y-3">
        <SelectRow
          label="语音识别语言"
          value={asrLanguage}
          onChange={updateAsrLanguage}
          options={[
            { value: "auto", label: "自动跟随", hint: "跟随 Friday 的回复语言" },
            { value: "zh-CN", label: "简体中文", hint: "中文识别" },
            { value: "en-GB", label: "English", hint: "英语识别（英式）" },
          ]}
        />
        <p className="text-xs text-faint leading-relaxed">使用当前浏览器内置的语音识别能力，不提供虚假的第三方引擎切换。更改后从下一次开始聆听时生效；浏览器支持情况与识别服务由浏览器决定。</p>
        <SelectRow
          label="助手角色"
          value={assistantId}
          onChange={updateAssistant}
          options={[
            { value: "friday", label: "Friday", hint: "默认助手" },
            { value: "jarvis", label: "Jarvis", hint: "贾维斯风格" },
            { value: "lin-meimei", label: "林妹妹", hint: "温柔陪伴" },
          ]}
        />
        <ToggleRow
          label="启用唤醒词确认"
          description="语音聆听时可要求先说 Friday；不会后台常驻监听"
          checked={wakeWordEnabled}
          onChange={updateWakeWord}
        />
        <SelectRow
          label="语音音色"
          value={voiceStyle}
          description={descriptions[voiceStyle]}
          onChange={updateVoiceStyle}
          options={[
            { value: "auto", label: "自动匹配", hint: "跟随助手角色" },
            { value: "jarvis", label: "沉稳男声", hint: "云希 / 英式 Ryan" },
            { value: "warm", label: "温柔女声", hint: "晓晓 / 英式 Sonia" },
            { value: "clear", label: "清晰女声", hint: "晓伊 / 美式 Ava" },
          ]}
        />
        <p className="text-xs text-faint leading-relaxed">角色、唤醒词与音色保存在当前设备并立即应用。语音服务不可用时会明确提示，不会静默切换系统声音。</p>
      </div>
    </section>
  );
}

function HomePanel() {
  const store = useAppStore();
  return (
    <section>
      <SectionTitle title="首页与内容过滤" />
      <div className="space-y-3">
        <ToggleRow
          label="成人内容过滤"
          description="过滤“伦理片”等分类的结果"
          checked={store.yellowFilter}
          onChange={(v) => store.updateSettings({ yellowFilter: v })}
        />
        <ToggleRow
          label="首页推荐"
          description="在首页展示推荐内容"
          checked={store.doubanEnabled}
          onChange={(v) => store.updateSettings({ doubanEnabled: v })}
        />
        <SelectRow
          label="推荐数据源"
          value={store.recommendSource}
          onChange={(v) => store.updateSettings({ recommendSource: v as 'douban' | 'bangumi' | 'hot-list' })}
          options={[
            { value: 'douban', label: '豆瓣', hint: '热门电影与剧集' },
            { value: 'bangumi', label: 'Bangumi', hint: '每日新番放送（免 key）' },
            { value: 'hot-list', label: '影视榜单', hint: '豆瓣周榜 / 百度热播' },
          ]}
        />
      </div>
    </section>
  );
}

// —— 数据面板 ——

/**
 * 自动刷新周期选项。值统一用字符串（Dropdown 的 value 是 string），
 * `off` = 纯手动，保持这个功能对存量用户的默认无感。
 */
const REFRESH_OPTIONS: DropdownOption[] = [
  { value: 'off', label: '手动', hint: '只在点 ⟳ 时同步' },
  { value: '1', label: '每天', hint: '打开站点时检查' },
  { value: '3', label: '每 3 天' },
  { value: '7', label: '每 7 天' },
  { value: '14', label: '每 14 天' },
  { value: '30', label: '每 30 天' },
];

/**
 * 数据源订阅 / 分享：
 * - 订阅：填入远程订阅地址（LibreTV-SourceList JSON、TVBOX 配置 JSON 或接口目录 JSON，
 *   由服务端自动识别），一次拉取点播源与直播源，可随时重新同步；
 * - 自动刷新：每个订阅可单独设周期（默认手动），到期才在打开站点时静默同步；
 * - 分享：把当前点播源 + 直播源导出为同格式 JSON 文件，托管到任意位置即可被他人订阅。
 */
function SourceSubscriptions() {
  const store = useAppStore();
  const { toast } = useToast();
  const [subUrl, setSubUrl] = useState('');
  // 每个订阅独立的同步状态，允许多个订阅并行同步（此前单值状态会串台）
  const [syncing, setSyncing] = useState<Set<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const sync = async (url: string) => {
    setSyncing((prev) => new Set(prev).add(url));
    try {
      const { vodCount, liveCount, stats } = await syncSourceSubscription(url);
      // 如实说明跳过/截断情况，避免用户疑惑「配置里站点很多，为何只导入了个位数」
      const detail = describeParseStats(stats, { includeSamples: false });
      const formatLabel =
        stats?.format === 'tvbox'
          ? '（TVBOX 配置）'
          : stats?.format === 'source-catalog'
            ? '（接口源列表）'
            : '';
      toast(`已同步 ${vodCount} 个点播源、${liveCount} 个直播源${formatLabel}${detail ? `；${detail}` : ''}`, 'success');
      setSubUrl('');
    } catch (err) {
      toast(err instanceof Error ? err.message : '订阅同步失败', 'error');
    } finally {
      setSyncing((prev) => {
        const next = new Set(prev);
        next.delete(url);
        return next;
      });
    }
  };

  const addAndSync = () => {
    const url = subUrl.trim();
    if (!validateSourceUrl(url)) {
      toast('订阅地址需以 http:// 或 https:// 开头', 'warning');
      return;
    }
    void sync(url);
  };

  // 发布状态：进行中 + 上一次的发布结果（链接、粘贴板来源与条数）
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState<{
    url: string;
    provider: string;
    sources: number;
    liveSources: number;
  } | null>(null);

  /**
   * 发布当前「已勾选启用」的源：只把真正在参与搜索的源发出去
   * （未勾选的、以及被自动停用的都排除）。注意这与「导出数据源」的全量语义不同。
   */
  const publish = async () => {
    const seen = new Set<string>();
    const sources = store.selectedKeys
      .map((key) => resolveSource(store, key))
      .filter((s): s is SourceConfig => !!s && validateSourceUrl(s.url) && !isSourceDisabled(store, s.key))
      .filter((s) => {
        const key = s.url.replace(/\/+$/, '');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(({ name, url }) => ({ name, url }));

    const liveSeen = new Set<string>();
    const liveSources = allLiveSources(store)
      .filter((s) => store.liveSelectedUrls.includes(s.url))
      .filter((s) => {
        if (liveSeen.has(s.url)) return false;
        liveSeen.add(s.url);
        return true;
      })
      .map(({ name, url, epg }) => ({ name: name || hostnameOf(url), url, epg }));

    if (sources.length === 0 && liveSources.length === 0) {
      toast('没有已勾选启用的源可发布', 'warning');
      return;
    }

    setPublishing(true);
    try {
      const result = await api.publishSourceList({ name: 'LibreTV-SourceList', sources, liveSources });
      setPublished(result);
      toast(`已发布 ${result.sources} 个点播源、${result.liveSources} 个直播源到 ${result.provider}`, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : '发布失败', 'error');
    } finally {
      setPublishing(false);
    }
  };

  const copyPublished = () => {
    if (!published) return;
    copyToClipboard(published.url).then((ok) =>
      ok ? toast('订阅链接已复制', 'success') : toast('复制失败，请手动选中复制', 'warning'),
    );
  };

  const exportSources = () => {
    const all = [...store.envSources, ...store.customAPIs];
    const seen = new Set<string>();
    const sources = all
      .filter((s) => {
        const u = s.url.replace(/\/+$/, '');
        if (seen.has(u)) return false;
        seen.add(u);
        return true;
      })
      .map(({ name, url, detail, isAdult }) => ({ name, url, detail, isAdult }));

    // 直播源：预置 + 手动 + 订阅导入，按 URL 去重
    const liveSeen = new Set<string>();
    const liveSources = [...store.liveEnvSources, ...store.liveSubscriptions]
      .filter((s) => {
        if (liveSeen.has(s.url)) return false;
        liveSeen.add(s.url);
        return true;
      })
      .map(({ name, url, epg }) => ({ name: name || hostnameOf(url), url, epg }));

    const payload = { name: 'LibreTV-SourceList', version: 2, exportedAt: Date.now(), sources, liveSources };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `LibreTV-SourceList_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast(`已导出 ${sources.length} 个点播源、${liveSources.length} 个直播源，托管后即可被他人订阅`, 'success');
  };

  const deleteImpact = (url: string) => {
    const prefix = subKeyPrefix(url);
    return {
      vod: store.customAPIs.filter((a) => keyBelongsToSubscription(a.key, prefix)).length,
      live: store.liveSubscriptions.filter((s) => s.fromSubscriptions.includes(url)).length,
    };
  };

  return (
    <section>
      <SectionTitle
        title="数据源订阅 / 分享"
        extra={
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              className="btn-ghost btn-sm"
              onClick={exportSources}
              disabled={
                store.customAPIs.length + store.envSources.length + store.liveSubscriptions.length + store.liveEnvSources.length ===
                0
              }
            >
              导出数据源
            </button>
            <button
              className="btn-ghost btn-sm"
              onClick={() => void publish()}
              disabled={publishing}
              title="把当前已勾选启用的源上传到公开粘贴板，生成可直接订阅的链接"
            >
              {publishing ? '发布中…' : '发布为链接'}
            </button>
          </div>
        }
      />

      {/* 发布结果：链接公开可读、粘贴板也可能随时清理，这些风险直接写在这里而不是只在 toast 里闪一下 */}
      {published && (
        <div className="mb-3 rounded-lg border border-line bg-chip/60 p-2.5">
          <div className="flex items-center gap-1.5">
            <input
              readOnly
              value={published.url}
              className="input flex-1 min-w-0 !py-1.5 text-xs"
              aria-label="已发布的订阅地址"
              onFocus={(e) => e.currentTarget.select()}
            />
            <button className="btn-ghost btn-sm shrink-0" onClick={copyPublished}>
              复制
            </button>
            <button
              className="btn-ghost btn-sm shrink-0"
              onClick={() => {
                setSubUrl(published.url);
                void sync(published.url);
              }}
            >
              直接订阅
            </button>
          </div>
          <p className="mt-1.5 text-[11px] text-faint leading-relaxed">
            已发布到 {published.provider}（{published.sources} 个点播源、{published.liveSources} 个直播源）。
            链接内容公开可读，粘贴板也可能随时清理——长期使用建议自行托管。
          </p>
        </div>
      )}

      <div className="flex gap-2 mb-2">
        <input
          className="input flex-1 min-w-0"
          placeholder="订阅地址（LibreTV 源列表或 TVBOX 配置的 JSON URL）"
          value={subUrl}
          onChange={(e) => setSubUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addAndSync();
          }}
        />
        <button
          className="btn-primary btn-sm shrink-0"
          disabled={!subUrl.trim() || syncing.size > 0}
          onClick={addAndSync}
        >
          {syncing.size > 0 ? '同步中…' : '订阅'}
        </button>
      </div>
      {store.subscriptions.length === 0 ? (
        <p className="text-xs text-faint">
          一份订阅可同时下发点播源与直播源，支持 LibreTV 源列表与 TVBOX 配置（仅导入可直接使用的接口，Spider 类站点自动跳过）；
          「导出数据源」生成的 JSON 托管到任意 URL 即可分享给他人订阅。
        </p>
      ) : (
        <ul className="space-y-2">
          {store.subscriptions.map((sub) => {
            const vodCount = store.customAPIs.filter((a) => keyBelongsToSubscription(a.key, subKeyPrefix(sub.url))).length;
            const liveCount = store.liveSubscriptions.filter((s) => s.fromSubscriptions.includes(sub.url)).length;
            const isSyncing = syncing.has(sub.url);
            // 自动刷新状态：暂停（连续失败触顶）> 距下次刷新 > 未设周期不提示
            const paused = Boolean(
              sub.refreshDays && (sub.failStreak ?? 0) >= AUTO_REFRESH_MAX_FAIL_STREAK
            );
            const nextAt =
              sub.refreshDays && sub.lastSync ? sub.lastSync + sub.refreshDays * 86_400_000 : undefined;
            const remainingMs = nextAt ? nextAt - Date.now() : 0;
            return (
              <li
                key={sub.url}
                className={cn(
                  'bg-card rounded-lg p-3 transition-colors hover:bg-hover/50',
                  // 与源列表的「未勾选」用同一套停用观感：淡显 + 徽章说明
                  sub.enabled === false && 'opacity-70'
                )}
              >
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-content truncate">{sub.name || hostnameOf(sub.url)}</div>
                    <div className="text-xs text-faint truncate">
                      {sub.url}
                      {sub.lastSync && ` · 同步于 ${formatRelativeTime(sub.lastSync)}`}
                    </div>
                    <div className="mt-1 flex items-center gap-1 flex-wrap">
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">点播 {vodCount}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">直播 {liveCount}</span>
                      {sub.enabled === false && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-warning/15 text-warning">已停用</span>
                      )}
                      {sub.lastStatus === 'error' ? (
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded bg-danger/15 text-danger"
                          title={sub.lastError}
                        >
                          上次同步失败
                        </span>
                      ) : sub.lastStatus === 'ok' && sub.lastCounts ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-success/15 text-success">
                          上次导入 {sub.lastCounts.vod} 点播 / {sub.lastCounts.live} 直播
                        </span>
                      ) : null}
                    </div>
                    {sub.lastStatus === 'error' && sub.lastError && (
                      <p className="text-[11px] text-danger mt-1 break-all">{sub.lastError}</p>
                    )}
                    {/* 自动刷新：默认「手动」，显式设了周期才会在打开站点时静默刷新 */}
                    <div className="mt-1.5 flex items-center gap-1.5 flex-wrap text-[11px] text-faint">
                      <Icon name="clock" className="w-3 h-3 shrink-0" />
                      <span>自动刷新</span>
                      <Dropdown
                        value={sub.refreshDays ? String(sub.refreshDays) : 'off'}
                        onChange={(v) =>
                          store.setSubscriptionRefreshDays(sub.url, v === 'off' ? undefined : Number(v))
                        }
                        options={REFRESH_OPTIONS}
                        ariaLabel="自动刷新周期"
                        className="[&>button]:!py-0.5 [&>button]:!pl-2 [&>button]:!pr-1.5 [&>button]:text-[11px]"
                      />
                      {paused ? (
                        <span className="text-warning">
                          已暂停：连续失败 {sub.failStreak} 次，手动同步成功即恢复
                        </span>
                      ) : remainingMs > 0 ? (
                        <span>约 {Math.max(1, Math.ceil(remainingMs / 86_400_000))} 天后刷新</span>
                      ) : sub.refreshDays ? (
                        <span>下次打开站点时刷新</span>
                      ) : null}
                    </div>
                  </div>
                  <Switch
                    checked={sub.enabled !== false}
                    onChange={(v) => store.setSubscriptionEnabled(sub.url, v)}
                    label={sub.enabled === false ? '启用该订阅' : '停用该订阅'}
                    title={
                      sub.enabled === false
                        ? '当前已停用（其源不参与搜索），点击启用'
                        : '停用后该订阅下的源暂不参与搜索；已导入的数据与各源勾选状态都保留'
                    }
                  />
                  <button
                    className="rounded-md p-2 shrink-0 text-muted transition-colors hover:bg-hover hover:text-accent disabled:opacity-40"
                    disabled={isSyncing}
                    onClick={() => sync(sub.url)}
                    aria-label="重新同步"
                    title="重新同步（以远端列表为准，整体替换该订阅名下的点播源与直播源）"
                  >
                    {isSyncing ? (
                      <Spinner size="sm" />
                    ) : (
                      <Icon name="refresh" className="w-4 h-4" />
                    )}
                  </button>
                  <button
                    className="rounded-md p-2 shrink-0 text-muted transition-colors hover:bg-hover hover:text-danger"
                    onClick={() => setPendingDelete(sub.url)}
                    aria-label="删除订阅"
                    title="删除订阅及其导入的点播源与直播源（保留收藏的频道）"
                  >
                    <Icon name="trash" className="w-4 h-4" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* 重操作：删除订阅会级联移除其导入的源，先确认并说明影响面 */}
      <ConfirmDialog
        open={pendingDelete !== null}
        danger
        title="删除该订阅？"
        message={
          pendingDelete
            ? (() => {
                const impact = deleteImpact(pendingDelete);
                const parts: string[] = [];
                if (impact.vod > 0) parts.push(`${impact.vod} 个点播源`);
                if (impact.live > 0) parts.push(`${impact.live} 个直播源`);
                return parts.length > 0
                  ? `将同时删除该订阅导入的 ${parts.join(' 与 ')}；你收藏的频道会保留。`
                  : '该订阅当前未导入任何源，删除后不影响其他数据。';
              })()
            : undefined
        }
        confirmLabel="删除订阅"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const url = pendingDelete;
          if (url) useAppStore.getState().removeSubscription(url);
          setPendingDelete(null);
          toast('订阅已删除', 'success');
        }}
      />
    </section>
  );
}

/** 配置导入导出（导出受登录门控；导入前先解析预览再确认，避免误覆盖） */
function ConfigIoPanel() {
  const { toast } = useToast();
  const { verified, openLogin } = useAuth();
  const [pending, setPending] = useState<{ file: File; summary: string } | null>(null);

  const doExport = async () => {
    if (verified === false) {
      openLogin();
      return;
    }
    try {
      const json = await exportConfig();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `LibreTV-Settings_${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast('配置已导出', 'success');
    } catch {
      toast('导出失败', 'error');
    }
  };

  const pickImport = async (file: File) => {
    try {
      const summary = summarizeConfig(await file.text());
      setPending({ file, summary });
    } catch (err) {
      toast(err instanceof Error ? err.message : '导入失败', 'error');
    }
  };

  const confirmImport = async () => {
    if (!pending) return;
    try {
      await importConfig(await pending.file.text());
      setPending(null);
      toast('配置导入成功，即将刷新页面', 'success');
      setTimeout(() => window.location.reload(), 1500);
    } catch (err) {
      toast(err instanceof Error ? err.message : '导入失败', 'error');
    }
  };

  return (
    <section>
      <SectionTitle title="配置导入导出" hint="导出/导入包含数据源、订阅与偏好设置的整机配置" />
      <div className="flex gap-2">
        <button className="btn-ghost flex-1 text-xs" onClick={doExport}>
          导出配置
        </button>
        <label className="btn-ghost flex-1 text-xs cursor-pointer">
          导入配置
          <input
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void pickImport(f);
              e.target.value = '';
            }}
          />
        </label>
      </div>

      {/* 重操作：导入会覆盖全部配置，先确认并展示将导入的内容概要 */}
      <ConfirmDialog
        open={pending !== null}
        danger
        title="导入配置并覆盖当前数据？"
        message={pending ? `${pending.summary}。导入后将立即刷新页面，当前设备上的配置与观看历史会被覆盖。` : undefined}
        confirmLabel="导入并覆盖"
        onCancel={() => setPending(null)}
        onConfirm={confirmImport}
      />
    </section>
  );
}

/** 解析配置文件概要（宽松，仅用于导入前预览） */
function summarizeConfig(text: string): string {
  let cfg: { name?: string; data?: Record<string, unknown> };
  try {
    cfg = JSON.parse(text) as { name?: string; data?: Record<string, unknown> };
  } catch {
    throw new Error('文件不是合法的 JSON');
  }
  if (cfg.name !== 'LibreTV-Settings') throw new Error('不是 LibreTV 的配置文件');

  const parts: string[] = [];
  const settingsRaw = cfg.data?.[PERSIST_KEY];
  if (typeof settingsRaw === 'string') {
    try {
      const state = (JSON.parse(settingsRaw) as { state?: Record<string, unknown> }).state ?? {};
      const vod = Array.isArray(state.customAPIs) ? state.customAPIs.length : 0;
      const live = Array.isArray(state.liveSubscriptions) ? state.liveSubscriptions.length : 0;
      const subs = Array.isArray(state.subscriptions) ? state.subscriptions.length : 0;
      parts.push(`${vod} 个点播源`, `${live} 个直播源`, `${subs} 个订阅`);
    } catch {
      /* 设置片段损坏时忽略该部分统计 */
    }
  }
  const historyRaw = cfg.data?.['viewingHistory'];
  if (typeof historyRaw === 'string') {
    try {
      const h = JSON.parse(historyRaw);
      if (Array.isArray(h)) parts.push(`${h.length} 条观看历史`);
    } catch {
      /* 忽略 */
    }
  }
  return parts.length > 0 ? `该文件包含 ${parts.join('、')}` : '该文件未包含可导入的数据';
}

function SourceForm({
  visible,
  initial,
  onCancel,
  onSubmit,
}: {
  visible: boolean;
  initial?: { key: string; name: string; url: string; detail?: string; isAdult?: boolean };
  onCancel: () => void;
  onSubmit: (data: { name: string; url: string; detail?: string; isAdult?: boolean }) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [url, setUrl] = useState(initial?.url ?? '');
  const [detail, setDetail] = useState(initial?.detail ?? '');
  const [isAdult, setIsAdult] = useState(initial?.isAdult ?? false);
  const { toast } = useToast();

  useEffect(() => {
    if (visible) {
      setName(initial?.name ?? '');
      setUrl(initial?.url ?? '');
      setDetail(initial?.detail ?? '');
      setIsAdult(initial?.isAdult ?? false);
    }
  }, [visible, initial]);

  if (!visible) return null;

  const submit = () => {
    const n = name.trim();
    const u = url.trim().replace(/\/+$/, '');
    if (!n || !u) {
      toast('请输入 API 名称和链接', 'warning');
      return;
    }
    if (!validateSourceUrl(u)) {
      toast('API 链接需以 http:// 或 https:// 开头', 'warning');
      return;
    }
    onSubmit({ name: n, url: u, detail: detail.trim() || undefined, isAdult });
  };

  return (
    <div className="space-y-2 border border-line rounded-lg p-3 bg-chip mb-2">
    <input
      className="input w-full"
      aria-label="点播源名称"
      placeholder="名称"
      value={name}
      onChange={(e) => setName(e.target.value)}
    />
    <input
      className="input w-full"
      aria-label="API 地址"
      placeholder="API 地址，如 https://example.com/api.php/provide/vod"
      value={url}
      onChange={(e) => setUrl(e.target.value)}
    />
    <input
      className="input w-full"
      aria-label="详情页地址（可选）"
      placeholder="详情页地址（可选），如 https://example.com"
      value={detail}
      onChange={(e) => setDetail(e.target.value)}
    />
      <label className="flex items-center gap-2 text-xs text-muted">
        <input
          type="checkbox"
          className="h-3.5 w-3.5 accent-pink-500"
          checked={isAdult}
          onChange={(e) => setIsAdult(e.target.checked)}
        />
        标记为成人内容源（受成人过滤控制）
      </label>
      <div className="flex gap-2 justify-end">
        <button className="btn-ghost btn-sm" onClick={onCancel}>
          取消
        </button>
        <button className="btn-primary btn-sm" onClick={submit}>
          {initial ? '更新' : '添加'}
        </button>
      </div>
    </div>
  );
}