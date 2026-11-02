import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ImageGenConfig.tsx", import.meta.url), "utf8");
const priceSource = await readFile(new URL("./ImageGenerationPrice.tsx", import.meta.url), "utf8");
const appShell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("output directory scope selection is view-only until explicit edit", () => {
  assert.match(source, /const \[selectedDirScope, setSelectedDirScope\]/);
  assert.match(source, /setSelectedDirScope\("project"\)/);
  assert.match(source, /setSelectedDirScope\("global"\)/);
  assert.doesNotMatch(source, /onClick=\{\(\) => beginDirEdit\("project"\)\}/);
  assert.doesNotMatch(source, /onClick=\{\(\) => beginDirEdit\("global"\)\}/);
  assert.match(source, /onClick=\{\(\) => beginDirEdit\(activeDirScope\)\}/);
  assert.match(source, /gen\.outputDirProject \?\? gen\.outputDirGlobal/);
  assert.match(source, /onClick=\{\(\) => editingDir \? selectEditScope\("project"\) : setSelectedDirScope\("project"\)\}/);
  assert.match(source, /onClick=\{\(\) => editingDir \? selectEditScope\("global"\) : setSelectedDirScope\("global"\)\}/);
});

test("output directory scope controls stay beside the title in both view and edit modes", () => {
  const start = source.indexOf('className="image-gen-output-header"');
  const end = source.indexOf("{editingDir ? (", start);
  assert.ok(start >= 0 && end > start);
  const header = source.slice(start, end);
  assert.match(header, /chat\.genOutputDir"/);
  assert.match(header, /flexWrap: "wrap"/);
  assert.equal((header.match(/className="image-gen-output-scope-button"/g) ?? []).length, 2);
  for (const scope of ["project", "global"]) {
    assert.ok(header.includes(`aria-pressed={(editingDir ? dirScope : activeDirScope) === "${scope}"}`));
  }
  assert.doesNotMatch(source.slice(end), /image-gen-output-scope-button/);
  assert.match(source.slice(end), /chat\.genOutputDirEdit/);
});

test("output directory status is a blue inherited tag and restore uses an undo icon", () => {
  assert.match(source, /<ConfigScopeTag scope="global">/);
  assert.match(source, /chat\.genOutputDirInherited/);
  assert.doesNotMatch(source, /chat\.genOutputDirProjectOverride/);
  assert.match(source, /<Undo2 size=\{12\} strokeWidth=\{1\.8\} \/>/);
});

test("remote image-generation settings use the selected device APIs", () => {
  assert.match(source, /function apiFor\(peer: string \| undefined, path: string\)/);
  assert.match(source, /remotePeer\?: string/);
  assert.match(source, /const path = sessionFile[\s\S]{0,180}`image-gen\?/);
  assert.match(source, /includeProviderKeys=1/);
  assert.match(source, /fetch\(apiFor\(remotePeer, path\)/);
  assert.match(source, /fetch\(apiFor\(remotePeer, "image-gen"\)/);
  assert.match(source, /Object\.entries\(gen\.providers \?\? \{\}\)/);
  assert.match(appShell, /sessionFile=\{resourceSessionFile\}/);
  assert.match(appShell, /cwd=\{resourceCwd \?\? undefined\}/);
  assert.match(appShell, /remotePeer=\{resourcePeer\}/);
});

test("every listed model shows its own quote without changing the selected generation model", () => {
  assert.equal((source.match(/<ImageGenerationPrice provider={provider} model={modelId}/g) ?? []).length, 2);
  assert.doesNotMatch(source, /<ImageGenerationPrice provider={gen.genProvider}/);
  assert.match(source, /!active && \([\s\S]*?<ImageGenerationPrice provider={provider} model={modelId}[\s\S]*?active=\{false\}/);
  assert.match(source, /active && \([\s\S]*?<ImageGenerationPrice provider={provider} model={modelId}[\s\S]*?active \/>/);
});

test("settings do not expose the removed generation switch or auxiliary vision model", () => {
  assert.doesNotMatch(source, /chat\.genToggle/);
  assert.doesNotMatch(source, /visionProvider/);
  assert.doesNotMatch(source, /visionModelId/);
  assert.doesNotMatch(source, /setVisionModel/);
  assert.doesNotMatch(source, /mode="vision"/);
});

test("inactive model notes do not add an extra leading dash", () => {
  assert.match(source, /!active && cap\?\.note \? \([\s\S]*?\{cap\.note\}/);
  assert.doesNotMatch(source, /!active && cap\?\.note \? \([\s\S]*?—\s*\{cap\.note\}/);
});

test("model items are rendered as polished cards with inline quote summary and active detail", () => {
  assert.match(source, /active \? "var\(--bg-selected/);
  assert.match(source, /active=\{false\}/);
  assert.match(source, /borderRadius: 8/);
  assert.match(source, /cap\.versions\.map\(\(version\)/);
  assert.match(source, /display: "inline-flex", alignItems: "center", lineHeight: 1, fontSize: 9/);
  assert.match(priceSource, /display: "inline-flex", alignItems: "center", lineHeight: 1, flexShrink: 0, fontSize: 9/);
  assert.equal((priceSource.match(/color: "rgba\(99,102,241,0\.85\)"/g) ?? []).length, 2);
  assert.equal((priceSource.match(/background: "rgba\(99,102,241,0\.12\)"/g) ?? []).length, 2);
  assert.match(source, /flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"/);
  assert.doesNotMatch(source, /<span style=\{\{ flexShrink: 0 \}\}>\s*<ImageGenerationPrice/);
  assert.doesNotMatch(source, /maxWidth: 360/);
});

test("provider add and edit use a focused modal form", () => {
  assert.match(source, /editingProvider !== null && \(/);
  assert.match(source, /role="dialog"[\s\S]*?aria-modal="true"/);
  assert.match(source, /<form[\s\S]*?chat\.genProviderName/);
  assert.doesNotMatch(source, /editingProvider === provider \?/);
  assert.doesNotMatch(source, /editingProvider === "__new__" &&/);
});

test("provider groups use the blue accent and disclosure state", () => {
  assert.match(source, /const \[collapsedProviders, setCollapsedProviders\]/);
  assert.match(source, /aria-expanded=\{!collapsed\}/);
  assert.match(source, /aria-controls=\{providerPanelId\}/);
  assert.match(source, /color: "var\(--accent\)"/);
  assert.match(source, /!collapsed && \(\s*<div id=\{providerPanelId\}>/);
});

test("editing a provider prefills its saved key and the eye toggles its visibility", () => {
  assert.match(source, /baseUrl: p\?\.baseUrl \?\? ""/);
  assert.match(source, /apiKey: p\?\.apiKey \?\? ""/);
  assert.match(source, /type=\{showApiKey \? "text" : "password"\}/);
  assert.match(source, /chat\.genProviderKeyShow/);
  assert.match(source, /chat\.genProviderKeyHide/);
  assert.doesNotMatch(source, /chat\.genProviderKeyConfigured/);
});
