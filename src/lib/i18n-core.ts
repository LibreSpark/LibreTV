import { EN } from './i18n-en';

/**
 * 轻量 i18n 核心：以中文原文作为 key，英文词典缺项时回退到原文。
 * 无 React 依赖，lib / 服务端代码也可引用；默认语言为中文，因此单测与服务端行为不变。
 */

export type Lang = 'zh' | 'en';
export type TranslateVars = Record<string, string | number | undefined>;

let currentLang: Lang = 'zh';

export function setCurrentLang(l: Lang): void {
  currentLang = l;
}

export function getCurrentLang(): Lang {
  return currentLang;
}

function format(text: string, vars?: TranslateVars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k] ?? '') : m));
}

/** 翻译函数（toast、错误信息等非组件场景）；以调用时刻的语言为准 */
export function tr(zh: string, vars?: TranslateVars): string {
  const text = currentLang === 'en' ? (EN[zh] ?? zh) : zh;
  return format(text, vars);
}
