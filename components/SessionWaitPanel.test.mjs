import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";
const source = await readFile(new URL("./SessionWaitPanel.tsx", import.meta.url), "utf8");
const shell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const chat = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("session relation trigger stays inline while the expanded panel uses the top layer", () => {
  for (const marker of ["sessionRelationGroups", "mergeSessionRelationSnapshots", "peer.deviceName", "source?.deviceId", "operation, waitId", "count === 0", 'direction === "incoming"', "continuationStatus"]) assert.ok(source.includes(marker), marker);
  assert.match(source, /aria-haspopup="dialog" aria-expanded=\{open\}/);
  assert.match(source, /document.addEventListener\("pointerdown", outside\)/);
  assert.match(source, /event.preventDefault\(\); event.stopPropagation\(\)/, "Escape must not also abort the session");
  assert.match(source, /onMouseEnter=/); assert.match(source, /onMouseLeave=/);
  assert.match(source, /wait.stale/); assert.match(source, /!wait.source\?\.online/);
  assert.match(shell, /const sessionTopBar[\s\S]*<SessionWaitPanel[\s\S]*sessionId=\{topBarSessionId\}[\s\S]*peerId=\{topBarSessionPeer\}/);
  assert.match(shell, /<SessionWaitHistory onOpenSession=\{handleOpenRelatedSession\}/);
  assert.doesNotMatch(chat, /<SessionWaitPanel\b/, "session relation trigger is owned by the app status bar");
  const sessionTopBarStart = shell.indexOf("const sessionTopBar");
  const sessionTopBarEnd = shell.indexOf("  const chatWindowContent", sessionTopBarStart);
  const relationMount = shell.indexOf("<SessionWaitPanel", sessionTopBarStart);
  const sidekickMount = shell.indexOf("id={SIDEKICK_TOPBAR_PORTAL_ID}", relationMount);
  assert.ok(sessionTopBarStart >= 0 && relationMount > sessionTopBarStart && relationMount < sidekickMount && sidekickMount < sessionTopBarEnd, "session relation trigger mounts before the sidekick trigger in the session status bar");
  assert.match(source, /position: "relative", zIndex: 45, display: "flex", alignItems: "center", height: "100%", flexShrink: 0/);
  assert.match(source, /createPortal/);
  assert.match(source, /document\.body/);
  assert.match(source, /position: "fixed"/);
  assert.match(source, /zIndex: 1200/);
  assert.match(source, /panelPosition/);
  assert.match(source, /panelRef/);
  assert.match(source, /maxWidth: "min\(360px, calc\(100vw - 24px\)\)"/);
  assert.doesNotMatch(source, /position: "absolute", left: 12, right: rightInset/);
  assert.doesNotMatch(source, /top: "calc\(100% \+ 6px\)"/);
  assert.doesNotMatch(source, /bottom: .*offset/);
});

test("wait refresh remains event-driven, preserves offline records and rejects late unmounted updates", () => {
  assert.match(source, /openReaderEventSource\(\["waits_changed", "running", "peer_state"\]\)/);
  assert.match(source, /JSON.parse\(data\).type !== "running"/);
  assert.match(source, /refreshRef.current === refresher/);
  assert.match(source, /refresher.dispose\(\)/);
  assert.match(source, /setSnapshot\(previous => mergeSessionRelationSnapshots/);
});

test("history is a lazy secondary disclosure and empty sessions do not render floating chrome", async () => {
  const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, alias: { "@": process.cwd() }, moduleCache: true });
  const React = await jiti.import("react");
  const { renderToStaticMarkup } = await jiti.import("react-dom/server");
  const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
  const { SessionWaitPanel, SessionWaitHistory } = await jiti.import("./SessionWaitPanel.tsx");
  const render = element => renderToStaticMarkup(React.createElement(I18nProvider, null, element));
  assert.equal(render(React.createElement(SessionWaitPanel, { sessionId: "A" })), "");
  const history = render(React.createElement(SessionWaitHistory));
  assert.match(history, /<summary[^>]*>等待与监控历史<\/summary>/);
  assert.doesNotMatch(history, /data-session-wait-history|role="dialog"/, "closed history does not mount another status reader");
});
