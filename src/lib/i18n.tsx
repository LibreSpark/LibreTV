'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { tr, setCurrentLang, type Lang, type TranslateVars } from './i18n-core';

export { tr };
export type { Lang, TranslateVars };

/**
 * i18n 的 React 层：语言上下文、切换按钮。翻译核心见 i18n-core（无 React 依赖，服务端/lib 可用）。
 * 语言持久化到 localStorage；服务端与首次渲染固定为中文，挂载后再切换（与主题同一做法，避免 hydration 不一致）。
 * 非组件代码（store、lib）用 tr()，读取模块级的当前语言。
 */

const STORAGE_KEY = 'libretv-lang';

interface I18nContextValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (zh: string, vars?: TranslateVars) => string;
}

const I18nContext = createContext<I18nContextValue>({
  lang: 'zh',
  setLang: () => {},
  t: tr,
});

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

/** 取翻译函数；语言切换时组件会随上下文重新渲染 */
export function useT(): I18nContextValue['t'] {
  return useContext(I18nContext).t;
}

function applyLang(l: Lang) {
  setCurrentLang(l);
  document.documentElement.lang = l === 'en' ? 'en' : 'zh-CN';
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>('zh');

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'en' || stored === 'zh') {
        applyLang(stored);
        setLangState(stored);
      }
    } catch {
      /* localStorage 不可用时保持默认 */
    }
  }, []);

  const setLang = useCallback((l: Lang) => {
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* 忽略 */
    }
    applyLang(l);
    setLangState(l);
  }, []);

  // lang 变化时 t 的引用随之变化，使依赖 t 的 memo/effect 也能更新
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const t = useCallback((zh: string, vars?: TranslateVars) => tr(zh, vars), [lang]);

  return <I18nContext.Provider value={{ lang, setLang, t }}>{children}</I18nContext.Provider>;
}

/** 语言切换按钮：中文 ⇄ English */
export function LangToggle() {
  const { lang, setLang, t } = useI18n();
  const next: Lang = lang === 'zh' ? 'en' : 'zh';
  return (
    <button
      className="px-2 py-1.5 rounded-md text-xs font-medium text-muted hover:text-content hover:bg-hover transition-colors"
      title={t('切换语言')}
      aria-label={t('切换语言')}
      onClick={() => setLang(next)}
    >
      {lang === 'zh' ? 'EN' : '中文'}
    </button>
  );
}
