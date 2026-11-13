import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const files = {
  appShell: await readFile(new URL("../components/AppShell.tsx", import.meta.url), "utf8"),
  appToolbar: await readFile(new URL("../components/app-shell-resource-toolbar.tsx", import.meta.url), "utf8"),
  rpc: await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8"),
  rpcPolicy: await readFile(new URL("./rpc-session-tool-policy.ts", import.meta.url), "utf8"),
  chatInput: await readFile(new URL("../components/ChatInput.tsx", import.meta.url), "utf8"),
  draftPrompts: await readFile(new URL("../components/chat-input-draft-prompts.ts", import.meta.url), "utf8"),
};

const lines = (source) => source.split("\n").length;

test("AppShell delegates the resource navigation group to its production module", () => {
  assert.match(files.appShell, /import \{ ResourceToolbar \} from "\.\/app-shell-resource-toolbar"/);
  assert.doesNotMatch(files.appShell, /function ResourceToolbar\(/);
  assert.match(files.appToolbar, /onOpenModels/);
  assert.match(files.appToolbar, /onOpenSkills/);
  assert.match(files.appToolbar, /onOpenPlugins/);
  assert.match(files.appToolbar, /onOpenAgents/);
  assert.ok(lines(files.appShell) < 7824);
});

test("rpc-manager delegates tool and thinking policy decisions to one cohesive module", () => {
  assert.match(files.rpc, /from "\.\/rpc-session-tool-policy"/);
  assert.match(files.rpc, /resolveActiveToolNames\(/);
  assert.match(files.rpc, /readSessionThinkingLevel\(/);
  assert.match(files.rpcPolicy, /resolveShellTools\(/);
  assert.match(files.rpcPolicy, /carry\.filter/);
  assert.match(files.rpcPolicy, /thinking_level_change/);
  assert.ok(lines(files.rpc) < 8575);
});

test("ChatInput delegates draft prompt request cancellation and failure handling", () => {
  assert.match(files.chatInput, /from "\.\/chat-input-draft-prompts"/);
  assert.match(files.chatInput, /createDraftPromptRequestController/);
  assert.doesNotMatch(files.chatInput, /interface DraftPromptRequestControllerOptions/);
  assert.match(files.draftPrompts, /requestIdRef/);
  assert.match(files.draftPrompts, /rewrite_question/);
  assert.match(files.draftPrompts, /rewrite_ste100/);
  assert.match(files.draftPrompts, /setRewrite\(\{ status: "error"/);
  assert.ok(lines(files.chatInput) < 6055);
});
