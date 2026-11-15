import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GlassButton, GlassDialog, GlassPanel, GlassPopover, GlassToolbar } from './glass';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Drawer } from '@/components/drawer';
import { LiquidGlassSurface } from './liquid-glass';

describe('LiquidGlassSurface v1.0', () => {
  it('keeps the semantic button as the host element', () => {
    const html = renderToStaticMarkup(
      createElement(
        LiquidGlassSurface,
        {
          as: 'button',
          type: 'button',
          interactive: true,
          variant: 'control',
          'aria-label': '搜索',
        },
        createElement('span', null, 'Search'),
      ),
    );

    expect(html).toContain('<button');
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-label="搜索"');
    expect(html).toContain('data-liquid-glass="true"');
    expect(html).toContain('data-liquid-glass-engine="fallback"');
    expect(html).toContain('liquid-glass--interactive');
    expect(html).toContain('Search');
  });

  it('keeps navigation links directly inside the semantic nav host', () => {
    const html = renderToStaticMarkup(
      createElement(
        LiquidGlassSurface,
        {
          as: 'nav',
          variant: 'dock',
          'aria-label': '底部导航',
        },
        createElement('a', { href: '/' }, '首页'),
        createElement('a', { href: '/search' }, '搜索'),
      ),
    );

    expect(html).toContain('<nav');
    expect(html).toContain('<a href="/">首页</a>');
    expect(html).toContain('<a href="/search">搜索</a>');
    expect(html).toContain('data-liquid-glass-engine="fallback"');
  });

  it('routes the shared glass primitives through the same engine adapter', () => {
    const html = renderToStaticMarkup(
      createElement(
        'main',
        null,
        createElement(GlassPanel, null, 'Panel'),
        createElement(GlassButton, { 'aria-label': 'Action' }, 'Action'),
        createElement(GlassToolbar, null, 'Toolbar'),
        createElement(GlassPopover, null, 'Popover'),
        createElement(GlassDialog, null, 'Dialog'),
      ),
    );

    expect(html).toContain('glass-panel');
    expect(html).toContain('glass-button');
    expect(html).toContain('glass-toolbar');
    expect(html).toContain('glass-popover');
    expect(html).toContain('glass-dialog');
    expect(html.match(/data-liquid-glass="true"/g)).toHaveLength(5);
    expect(html).toContain('<button');
    expect(html).toContain('role="toolbar"');
    expect(html).toContain('role="dialog"');
  });


  it('keeps shared drawer and alert-dialog semantics while using the glass adapter', () => {
    const drawerHtml = renderToStaticMarkup(
      <Drawer open onClose={() => undefined} title="Settings">
        Settings content
      </Drawer>,
    );
    const confirmHtml = renderToStaticMarkup(
      createElement(ConfirmDialog, {
        open: true,
        title: 'Confirm',
        message: 'Continue?',
        onConfirm: () => undefined,
        onCancel: () => undefined,
      }),
    );

    expect(drawerHtml).toContain('role="dialog"');
    expect(drawerHtml).toContain('data-liquid-glass="true"');
    expect(drawerHtml).toContain('Settings content');
    expect(confirmHtml).toContain('role="alertdialog"');
    expect(confirmHtml).toContain('data-liquid-glass="true"');
    expect(confirmHtml).toContain('Confirm');
  });

});
