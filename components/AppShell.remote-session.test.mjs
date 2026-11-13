import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appShell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const newSessionRoute = await readFile(new URL("../app/api/agent/new/route.ts", import.meta.url), "utf8");
const rpcManager = await readFile(new URL("../lib/rpc-manager.ts", import.meta.url), "utf8");

test("remote ChatWindow keys retain the promoted draft or include both peer and session", () => {
  assert.match(appShell, /remoteSession\.promotedSessionId === remoteSession\.sessionInfo\.id && remoteSession\.draftInstanceKey/);
  assert.match(appShell, /`session:\$\{remoteSession\.device\.id\}:\$\{remoteSession\.sessionInfo\.id\}`/);
});

test("carries context-source metadata through remote and embedded new-session routing", () => {
  assert.match(appShell, /newSessionContextSourceId: options\?\.contextSourceSessionId \?\? null/);
  assert.match(appShell, /contextSourceSessionId: options\.contextSourceSessionId/);
  assert.match(appShell, /data\.contextSourceSessionId/);
  assert.match(appShell, /newSessionContextSourceId=\{remoteSession\.newSessionContextSourceId \?\? null\}/);
  assert.match(appShell, /contextSourceDraftPart = options\?\.contextSourceSessionId/);
  assert.match(appShell, /newSessionContextSourceId \? `:context:\$\{remoteSession\.newSessionContextSourceId\}`/);
  assert.match(appShell, /newSessionContextSourceId \?\? ""/);
  assert.match(newSessionRoute, /contextSourceSessionId \? \{ contextSourceSessionId \}/);
  assert.match(newSessionRoute, /Context source session not found/);
  assert.match(rpcManager, /if \(options\.contextSourceSessionId && !sessionFile\) \{[\s\S]{0,220}contextSourceSessionId = options\.contextSourceSessionId/);
  assert.doesNotMatch(rpcManager, /wrapper\.persistSessionFileNow\(\)/);
  assert.match(rpcManager, /contextSourceSessionId: \(header as unknown as ReaderSessionHeader \| null\)\?\.contextSourceSessionId/);
  assert.match(rpcManager, /contextSourceSessionId: \(header as unknown as ReaderSessionHeader \| null\)\?\.contextSourceSessionId/);
});

test("keeps foreign remote cwd out of local project-trust requests", () => {
  assert.match(appShell, /const resourcePeer = workspaceOwner\.remotePeer \?\? undefined/);
  assert.match(appShell, /const projectTrustCwd = workspaceOwner\.remotePeer \? null : workspaceOwner\.cwd/);
  assert.match(appShell, /if \(!projectTrustCwd\) return;/);
  assert.match(appShell, /fetch\(`\/api\/project-trust\?cwd=\$\{encodeURIComponent\(projectTrustCwd\)\}`/);
});


test("remote navigation clears stale local file context and classifies sessions by server-supplied device identity", () => {
  const openStart = appShell.indexOf("const openRemoteSession");
  const openEnd = appShell.indexOf("// 嵌入页（大面板恒为全部设备）点异设备会话时", openStart);
  assert.ok(openStart >= 0 && openEnd > openStart);
  assert.match(appShell.slice(openStart, openEnd), /updateManualFileContext\(null\)/);
  assert.match(appShell.slice(openStart, openEnd), /setSelectedSession\(null\)/);

  const activityStart = appShell.indexOf("const handleOpenActivitySession");
  const activityEnd = appShell.indexOf("const handleRemoteSessionCreated", activityStart);
  const activity = appShell.slice(activityStart, activityEnd);
  assert.match(activity, /const isLocalSession = item\.device\.id === localDeviceId;/);
  assert.match(activity, /const isRemoteSession = !isLocalSession/);
  assert.match(activity, /fallbackToEmbeddedSession = \(\) => \{\s*updateManualFileContext\(null\)/);
  assert.match(activity, /else \{\s*updateManualFileContext\(null\);\s*\/\/ 远程会话/);
});

test("remote project drafts isolate the local session slot and use the remote cwd", () => {
  const remoteDraftStart = appShell.indexOf("const handleNewActivitySession");
  const remoteDraftEnd = appShell.indexOf("if (device && embeddedReaderUrl", remoteDraftStart);
  assert.ok(remoteDraftStart >= 0 && remoteDraftEnd > remoteDraftStart);
  assert.match(
    appShell.slice(remoteDraftStart, remoteDraftEnd),
    /setSelectedSession\(null\);[\s\S]*setRemoteSession\(\{ device, sessionInfo: null, searchTerm: null, newSessionCwd: cwd/,
  );

  const explorerStart = appShell.indexOf("const activityExplorerContext =");
  const explorerEnd = appShell.indexOf("const explorerContentVisible", explorerStart);
  assert.ok(explorerStart >= 0 && explorerEnd > explorerStart);
  assert.match(appShell.slice(explorerStart, explorerEnd), /const activityExplorerContext = embeddedReaderUrl/);
  assert.match(appShell.slice(explorerStart, explorerEnd), /const activityExplorerCwd = activityExplorerContext\?\.cwd \?\? null/);
});

test("empty activity projects reuse the normal new-session transition", () => {
  const start = appShell.indexOf("const handleActivityProjectCwdChange");
  const end = appShell.indexOf("const handleActivityProjectRemoved", start);
  assert.ok(start >= 0 && end > start);
  const handler = appShell.slice(start, end);
  assert.match(handler, /if \(!cwd\) \{[\s\S]*setSelectedSession\(null\);/);
  assert.match(handler, /handleNewSession\(`activity-\$\{Date\.now\(\)\}`, cwd\)/);
  assert.match(appShell, /handleNewActivitySession[\s\S]*?activeNewSessionDraftKeyRef\.current = null/);
  assert.match(appShell, /handleNewActivitySession[\s\S]*?setNewSessionCwd\(null\)/);
  assert.match(appShell, /handleActivityProjectCwdChange[\s\S]*?if \(!handleNewSession/);
  assert.match(appShell, /handleActivityProjectCwdChange[\s\S]*?setRemoteSession\(null\)/);
});
