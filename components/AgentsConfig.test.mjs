import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const source = fs.readFileSync(path.join(process.cwd(), "components", "AgentsConfig.tsx"), "utf8");

test("AgentsConfig preserves drafts independently while switching profiles", () => {
  const selectStart = source.indexOf("const handleSelect =");
  const createStart = source.indexOf("const handleStartCreate", selectStart);
  const selectSource = source.slice(selectStart, createStart);

  assert.ok(source.includes("const [draftsByKey, setDraftsByKey] = useState<Record<string, SubagentProfile>>({});"), "stores drafts per profile");
  assert.match(selectSource, /rememberCurrentDraft/, "selection remembers current draft");
  assert.match(selectSource, /draftsByKey\[key\]/, "selection restores target draft");
  assert.match(source, /Object\.keys\(draftsByKey\)\.length > 0/, "hidden drafts remain dirty");
  assert.match(source, /for \(const profile of pendingDrafts\.values\(\)\)/, "save persists hidden drafts too");
});

test("AgentsConfig shows save success feedback even without a pending draft", () => {
  const saveStart = source.indexOf("const handleSave =");
  const saveSource = source.slice(saveStart);

  assert.match(
    saveSource,
    /if \(pendingDrafts\.size === 0\) \{[\s\S]*?setSavedOk\(true\);[\s\S]*?return true;/,
    "no-op save clicks still enter the success state",
  );
  assert.match(saveSource, /className=\{savedOk \? "is-success" : undefined\}/, "save button enters the shared success state");
  const css = fs.readFileSync(path.join(process.cwd(), "app", "settings.css"), "utf8");
  assert.match(css, /\.config-button\.is-success \{[^}]*animation: saved-pop 0\.45s ease/, "shared success state supplies the animation");
  assert.match(saveSource, /saved-check-draw 0\.35s ease forwards/, "save success draws the check mark");
});

test("AgentsConfig compares editable profile state without derived model fields", () => {
  assert.match(source, /function comparableProfile\(profile: SubagentProfile\)/);
  assert.match(source, /model: editableModel\(profile\) \?\? ""/);
  assert.match(source, /thinking: editableThinking\(profile\) \?\? ""/);
  assert.match(source, /Array\.from\(new Set\(profile\.tools \?\? \[\]\)\)\.sort\(\)/);
  assert.doesNotMatch(source, /JSON\.stringify\(draft\) !== JSON\.stringify\(selectedProfile\)/);
});

test("AgentsConfig clears saved drafts before reload and follows a renamed profile", () => {
  const saveStart = source.indexOf("const handleSave =");
  const saveSource = source.slice(saveStart);
  const clearIndex = saveSource.indexOf("const next = removeDrafts");
  const refreshIndex = saveSource.indexOf("fetchProfiles(refreshTarget)");
  assert.ok(clearIndex >= 0, "save removes completed drafts");
  assert.ok(refreshIndex > clearIndex, "reload happens after draft cleanup");
  assert.match(saveSource, /currentSavedProfile/);
  assert.match(saveSource, /scope: refreshProfile\.scope, name: refreshProfile\.name/);
});

test("AgentsConfig exposes the native concurrency limit and persists changes", () => {
  assert.match(source, /const \[maxConcurrent, setMaxConcurrent\] = useState\(10\)/);
  assert.match(source, /body: JSON\.stringify\(\{ maxConcurrent: value \}\)/);
  assert.match(source, /aria-label=\{t\("agents\.maxConcurrent"\)\}/);
  assert.match(source, /max=\{32\}/);
});

test("AgentsConfig separates Reader roles from pi-subagents runtime roles", () => {
  assert.match(source, /ProfileGroupKey = .*runtime/);
  assert.match(source, /p\.scope === "runtime"/);
  assert.match(source, /runtimeKind === "native"/);
  assert.match(source, /agents\.externalRuntimeReadonly/);
  assert.match(source, /selectedProfile\?\.scope === "workspace"/);
});

test("built-in enablement is persisted through the profile API instead of a local-only draft", () => {
  assert.match(source, /method: "PATCH"/);
  assert.match(source, /scope: "builtin", name: selectedProfile\.name, enabled/);
  assert.match(source, /isTogglableScope\(selectedProfile\.scope\)/);
});

test("AgentsConfig accepts remotePeer and routes settings and profiles through apiPathForPeer", () => {
  assert.ok(source.includes("remotePeer?: string"));
  assert.match(source, /apiPathForPeer\(remotePeer, `models\?cwd=/);
  assert.match(source, /apiPathForPeer\(remotePeer, `sessions\/\${encodeURIComponent\(sessionId\)\}\/state`\)/);
  assert.match(source, /apiPathForPeer\(remotePeer, "subagents\/settings"\)/);
  assert.match(source, /apiPathForPeer\(remotePeer, `subagents\/profiles/);
});


test("project trust reloads the selected peer's model catalog without dropping profile drafts", () => {
  assert.match(source, /trustKey = projectTrustReloadKey\(trust\)/);
  const catalogEffect = source.slice(source.indexOf("const controller = new AbortController();"), source.indexOf("const providerNames = useMemo"));
  assert.match(catalogEffect, /apiPathForPeer\(remotePeer, `models\?cwd=/);
  assert.match(catalogEffect, /\[active, cwd, remotePeer, trustKey\]/);
  assert.match(catalogEffect, /controller.signal.aborted/);
  assert.match(catalogEffect, /setModelList\(\[\]\)/);
});


test("AgentsConfig stacks the sidebar above the editor on mobile", () => {
  assert.match(source, /flexDirection: isMobile \? "column" : "row"/);
  assert.match(source, /maxHeight: isMobile \? "40vh"/);
});

test("AgentsConfig keeps long paths and the open action on one row", () => {
  const headerStart = source.indexOf('<div className="config-detail-header-info"');
  const actionsStart = source.indexOf('<div className="config-detail-actions">', headerStart);
  const header = source.slice(headerStart, actionsStart);

  assert.match(header, /flexWrap: "nowrap"/, "path metadata does not wrap the open action");
  assert.match(
    header,
    /fontFamily: "var\(--font-mono\)",[\s\S]*?minWidth: 0,[\s\S]*?flex: "1 1 0"/,
    "long paths shrink and ellipsize before the action button",
  );
  assert.match(header, /flex: "0 0 22px"/, "the open action keeps a fixed hit target");
});
