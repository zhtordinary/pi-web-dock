"use client";

import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useI18n } from "@/hooks/useI18n";
import { setTerminalTheme, useTerminalTheme } from "@/hooks/useTerminalTheme";
import { closeTerminal, createTerminalWriter, terminalEventPath, terminalRequest } from "@/lib/terminal-client";
import type { TerminalEvent } from "@/lib/terminal-manager";
import { TERMINAL_XTERM_THEMES, type TerminalTheme } from "@/lib/terminal-theme";
import type { TerminalTab } from "./terminal-tab-state";
import { TerminalExtraKeys } from "./TerminalExtraKeys";
import { createTerminalExtraKeyInput, type TerminalModifiers } from "@/lib/terminal-extra-keys";

interface Props {
  tab: TerminalTab;
  active: boolean;
  onRestart: () => void;
  onClosed: () => void;
  onCloseError: (message: string) => void;
}

export function TerminalPanel({ tab, active, onRestart, onClosed, onCloseError }: Props) {
  const { t } = useI18n();
  const { id, cwd, peer, restored } = tab;
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const startRef = useRef<Promise<void>>(Promise.resolve());
  const writerRef = useRef<ReturnType<typeof createTerminalWriter> | null>(null);
  const callbacksRef = useRef({ onClosed, onCloseError });
  callbacksRef.current = { onClosed, onCloseError };
  const [status, setStatus] = useState<"connecting" | "ready" | "exited" | "error">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [reconnectKey, setReconnectKey] = useState(0);
  const [modifiers, setModifiers] = useState<TerminalModifiers>({ ctrl: false, alt: false });
  const inputRef = useRef<ReturnType<typeof createTerminalExtraKeyInput> | null>(null);
  const theme = useTerminalTheme();
  const themeRef = useRef<TerminalTheme>(theme);
  themeRef.current = theme;
  const ownerKey = JSON.stringify([id, cwd, peer, restored, reconnectKey]);
  const renderScopeKey = JSON.stringify([ownerKey, active, Boolean(tab.closing)]);
  const currentRef = useRef({ ownerKey, active, closing: Boolean(tab.closing), renderScopeKey, epoch: 0 });
  const inputEpoch = currentRef.current.epoch + (currentRef.current.renderScopeKey === renderScopeKey ? 0 : 1);
  currentRef.current = { ownerKey, active, closing: Boolean(tab.closing), renderScopeKey, epoch: inputEpoch };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    let events: EventSource | null = null;
    let offset: number | undefined;
    let connected = false;
    let exited = false;
    let inputFailed = false;
    setStatus("connecting");
    setModifiers({ ctrl: false, alt: false });
    setError(null);
    setExitCode(null);

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: getComputedStyle(container).getPropertyValue("--terminal-font-mono").trim()
        || getComputedStyle(container).getPropertyValue("--font-mono").trim()
        || "monospace",
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 8000,
      screenReaderMode: true,
      disableStdin: true,
      theme: TERMINAL_XTERM_THEMES[themeRef.current],
    });
    terminalRef.current = terminal;
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === "v") return false;
      if ((event.ctrlKey || event.metaKey) && key === "c" && terminal.hasSelection()) return false;
      return true;
    });

    const writer = createTerminalWriter(id, (reason) => {
      if (disposed || currentRef.current.ownerKey !== effectOwnerKey) return;
      inputFailed = true;
      terminal.options.disableStdin = true;
      setError(reason.message);
      setStatus("error");
    }, peer);
    writerRef.current = writer;
    const effectOwnerKey = JSON.stringify([id, cwd, peer, restored, reconnectKey]);
    const input = createTerminalExtraKeyInput({
      scope: () => currentRef.current.epoch,
      enabled: () => !disposed && currentRef.current.ownerKey === effectOwnerKey
        && currentRef.current.active && !currentRef.current.closing && connected && !exited && !inputFailed,
      write: (data) => writer.write(data),
      changed: (selected) => { if (!disposed) setModifiers(selected); },
    });
    inputRef.current = input;
    const onData = terminal.onData((data) => input.data(data));
    const portrait = window.matchMedia("(pointer: coarse) and (orientation: portrait)");
    const clearModifiers = () => input.clear();
    portrait.addEventListener("change", clearModifiers);
    // Capture precedes xterm's textarea paste handler, including a single
    // character pasted when the shell has not enabled bracketed paste.
    container.addEventListener("paste", clearModifiers, true);
    container.addEventListener("compositionstart", clearModifiers, true);
    const fitAndResize = () => {
      if (!container.offsetWidth || !container.offsetHeight) return;
      fit.fit();
    };
    const onResize = terminal.onResize(({ cols, rows }) => {
      if (connected && !exited && !inputFailed) writer.resize(cols, rows);
    });
    const resizeObserver = new ResizeObserver(fitAndResize);
    resizeObserver.observe(container);

    const connect = () => {
      if (disposed || exited || currentRef.current.ownerKey !== effectOwnerKey || !navigator.onLine) return;
      connected = false;
      input.clear();
      terminal.options.disableStdin = true;
      events?.close();
      const stream = new EventSource(terminalEventPath(id, peer, offset));
      events = stream;
      stream.onmessage = (message) => {
        if (disposed || currentRef.current.ownerKey !== effectOwnerKey || events !== stream) return;
        const event = JSON.parse(message.data) as TerminalEvent;
        if (event.type === "output") {
          if (event.reset) terminal.reset();
          else if (offset !== undefined && event.offset <= offset) return;
          terminal.write(event.data);
          offset = event.offset;
        } else {
          exited = true;
          connected = false;
          input.clear();
          terminal.options.disableStdin = true;
          events?.close();
          setExitCode(event.type === "exit" ? event.exitCode : null);
          setStatus("exited");
        }
      };
      stream.onopen = () => {
        if (disposed || exited || currentRef.current.ownerKey !== effectOwnerKey || events !== stream) return;
        input.clear();
        connected = true;
        if (inputFailed) return;
        terminal.options.disableStdin = false;
        setStatus("ready");
        fitAndResize();
        writer.resize(terminal.cols, terminal.rows);
        if (container.offsetWidth && container.offsetHeight) terminal.focus();
      };
      stream.onerror = () => {
        if (disposed || exited || currentRef.current.ownerKey !== effectOwnerKey || events !== stream) return;
        connected = false;
        input.clear();
        terminal.options.disableStdin = true;
        setStatus(events?.readyState === EventSource.CLOSED ? "error" : "connecting");
      };
    };

    startRef.current = (async () => {
      await document.fonts?.ready;
      if (disposed || currentRef.current.ownerKey !== effectOwnerKey) return;
      fitAndResize();
      if (restored || reconnectKey > 0) {
        // Restoring a tab must never silently launch a replacement shell.
        await terminalRequest(`/api/terminal/${encodeURIComponent(id)}`, undefined, peer);
      } else {
        await terminalRequest("/api/terminal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, cwd, cols: terminal.cols, rows: terminal.rows }),
        }, peer);
      }
      connect();
    })().catch((reason: Error) => {
      if (disposed || currentRef.current.ownerKey !== effectOwnerKey) return;
      setError(reason.message);
      setStatus("error");
    });

    const pageHide = () => {
      connected = false;
      input.clear();
      terminal.options.disableStdin = true;
      events?.close();
      events = null;
      if (!exited && !inputFailed) setStatus("connecting");
    };
    const pageShow = (event: PageTransitionEvent) => { if (event.persisted) connect(); };
    window.addEventListener("pagehide", pageHide);
    window.addEventListener("pageshow", pageShow);
    window.addEventListener("offline", pageHide);
    window.addEventListener("online", connect);
    return () => {
      disposed = true;
      input.dispose();
      portrait.removeEventListener("change", clearModifiers);
      container.removeEventListener("paste", clearModifiers, true);
      container.removeEventListener("compositionstart", clearModifiers, true);
      if (inputRef.current === input) inputRef.current = null;
      events?.close();
      void writer.stop();
      resizeObserver.disconnect();
      onData.dispose();
      onResize.dispose();
      window.removeEventListener("pagehide", pageHide);
      window.removeEventListener("pageshow", pageShow);
      window.removeEventListener("offline", pageHide);
      window.removeEventListener("online", connect);
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [id, cwd, peer, restored, reconnectKey]);

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.theme = TERMINAL_XTERM_THEMES[theme];
  }, [theme]);

  useEffect(() => {
    if (active) terminalRef.current?.focus();
    else inputRef.current?.clear();
  }, [active]);

  useEffect(() => {
    if (!tab.closing) return;
    inputRef.current?.clear();
    let cancelled = false;
    if (terminalRef.current) terminalRef.current.options.disableStdin = true;
    void (async () => {
      await closeTerminal(id, startRef.current, writerRef.current, peer);
      if (!cancelled) callbacksRef.current.onClosed();
    })().catch((reason: Error) => {
      if (cancelled) return;
      setError(reason.message);
      setStatus("error");
      callbacksRef.current.onCloseError(reason.message);
    });
    return () => { cancelled = true; };
  }, [id, peer, tab.closing]);

  const nextTheme = theme === "dark" ? "light" : "dark";
  const themeLabel = nextTheme === "light" ? "terminal.lightTheme" : "terminal.darkTheme";

  return (
    <section className="terminal-panel" data-terminal-theme={theme} aria-label={t("terminal.title")}>
      <header className="terminal-panel-header">
        <div className="terminal-panel-path">
          <span className={`terminal-status-dot is-${status}`} title={t(`terminal.${status}`)} />
          <span title={cwd}>{cwd}</span>
        </div>
        <div className="terminal-panel-actions">
          {status === "error" && (
            <button type="button" onClick={() => setReconnectKey((key) => key + 1)} disabled={Boolean(tab.closing)} title={t("terminal.reconnect")} aria-label={t("terminal.reconnect")}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2" />
              </svg>
            </button>
          )}
          <button type="button" onClick={() => setTerminalTheme(nextTheme)} title={t(themeLabel)} aria-label={t(themeLabel)}>
            {nextTheme === "light" ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>
          <button type="button" onClick={onRestart} disabled={Boolean(tab.closing)} title={t("terminal.restart")} aria-label={t("terminal.restart")}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M20 11a8 8 0 1 0-2.34 5.66" /><polyline points="20 4 20 11 13 11" />
            </svg>
          </button>
        </div>
      </header>
      <div>
        {error && <div className="terminal-panel-error" role="alert">{error}</div>}
        {status === "exited" && <div className="terminal-panel-exit" role="status">{exitCode === null ? t("terminal.exited") : t("terminal.exitCode", { code: exitCode })}</div>}
      </div>
      <div className="terminal-xterm"><div ref={containerRef} className="terminal-xterm-host" /></div>
      <TerminalExtraKeys
        modifiers={modifiers} disabled={!active || status !== "ready" || Boolean(tab.closing)}
        onKey={(key) => {
          if (currentRef.current.epoch !== inputEpoch) return;
          const terminal = terminalRef.current;
          if (!terminal) return;
          inputRef.current?.key(key, terminal.modes.applicationCursorKeysMode);
          if (currentRef.current.active && !currentRef.current.closing) terminal.focus();
        }}
        onToggleModifier={(modifier) => {
          if (currentRef.current.epoch !== inputEpoch) return;
          inputRef.current?.toggle(modifier);
          if (currentRef.current.active && !currentRef.current.closing) terminalRef.current?.focus();
        }}
      />
    </section>
  );
}
