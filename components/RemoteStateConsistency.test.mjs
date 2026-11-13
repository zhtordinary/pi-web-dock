import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [appShell, chatInput, chatWindow, modelsConfig, imageGenConfig, skillsConfig, pluginsConfig, agentSession, hiddenModelProviders] = await Promise.all([
  readFile(new URL("./AppShell.tsx", import.meta.url), "utf8"),
  readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8"),
  readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8"),
  readFile(new URL("./ModelsConfig.tsx", import.meta.url), "utf8"),
  readFile(new URL("./ImageGenConfig.tsx", import.meta.url), "utf8"),
  readFile(new URL("./SkillsConfig.tsx", import.meta.url), "utf8"),
  readFile(new URL("./PluginsConfig.tsx", import.meta.url), "utf8"),
  readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8"),
  readFile(new URL("../hooks/useHiddenModelProviders.ts", import.meta.url), "utf8"),
]);

test("all four scope/Monitor paths share provider visibility and remote resource state", () => {
  // Provider visibility is browser UI state, not models.json scope. The
  // aggregate shell must seed and continuously broadcast it to cross-origin
  // session-only and full-device iframes; iframe composers must consume it.
  assert.match(chatInput, /useHiddenModelProviders/);
  assert.match(hiddenModelProviders, /COLLAPSED_PROVIDERS_SYNC_EVENT/);
  assert.match(hiddenModelProviders, /window\.parent\.postMessage\(\{ type: COLLAPSED_PROVIDERS_REQUEST_EVENT \}/);
  assert.match(hiddenModelProviders, /data\?\.type !== COLLAPSED_PROVIDERS_SYNC_EVENT/);
  assert.match(appShell, /contentWindow\?\.postMessage\(\s*\{ type: COLLAPSED_PROVIDERS_SYNC_EVENT, providers,/);
  assert.match(appShell, /window\.addEventListener\(COLLAPSED_PROVIDERS_CHANGED_EVENT/);

  // Monitor-on aggregate remote ChatWindow must use target-device APIs for
  // generation and skill state, exactly like monitor-off/full-device iframes.
  assert.match(chatInput, /remotePeer\?: string;/);
  assert.match(chatWindow, /<ChatInput\s[\s\S]*?remotePeer=\{remotePeer\}/);
  assert.match(chatInput, /apiPathForPeer\(remotePeer, path\)/);
  assert.match(chatInput, /apiPath\("image-gen"\)/);
  assert.match(chatInput, /apiPath\(`skills\?cwd=\$\{encodeURIComponent\(requestCwd\)\}`\)/);
  assert.match(chatInput, /apiPath\(fileIndexRequestPath\(fetchCwd, query, hideGitIgnored\)\)/);
  assert.match(chatInput, /apiPath\(fileIndexRequestPath\(fetchCwd, undefined, hideGitIgnored\)\)/);
  assert.match(imageGenConfig, /remotePeer\?: string/);
  assert.match(imageGenConfig, /apiFor\(remotePeer, "image-gen"\)/);
  assert.match(skillsConfig, /remotePeer\?: string/);
  assert.match(skillsConfig, /api\([^)]*skills/);
  assert.match(pluginsConfig, /remotePeer\?: string/);
  assert.match(pluginsConfig, /apiFor\(owner\.peer, `plugins\?cwd=/);
  assert.match(agentSession, /const modelsUrl = modelCwd \? apiPath\(/);

  // Resource panels already follow the active session's device/cwd; keep this
  // assertion here so a future path split cannot silently regress the bridge.
  assert.match(appShell, /const resourcePeer = workspaceOwner\.remotePeer/);
  assert.match(appShell, /remotePeer=\{resourcePeer\}/);
  assert.match(modelsConfig, /remotePeer\?: string/);
  assert.match(skillsConfig, /remotePeer\?: string/);
});

test("only the image settings editor opts into saved provider key projection", () => {
  assert.match(imageGenConfig, /includeProviderKeys=1/);
  assert.doesNotMatch(chatInput, /includeProviderKeys=1/);
});

test("remote ChatWindow preserves peer routing for historical and streaming markdown", () => {
  // MarkdownBody already knows how to turn a local file reference into either
  // /api/files or /api/remote/files. The ChatWindow must keep the selected
  // device peer attached to both message paths; otherwise aggregate Monitor
  // renders images against the outer device while an iframe still works.
  assert.match(
    chatWindow,
    /sessionId=\{session\?\.id \?\? sessionIdRef\.current \?\? undefined\}\s+remotePeer=\{remotePeer\}\s+calculatedCost=/,
  );
  assert.match(
    chatWindow,
    /<StreamingReply[\s\S]{0,600}remotePeer=\{remotePeer\}/,
  );
});
