export interface TerminalTab {
  id: string;
  cwd: string;
  /** Optional activity peer; absent means the local Reader API. */
  peer?: string;
  restored?: boolean;
  closing?: "close" | "restart";
}

export const TERMINAL_TABS_KEY = "pi-web:terminal-tabs";

export function newTerminalTab(cwd: string, peer?: string): TerminalTab {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { id, cwd, ...(peer ? { peer } : {}) };
}

export function restoreTerminalTabs(raw: string | null): { tabs: TerminalTab[]; activeId: string | null; open: boolean } {
  try {
    const saved = JSON.parse(raw ?? "null");
    const tabs: TerminalTab[] = [];
    for (const tab of Array.isArray(saved?.tabs) ? saved.tabs : []) {
      const peer = typeof tab?.peer === "string" && tab.peer.trim() ? tab.peer.trim() : undefined;
      const cwd = typeof tab?.cwd === "string" ? tab.cwd.trim() : "";
      const sameWorkspace = (existing: TerminalTab) => existing.cwd === cwd && existing.peer === peer;
      if (tab && typeof tab.id === "string" && /^[a-f0-9]{32}$/.test(tab.id)
        && cwd
        && !tabs.some((existing) => existing.id === tab.id || sameWorkspace(existing))) {
        tabs.push({ id: tab.id, cwd, ...(peer ? { peer } : {}), restored: true });
      }
    }
    return { tabs, activeId: tabs.some((tab) => tab.id === saved.activeId) ? saved.activeId : null, open: saved?.open === true };
  } catch {
    return { tabs: [], activeId: null, open: false };
  }
}
