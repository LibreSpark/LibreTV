'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useT } from '@/lib/i18n';

/**
 * 主题上下文：light / dark / system，持久化到 localStorage，默认 dark。
 * html 上的 .dark 类由 layout 中的内联脚本先行设置（避免首屏闪烁），此处负责后续切换。
 */

export type ThemeChoice = 'light' | 'dark' | 'system';
const STORAGE_KEY = 'libretv-theme';

interface ThemeContextValue {
  theme: ThemeChoice;
  resolved: 'light' | 'dark';
  setTheme: (t: ThemeChoice) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'dark',
  resolved: 'dark',
  setTheme: () => {},
});

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function apply(choice: ThemeChoice): 'light' | 'dark' {
  const resolved = choice === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : choice;
  document.documentElement.classList.toggle('dark', resolved === 'dark');
  return resolved;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeChoice>('dark');
  const [resolved, setResolved] = useState<'light' | 'dark'>('dark');

  useEffect(() => {
    const stored = (localStorage.getItem(STORAGE_KEY) as ThemeChoice | null) || 'dark';
    setThemeState(stored);
    setResolved(apply(stored));

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      const current = (localStorage.getItem(STORAGE_KEY) as ThemeChoice | null) || 'dark';
      if (current === 'system') {
        setResolved(apply('system'));
      }
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const setTheme = useCallback((t: ThemeChoice) => {
    localStorage.setItem(STORAGE_KEY, t);
    setThemeState(t);
    setResolved(apply(t));
  }, []);

  return <ThemeContext.Provider value={{ theme, resolved, setTheme }}>{children}</ThemeContext.Provider>;
}

/** 亮暗切换按钮：在 light → dark → system 三态间循环 */
export function ThemeToggle() {
  const { theme, resolved, setTheme } = useTheme();
  const t = useT();
  const next: ThemeChoice = theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light';
  const label =
    theme === 'system' ? t('跟随系统（当前深色）') : theme === 'dark' ? t('深色') : t('浅色');
  const nextLabel = next === 'light' ? t('浅色') : next === 'dark' ? t('深色') : t('跟随系统');

  return (
    <button
      className="p-2 rounded-md text-muted hover:text-content hover:bg-hover transition-colors"
      title={t('主题：{label}，点击切换为{next}', { label, next: nextLabel })}
      aria-label={t('切换主题，当前 {label}', { label })}
      onClick={() => setTheme(next)}
    >
      {theme === 'system' ? (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
        </svg>
      ) : resolved === 'dark' ? (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
        </svg>
      ) : (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
        </svg>
      )}
    </button>
  );
}
