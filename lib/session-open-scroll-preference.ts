// Where the transcript should land when a session is opened.
//
// "last-question" puts the newest user message near the top of the viewport so
// the answer that follows it reads naturally from its start. "answer-bottom"
// pins to the very end, i.e. the newest content.
//
// The preference is device-local UI state, so it lives in localStorage next to
// the other General settings and broadcasts a change event for the mounted
// transcript.

export const SESSION_OPEN_SCROLL_STORAGE_KEY = "pi-session-open-scroll";
export const SESSION_OPEN_SCROLL_CHANGED_EVENT = "pi-session-open-scroll-changed";

export type SessionOpenScroll = "last-question" | "answer-bottom";

export type SessionOpenScrollLanding = {
  target: "last-question" | "answer-bottom";
  follow: false;
};

export const DEFAULT_SESSION_OPEN_SCROLL: SessionOpenScroll = "last-question";

export function resolveSessionOpenScrollLanding(
  preference: SessionOpenScroll,
  pinnedLastQuestion: boolean,
): SessionOpenScrollLanding {
  return preference === "last-question" && pinnedLastQuestion
    ? { target: "last-question", follow: false }
    : { target: "answer-bottom", follow: false };
}

export function normalizeSessionOpenScroll(value: unknown): SessionOpenScroll {
  return value === "answer-bottom" ? "answer-bottom" : "last-question";
}

export function isSessionOpenScroll(value: unknown): value is SessionOpenScroll {
  return value === "last-question" || value === "answer-bottom";
}

export function loadSessionOpenScroll(): SessionOpenScroll {
  if (typeof window === "undefined") return DEFAULT_SESSION_OPEN_SCROLL;
  try {
    const stored = window.localStorage.getItem(SESSION_OPEN_SCROLL_STORAGE_KEY);
    if (stored === null) return DEFAULT_SESSION_OPEN_SCROLL;
    return normalizeSessionOpenScroll(stored);
  } catch {
    return DEFAULT_SESSION_OPEN_SCROLL;
  }
}

export function setSessionOpenScroll(value: SessionOpenScroll): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SESSION_OPEN_SCROLL_STORAGE_KEY, value);
  } catch {
    // Storage unavailable: keep the in-memory default rather than failing the panel.
  }
  try {
    window.dispatchEvent(new Event(SESSION_OPEN_SCROLL_CHANGED_EVENT));
  } catch {
    // Event dispatch can be unavailable in non-browser test/SSR shims.
  }
}
