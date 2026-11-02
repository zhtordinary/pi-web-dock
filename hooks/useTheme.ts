"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  isDarkTheme,
  isThemePreference,
  THEME_STORAGE_KEY,
  type ResolvedTheme,
  type ThemePreference,
} from "@/lib/theme";
export type { ResolvedTheme, ThemePreference } from "@/lib/theme";

type ThemeState = {
  preference: ThemePreference;
  theme: ResolvedTheme;
};

type ToggleOrigin = { x: number; y: number };

const THEME_URL_PARAM = "theme";
const THEME_CHANGE_EVENT = "pi-theme-changed";

const PREFERENCE_CYCLE: ThemePreference[] = ["light", "dark", "auto"];
const SERVER_SNAPSHOT: ThemeState = { preference: "auto", theme: "light" };
const listeners = new Set<() => void>();
let state: ThemeState | null = null;
let systemListening = false;
let messageListening = false;

function emit(): void {
  listeners.forEach((cb) => cb());
}

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readStoredPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemePreference(value)) return value;
  } catch {
    // Ignore storage errors (private mode, quota, etc.).
  }
  return "auto";
}

function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === "auto" ? getSystemTheme() : preference;
}

function applyDomTheme(theme: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.toggle("dark", isDarkTheme(theme));
}

function readUrlThemeParam(): ThemePreference | null {
  if (typeof window === "undefined") return null;
  try {
    const value = new URLSearchParams(window.location.search).get(THEME_URL_PARAM);
    return isThemePreference(value) ? value : null;
  } catch {
    return null;
  }
}

function ensureState(): ThemeState {
  if (typeof window === "undefined") return SERVER_SNAPSHOT;
  if (state) return state;
  const preference = readUrlThemeParam() ?? readStoredPreference();
  const theme = resolveTheme(preference);
  applyDomTheme(theme);
  state = { preference, theme };
  return state;
}

function broadcastTheme(theme: ResolvedTheme): void {
  if (typeof window === "undefined") return;
  for (const frame of Array.from(document.querySelectorAll("iframe"))) {
    try {
      frame.contentWindow?.postMessage({ type: THEME_CHANGE_EVENT, theme }, "*");
    } catch {
      // Ignore a frame that has gone away.
    }
  }
}

function notifyParent(theme: ResolvedTheme): void {
  try {
    if (typeof window !== "undefined" && window.parent && window.parent !== window) {
      window.parent.postMessage({ type: THEME_CHANGE_EVENT, theme }, "*");
    }
  } catch {
    // Ignore a parent that has gone away.
  }
}

function setThemeState(preference: ThemePreference, theme: ResolvedTheme, persist: boolean): void {
  applyDomTheme(theme);
  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, preference);
    } catch {
      // Ignore storage errors (private mode, quota, etc.).
    }
  }
  state = { preference, theme };
  emit();
  broadcastTheme(theme);
  notifyParent(theme);
}

function handleThemeMessage(event: MessageEvent): void {
  const data = event.data as { type?: string; theme?: unknown } | null;
  if (!data || data.type !== THEME_CHANGE_EVENT || !isThemePreference(data.theme) || data.theme === "auto") return;
  const current = ensureState();
  if (current.theme === data.theme) return;
  setThemeState(data.theme, data.theme, false);
}

function syncAutoThemeFromSystem(): void {
  const current = ensureState();
  if (current.preference !== "auto") return;
  const theme = getSystemTheme();
  if (theme === current.theme) return;
  setThemeState("auto", theme, false);
}

function ensureSystemListener(): void {
  if (systemListening || typeof window === "undefined" || !window.matchMedia) return;
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", syncAutoThemeFromSystem);
  window.addEventListener("focus", syncAutoThemeFromSystem);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") syncAutoThemeFromSystem();
  });
  systemListening = true;
}

function ensureMessageListener(): void {
  if (messageListening || typeof window === "undefined") return;
  window.addEventListener("message", handleThemeMessage);
  messageListening = true;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  ensureState();
  ensureSystemListener();
  ensureMessageListener();
  syncAutoThemeFromSystem();
  return () => listeners.delete(cb);
}

function getSnapshot(): ThemeState {
  return ensureState();
}

function getServerSnapshot(): ThemeState {
  return SERVER_SNAPSHOT;
}

function nextPreference(preference: ThemePreference): ThemePreference {
  const index = PREFERENCE_CYCLE.indexOf(preference);
  return PREFERENCE_CYCLE[(index + 1) % PREFERENCE_CYCLE.length];
}

function withThemeTransition(apply: () => void, origin?: ToggleOrigin): void {
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (typeof document.startViewTransition !== "function" || reduceMotion) {
    apply();
    return;
  }

  const x = origin?.x ?? window.innerWidth / 2;
  const y = origin?.y ?? window.innerHeight / 2;
  const endRadius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  const transition = document.startViewTransition(apply);
  transition.ready
    .then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${endRadius}px at ${x}px ${y}px)`] },
        { duration: 450, easing: "cubic-bezier(0.22, 0.61, 0.36, 1)", pseudoElement: "::view-transition-new(root)" },
      );
    })
    .catch(() => {});
}

export function getThemeSnapshot(): ThemeState {
  return ensureState();
}

export function useTheme() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setThemePreference = useCallback((preference: ThemePreference, origin?: ToggleOrigin) => {
    const apply = () => setThemeState(preference, resolveTheme(preference), true);
    withThemeTransition(apply, origin);
  }, []);

  const toggleTheme = useCallback((origin?: ToggleOrigin) => {
    const current = ensureState();
    setThemePreference(nextPreference(current.preference), origin);
  }, [setThemePreference]);

  return {
    theme: snapshot.theme,
    preference: snapshot.preference,
    toggleTheme,
    setThemePreference,
    isDark: isDarkTheme(snapshot.theme),
  };
}
