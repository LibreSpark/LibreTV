import type { Metadata, Viewport } from 'next';
import './globals.css';
import './liquid-glass.css';
import './glass-system.css';
import './eight-screen-glass.css';
import './ipad-glass.css';
import './iphone-glass.css';
// Shared by the homepage header and every V4 spatial channel route.
import './v4-homepage.css';
// Last-loaded contract: identical header surface and navigation on every route.
import './v4-shared-header.css';
// Keep header text and controls contrasted with the active light/dark surface.
import './v4-header-theme.css';
// Final theme layer: keep iOS Safari's bottom safe area in sync with dark mode.
import './theme-safe-area.css';
// Final global contrast layer: dark mode must remain legible on every device and route.
import './theme-global-compat.css';
// Final mobile-only layout contract for LibreTV iPhone Minimal UI V1.0.
import './iphone-minimal-ui.css';
// Final iPhone homepage overrides must win over shared header/theme layers.
import './iphone-home-inline.css';
// PR #84 final recovery layer: normalize document flow and isolate the homepage dock.
import './pr84-layout-recovery.css';
// PR #84 search-page finishing pass: compact field, dock and safe scroll tail.
import './pr84-search-polish.css';
// PR #84 final iPhone fix: translucent four-tab dock, safe-area spacing and orb separation.
import './pr84-dock-fix.css';
// PR #84 unified dark settings detail pages, controls, switches and iOS sub-navigation.
import './pr84-settings-detail.css';
// PR #84 global iPhone layout contract: one dock, safe-area-aware hero and Large Titles.
import './pr84-global-layout.css';
// PR #84 progressive Liquid Glass: static canvas, dynamic surfaces and opt-in SVG refraction.
import './pr84-liquid-refraction.css';
// Final Apple TV-style edge-to-edge dock: 40px blur, dark glass and safe-area fill.
import './pr84-apple-tv-dock.css';
// PR #84 watch-page mobile polish: clean header, readable player controls and fixed horizontal dock.
import './pr84-watch-mobile-fix.css';
// PR #84 Resource Studio: route-scoped dark theme and isolated mobile dock.
import './resource-studio.css';
import { Providers } from '@/components/providers';
import { MobileTabBar } from '@/components/home/header/MobileTabBar';
import { GlobalDownloadManager } from '@/components/download-manager';

export const metadata: Metadata = {
  title: {
    default: 'LibreTV - 免费在线视频搜索与观看平台',
    template: '%s - LibreTV',
  },
  description:
    'LibreTV 是一个免费的在线视频搜索平台，无广告、安全，提供来自多个视频源的内容搜索与观看服务，无需注册即可使用。',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'LibreTV' },
  // 图标与门户站（LibreTV-portal）同一套：同一张 artwork 导出的多尺寸 + 根目录 favicon.ico 兜底。
  // 只声明单张 512 时，抓取端只能拿大图缩放，小尺寸下易糊、看起来「没填满」。
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '48x48' },
      { url: '/icons/icon-96.png', sizes: '96x96', type: 'image/png' },
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
};

export const viewport: Viewport = {
  themeColor: '#000000',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        {/* 首屏前同步主题，避免亮暗闪烁 */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var t=localStorage.getItem('libretv-theme')||'system';var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);var r=d?'dark':'light';document.documentElement.classList.toggle('dark',d);document.documentElement.style.colorScheme=r;var m=document.querySelector('meta[name=\\\"theme-color\\\"]');if(m)m.content=window.location.pathname==='/'?'#000000':(d?'#08080A':'#F5F7FA');}catch(e){}})()",
          }}
        />
      </head>
      <body>
        <Providers>
          {children}
          <MobileTabBar />
          <GlobalDownloadManager />
        </Providers>
      </body>
    </html>
  );
}
