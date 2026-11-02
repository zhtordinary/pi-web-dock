export interface QuoteContextItem {
  id: string;
  text: string;
  reply?: string;
  sourceSessionId?: string;
  sourceTurnId?: string;
  sourceEntryId?: string;
  startSnippet?: string;
  endSnippet?: string;
}

export const QUOTE_SHORTCUT_STORAGE_KEY = "pi-quote-shortcut";
export const QUOTE_SHORTCUT_CHANGED_EVENT = "pi-quote-shortcut-changed";
export const DEFAULT_QUOTE_SHORTCUT = "Mod+e";

export function clampSelectionToolbarTop(selectionBottom: number, visibleTop: number, viewportHeight: number): number {
  const minimumTop = Math.max(0, visibleTop) + 8;
  const maximumTop = Math.max(minimumTop, viewportHeight - 50);
  return Math.min(Math.max(minimumTop, selectionBottom + 8), maximumTop);
}

export function getQuotePreviewMaxHeight(anchorTop: number, visibleTop: number, gap = 14): number {
  return Math.max(0, Math.floor(anchorTop - Math.max(0, visibleTop) - gap));
}

/** Builds the quote preamble sent with a message, worded in the current UI language. */
export function formatQuoteItemsToMarkdown(items: QuoteContextItem[], t: (key: string, params?: Record<string, string | number>) => string): string {
  if (!items.length) return "";
  return items
    .map((item, index) => {
      const num = index + 1;
      const quoted = item.text
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      const base = `[${num}] ${t("chat.quoteIntro")}\n\n${quoted}`;
      if (item.reply && item.reply.trim()) {
        return `${base}\n\n${t("chat.quoteReplyLine", { reply: item.reply.trim() })}`;
      }
      return base;
    })
    .join("\n\n");
}

export function loadStoredQuoteShortcut(): string {
  if (typeof window === "undefined") return DEFAULT_QUOTE_SHORTCUT;
  try {
    const val = localStorage.getItem(QUOTE_SHORTCUT_STORAGE_KEY);
    return val && val.trim() ? val.trim() : DEFAULT_QUOTE_SHORTCUT;
  } catch {
    return DEFAULT_QUOTE_SHORTCUT;
  }
}

export function setStoredQuoteShortcut(shortcut: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(QUOTE_SHORTCUT_STORAGE_KEY, shortcut.trim());
  } catch {
    // LocalStorage quota or access denied in private mode.
  }
}

export function isQuoteShortcut(event: KeyboardEvent, shortcut = DEFAULT_QUOTE_SHORTCUT): boolean {
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent || navigator.platform || "");
  const mod = isMac ? event.metaKey : (event.ctrlKey || event.metaKey);
  const key = event.key?.toLowerCase();

  if (shortcut === "Cmd+e") {
    return Boolean(event.metaKey && !event.shiftKey && !event.altKey && key === "e");
  }
  if (shortcut === "Ctrl+e") {
    return Boolean(event.ctrlKey && !event.shiftKey && !event.altKey && key === "e");
  }
  if (shortcut === "Mod+e") {
    return Boolean((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && key === "e");
  }

  const parts = shortcut.toLowerCase().split("+");
  const needMod = parts.includes("mod");
  const needCtrl = parts.includes("ctrl");
  const needMeta = parts.includes("cmd") || parts.includes("meta");
  const needShift = parts.includes("shift");
  const needAlt = parts.includes("alt");
  const targetKey = parts.find((p) => !["mod", "ctrl", "cmd", "meta", "shift", "alt"].includes(p));

  const modMatch = needMod ? mod : true;
  const ctrlMatch = needCtrl ? event.ctrlKey : (!needMod && !needCtrl ? !event.ctrlKey : true);
  const metaMatch = needMeta ? event.metaKey : (!needMod && !needMeta ? !event.metaKey : true);
  const shiftMatch = needShift ? event.shiftKey : !event.shiftKey;
  const altMatch = needAlt ? event.altKey : !event.altKey;
  const keyMatch = targetKey ? key === targetKey : false;

  return modMatch && ctrlMatch && metaMatch && shiftMatch && altMatch && keyMatch;
}
