'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { SourceManagerDrawer } from '@/components/source-manager';
import { HistoryPanel } from '@/components/history-panel';
import AIFloatingBall from '@/components/AIFloatingBall';
import { SearchModule } from './header/SearchModule';
import { AvatarModule } from './header/AvatarModule';

export function V4HomepageHeader({ overlay = false }: { overlay?: boolean }) {
  const pathname = usePathname();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInstance, setSettingsInstance] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  useEffect(() => {
    const open = () => {
      setSettingsInstance((value) => value + 1);
      setSettingsOpen(true);
    };
    window.addEventListener('libretv:open-source-manager', open);
    return () => window.removeEventListener('libretv:open-source-manager', open);
  }, []);

  useEffect(() => {
    const open = () => setHistoryOpen(true);
    window.addEventListener('libretv:open-history-panel', open);
    return () => window.removeEventListener('libretv:open-history-panel', open);
  }, []);

  return (
    <>
      <header className={'v4-header' + (overlay ? ' is-overlay' : '')}>
        <div className="v4-header-inner v4-header-inner--no-brand">
          {!overlay && (
            <div className="v4-header-actions">
              <SearchModule />
              <AvatarModule pathname={pathname} />
            </div>
          )}
        </div>
      </header>
      {pathname !== '/detail' && <AIFloatingBall showFab inlineMode={false} />}
      <SourceManagerDrawer
        key={settingsInstance}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
      <HistoryPanel open={historyOpen} onClose={() => setHistoryOpen(false)} />
    </>
  );
}
