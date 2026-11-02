"use client";

import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState } from "react";
import { getLocalePlugin, getSupportedLocales, LOCALE_PREFERENCE_KEY, parseLocale } from "@/lib/i18n/registry";
import { translateMessage } from "@/lib/i18n/format";
import type { Locale, LocalePlugin, TranslationParams } from "@/lib/i18n/types";

const defaultLocale: Locale = "zh-CN";
const LOCALE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, params?: TranslationParams) => string;
  supportedLocales: LocalePlugin[];
}

const I18nContext = createContext<I18nContextValue | null>(null);

function getMessages(): Record<string, Record<string, string>> {
  return Object.fromEntries(getSupportedLocales().flatMap((id) => {
    const plugin = getLocalePlugin(id);
    return plugin ? [[id, plugin.messages]] : [];
  }));
}

function readStoredLocale(): Locale | undefined {
  try {
    return parseLocale(window.localStorage.getItem(LOCALE_PREFERENCE_KEY));
  } catch {
    // 隐私模式或存储不可用时沿用服务端按请求协商的语言。
    return undefined;
  }
}

// 服务端渲染首屏时只能读到 Cookie，因此语言偏好同时写入 Cookie。
function writeLocaleCookie(locale: Locale): void {
  document.cookie = `${LOCALE_PREFERENCE_KEY}=${locale}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
}

/**
 * 提供 Pi Web 的界面语言状态和翻译能力。
 * @param props React 子节点，以及服务端按语言偏好 Cookie 和 Accept-Language 协商出的首屏语言
 * @returns 包含语言上下文的 React 节点
 */
export function I18nProvider({ children, initialLocale = defaultLocale }: { children: React.ReactNode; initialLocale?: Locale }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const supportedLocales = useMemo(
    () => getSupportedLocales().map((id) => getLocalePlugin(id)).filter((plugin): plugin is LocalePlugin => Boolean(plugin)),
    [],
  );
  const messages = useMemo(() => getMessages(), []);

  useLayoutEffect(() => {
    const stored = readStoredLocale();
    if (!stored) return;
    writeLocaleCookie(stored);
    if (stored === initialLocale) return;
    setLocaleState(stored);
    document.documentElement.lang = stored;
  }, [initialLocale]);

  const setLocale = useCallback((next: Locale) => {
    if (!getLocalePlugin(next)) return;
    setLocaleState(next);
    document.documentElement.lang = next;
    writeLocaleCookie(next);
    try {
      window.localStorage.setItem(LOCALE_PREFERENCE_KEY, next);
    } catch {
      // 存储失败不影响当前页面内的语言切换。
    }
  }, []);

  const t = useCallback((key: string, params?: TranslationParams) => translateMessage(locale, key, messages, params), [locale, messages]);
  const value = useMemo(() => ({ locale, setLocale, t, supportedLocales }), [locale, setLocale, t, supportedLocales]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/**
 * 获取当前组件树中的国际化能力。
 * @returns 当前 locale、翻译函数、语言切换函数和支持的语言列表
 * @throws 当组件不在 I18nProvider 内时抛出异常
 */
export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useI18n must be used inside I18nProvider");
  return context;
}
