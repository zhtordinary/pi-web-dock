"use client";

import { useSyncExternalStore } from "react";

export const CHAT_CONTENT_WIDTH_DEFAULT = 90;
export const CHAT_CONTENT_WIDTH_MIN = 50;
export const CHAT_CONTENT_WIDTH_MAX = 100;
export const CHAT_CONTENT_WIDTH_STORAGE_KEY = "pi-chat-content-width";

interface ChatAppearance {
  width: number;
}

const DEFAULT_APPEARANCE: ChatAppearance = {
  width: CHAT_CONTENT_WIDTH_DEFAULT,
};
let appearance: ChatAppearance | null = null;
const listeners = new Set<() => void>();

export function clampChatContentWidth(value: unknown): number {
  const width = value === null || value === "" ? CHAT_CONTENT_WIDTH_DEFAULT : Number(value);
  if (!Number.isFinite(width) || width > CHAT_CONTENT_WIDTH_MAX) return CHAT_CONTENT_WIDTH_DEFAULT;
  return Math.max(CHAT_CONTENT_WIDTH_MIN, Math.round(width));
}

function readStoredPreference(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function applyAppearance({ width }: ChatAppearance): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty("--chat-content-max-width", `${width}%`);
}

function getSnapshot(): ChatAppearance {
  if (typeof window === "undefined") return DEFAULT_APPEARANCE;
  if (!appearance) {
    appearance = {
      width: clampChatContentWidth(readStoredPreference(CHAT_CONTENT_WIDTH_STORAGE_KEY)),
    };
    applyAppearance(appearance);
  }
  return appearance;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function setWidth(value: number): void {
  const width = clampChatContentWidth(value);
  appearance = { width };
  applyAppearance(appearance);
  try {
    window.localStorage.setItem(CHAT_CONTENT_WIDTH_STORAGE_KEY, String(width));
  } catch {
    // Best-effort browser preference persistence.
  }
  listeners.forEach((listener) => listener());
}

export function useChatAppearance() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => DEFAULT_APPEARANCE);
  return { ...snapshot, setWidth };
}
