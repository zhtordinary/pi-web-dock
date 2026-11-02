import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appShell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const activityPanel = await readFile(new URL("./SessionActivityPanel.tsx", import.meta.url), "utf8");

function deletionHandler(source) {
  const start = source.indexOf("const handleSessionDeleted");
  const end = source.indexOf("const handleOpenFile", start);
  assert.ok(start >= 0 && end > start, "session deletion handler not found");
  return source.slice(start, end);
}

test("current embedded deletion unmounts the stale reader document", () => {
  const deletion = deletionHandler(appShell);
  const embeddedBranch = deletion.slice(
    deletion.indexOf("if (embeddedOwnsSession)"),
    deletion.indexOf("setTalkMapSidebarSessionId"),
  );
  assert.match(embeddedBranch, /setEmbeddedSessionKey\(null\)/);
  assert.match(embeddedBranch, /setEmbeddedIframeSessionId\(null\)/);
  assert.match(embeddedBranch, /setEmbeddedReaderUrl\(null\)/);
});

test("activity search deletion reaches the shell invalidation callback", () => {
  const panelSearch = activityPanel.slice(activityPanel.indexOf("visibleSearchResults.map"));
  const sidebarSearch = activityPanel.slice(activityPanel.lastIndexOf("visibleSearchResults.map"));
  assert.match(panelSearch, /<ActivitySearchHitRow[\s\S]*?onSessionDeleted=\{onSessionDeleted\}/);
  assert.match(sidebarSearch, /<ActivitySearchHitRow[\s\S]*?onSessionDeleted=\{onSessionDeleted\}/);

  const searchHit = activityPanel.slice(activityPanel.indexOf("function ActivitySearchHitRow"));
  assert.match(searchHit, /onSessionDeleted/);
  assert.match(searchHit, /<SessionActivitySidebarRow[\s\S]*?onSessionDeleted=\{onSessionDeleted\}/);
});

test("session deletion avoids global refreshKey broadcast and hard reload", () => {
  const deletion = deletionHandler(appShell);
  assert.doesNotMatch(deletion, /setRefreshKey\(/);
  assert.match(deletion, /const subprojectId = selectedSession\.subprojectId \?\? null;/);
  assert.match(deletion, /setNewSessionSubprojectId\(subprojectId\);/);
  assert.doesNotMatch(appShell, /window\.location\.replace\(window\.location\.pathname\)/);
});
