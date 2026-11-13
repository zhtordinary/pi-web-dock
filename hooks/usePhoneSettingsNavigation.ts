"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Level = "home" | "section" | "detail";
interface View { level: Level; title: string }
interface Entry extends View { owner: string; depth: number }

const HISTORY_KEY = "__readerPhoneSettings";
let pendingUnwind: Promise<void> | null = null;

function unwindHistory(owner: string, depth: number) {
  const pending = new Promise<void>((resolve) => {
    const onPopState = (event: PopStateEvent) => {
      if (readEntry(event.state)?.owner === owner) return;
      window.removeEventListener("popstate", onPopState);
      resolve();
    };
    window.addEventListener("popstate", onPopState);
    window.history.go(-depth);
  });
  pendingUnwind = pending;
  void pending.then(() => { if (pendingUnwind === pending) pendingUnwind = null; });
}

function readEntry(state: unknown): Entry | null {
  if (!state || typeof state !== "object") return null;
  const entry = (state as Record<string, unknown>)[HISTORY_KEY] as Partial<Entry> | undefined;
  if (!entry || typeof entry.owner !== "string" || !Number.isInteger(entry.depth) || (entry.depth ?? 0) < 1
    || !["home", "section", "detail"].includes(entry.level ?? "") || typeof entry.title !== "string") return null;
  return entry as Entry;
}

/** Owns only the history entries added by this open Settings panel. */
export function usePhoneSettingsNavigation(
  isPhone: boolean,
  startAtHome: boolean,
  onExit: () => boolean,
  isBlocked: () => boolean,
) {
  const [view, setView] = useState<View>({ level: startAtHome ? "home" : "section", title: "" });
  const viewRef = useRef(view);
  const callbacks = useRef({ onExit, isBlocked });
  callbacks.current = { onExit, isBlocked };
  const controls = useRef<{ enterSection: () => void; openDetail: (title: string) => void; closeDetail: () => void; back: () => void } | null>(null);
  const desktopSeen = useRef(false);

  useEffect(() => {
    if (!isPhone) {
      if (typeof window !== "undefined" && !window.matchMedia?.("(max-width: 640px)").matches) desktopSeen.current = true;
      return;
    }
    let disposed = false;
    let disposeNavigation = () => {};
    const initialize = () => {
      if (disposed) return;
      const owner = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
      const initialUrl = window.location.href;
      let depth = 0;
      let moving = false;
      const apply = (next: View) => { viewRef.current = next; setView(next); };
      const push = (next: View) => {
        const previous = window.history.state;
        const state = previous && typeof previous === "object" ? previous : {};
        try {
          window.history.pushState({ ...state, [HISTORY_KEY]: { ...next, owner, depth: depth + 1 } }, "", window.location.href);
          depth += 1;
        } catch {
          depth = 0;
        }
        apply(next);
      };
      const back = () => {
        if (moving) return;
        const entry = readEntry(window.history.state);
        if (entry?.owner === owner && entry.depth > 1) {
          moving = true;
          window.history.back();
        } else {
          apply({ level: viewRef.current.level === "detail" ? "section" : "home", title: "" });
        }
      };
      const onPopState = (event: PopStateEvent) => {
        moving = false;
        const previousView = viewRef.current;
        const entry = readEntry(event.state);
        depth = entry?.owner === owner ? entry.depth : 0;
        if (callbacks.current.isBlocked()) {
          push(previousView);
        } else if (entry?.owner === owner) {
          apply({ level: entry.level, title: entry.title });
        } else if (!callbacks.current.onExit()) {
          push(previousView);
        }
      };
      window.addEventListener("popstate", onPopState);
      controls.current = {
        enterSection: () => { if (viewRef.current.level === "home") push({ level: "section", title: "" }); },
        openDetail: (title) => { if (viewRef.current.level === "section") push({ level: "detail", title }); },
        closeDetail: () => { if (viewRef.current.level === "detail") back(); },
        back,
      };
      push({ level: "home", title: "" });
      if (!startAtHome || desktopSeen.current) push({ level: "section", title: "" });
      disposeNavigation = () => {
        controls.current = null;
        window.removeEventListener("popstate", onPopState);
        const entry = readEntry(window.history.state);
        if (entry?.owner === owner && window.location.href === initialUrl) unwindHistory(owner, entry.depth);
      };
    };
    if (pendingUnwind) void pendingUnwind.then(initialize);
    else initialize();
    return () => { disposed = true; disposeNavigation(); };
  }, [isPhone, startAtHome]);

  const enterSection = useCallback(() => controls.current?.enterSection(), []);
  const openDetail = useCallback((title: string) => controls.current?.openDetail(title), []);
  const closeDetail = useCallback(() => controls.current?.closeDetail(), []);
  const back = useCallback(() => controls.current?.back(), []);
  return { level: isPhone ? view.level : "section", title: view.title, enterSection, openDetail, closeDetail, back };
}
