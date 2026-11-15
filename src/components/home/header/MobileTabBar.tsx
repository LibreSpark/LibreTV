'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LiquidGlassSurface } from '@/components/ui/liquid-glass';

const tabs = [
  { href: '/', label: '首页', icon: 'home' },
  { href: '/search', label: '搜索', icon: 'search' },
  { href: '/settings', label: '设置', icon: 'settings' },
  { href: '/me', label: '我的', icon: 'user' },
] as const;

function TabIcon({ name, active }: { name: (typeof tabs)[number]['icon']; active: boolean }) {
  if (name === 'home') return <svg className={active ? 'is-filled' : ''} viewBox="0 0 24 24" aria-hidden="true"><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z" /></svg>;
  if (name === 'search') return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.2 4.2"/></svg>;
  if (name === 'settings') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z"/><path d="m19.4 13.5 1.1.9-1.1 1.9-1.4-.5a7.7 7.7 0 0 1-1.4.8l-.2 1.5h-2.2l-.4-1.4a7.7 7.7 0 0 1-1.6 0l-.8 1.2-1.9-1.1.5-1.4a7.7 7.7 0 0 1-.8-1.4l-1.5-.2v-2.2l1.4-.4a7.7 7.7 0 0 1 0-1.6L7.9 8.8 9 6.9l1.4.5a7.7 7.7 0 0 1 1.4-.8l.2-1.5h2.2l.4 1.4a7.7 7.7 0 0 1 1.6 0l.8-1.2 1.9 1.1-.5 1.4a7.7 7.7 0 0 1 .8 1.4l1.5.2v2.2l-1.4.4a7.7 7.7 0 0 1 0 1.5Z"/></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.5" /><path d="M4.5 21c.6-4 3.1-6 7.5-6s6.9 2 7.5 6" /></svg>;
}

export function MobileTabBar() {
  const pathname = usePathname();
  const normalized = !pathname || pathname === '/' ? '/' : pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  const activeTab =
    normalized === '/' || normalized === '/detail' || normalized.startsWith('/detail/') ||
    normalized === '/watch' || normalized.startsWith('/watch/') ? '/' :
    normalized === '/search' || normalized.startsWith('/search/') ? '/search' :
    normalized === '/settings' || normalized.startsWith('/settings/') ? '/settings' :
    normalized === '/me' || normalized.startsWith('/me/') ||
    normalized === '/resources' || normalized.startsWith('/resources/') ? '/me' : '';
  const isHomepage = normalized === '/';
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setPortalTarget(document.body);
  }, [isHomepage]);

  const navigation = (
    <LiquidGlassSurface
      as="nav"
      interactive
      variant="dock"
      className="v4-mobile-tabbar"
      aria-label="底部导航"
    >
      {tabs.map((tab) => {
        const active = tab.href === activeTab;
        return (
          <Link key={tab.href} href={tab.href} className={active ? 'is-active' : ''} aria-current={active ? 'page' : undefined}>
            <TabIcon name={tab.icon} active={active} />
            <span>{tab.label}</span>
            {active && <i aria-hidden="true" />}
          </Link>
        );
      })}
    </LiquidGlassSurface>
  );

  return portalTarget ? createPortal(navigation, portalTarget) : null;
}
