import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const [appShell, chatWindow, settings, inspector, sessionActivity, rpc, route, lightbox, preview] = await Promise.all([
  read("components/AppShell.tsx"),
  read("components/ChatWindow.tsx"),
  read("components/UnifiedSettingsModal.tsx"),
  read("components/SystemPromptInspector.tsx"),
  read("components/SessionActivityPanel.tsx"),
  read("lib/rpc-manager.ts"),
  read("app/api/remote/[...path]/route.ts"),
  read("components/ImageLightbox.tsx"),
  read("components/ImagePreview.tsx"),
]);

test("actual settings and tool callbacks reach every ChatWindow owner", () => {
  assert.match(settings, /SettingsTab = .*"mcp"/);
  assert.match(settings, /<McpConfig[\s\S]*remotePeer=\{remotePeer\}/);
  assert.match(appShell, /const handleOpenSettings = useCallback/);
  assert.ok((appShell.match(/onOpenSettings=\{handleOpenSettings\}/g) ?? []).length >= 3);
  const owners = appShell.match(/<ChatWindow\b[\s\S]*?\/>/g) ?? [];
  assert.equal(owners.length, 3, "only the local, remote-live and remote-draft owners remain");
  assert.ok(owners.every(owner => owner.includes("onSystemToolsChange={handleSystemToolsChange}")));
  assert.match(appShell, /locked=\{branchSwitchLocked\}/);
  assert.match(chatWindow, /onSystemToolsChange\?:/);
  assert.match(chatWindow, /onSystemToolsChange, onRuntimeInspectionChange/);
  assert.match(inspector, /tools\?: ToolEntry\[\] \| null/);
});

test("subagent owners do not claim completion, attention, or activity sounds", () => {
  assert.match(appShell, /isSubagentSession\(sourceSession\)/);
  assert.match(appShell, /suppressStatusSounds=\{isSubagentSession/);
  assert.match(sessionActivity, /currentItem\?\.session\.relation\?\.kind === "subagent"/);
  assert.match(sessionActivity, /item\.session\.relation\?\.kind === "subagent"/);
});

test("MCP prompt lifecycle preserves the four-argument wrapper and optional host", () => {
  assert.match(rpc, /fastModeState: \{ mode: FastModeSelection \} = \{ mode: "default" \}, mcpOptions: \{/);
  assert.match(rpc, /mcpHost\?: Pick<McpHost, "prepareForPrompt" \| "dispose">/);
  assert.match(rpc, /mcpPromptPreparation\(/);
  assert.match(rpc, /wait\.controller\.abort\(\)/);
  assert.match(rpc, /this\.disposeMcpHost\(\)/);
  assert.match(rpc, /createPiWebBuiltinExtensions/);
  assert.match(rpc, /createReadOnlyMcpPolicyExtension\(\)/);
});

test("remote MCP test timeout is exact and image Escape owns the top modal", () => {
  assert.match(route, /method === "POST" && path\.length === 2 && path\[0\] === "mcp" && path\[1\] === "test"/);
  assert.match(route, /AbortSignal\.timeout\(isMcpTest \? 65_000 : 12_000\)/);
  assert.match(lightbox, /listenForStackedDialogEscape\(document, onClose\)/);
  assert.match(lightbox, /closeButtonRef\.current\?\.focus/);
  assert.match(preview, /listenForStackedDialogEscape\(document, closePreview\)/);
});
