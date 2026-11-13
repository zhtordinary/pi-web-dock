import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [activityPanel, sessionContextMenu, appShell, sessionRunsRoute, sessionSearchRoute, sessionsRoute, storageScope, favoritesRoute, categoriesRoute, zhCN] = await Promise.all([
  readFile(new URL("./SessionActivityPanel.tsx", import.meta.url), "utf8"),
  readFile(new URL("./SessionContextMenu.tsx", import.meta.url), "utf8"),
  readFile(new URL("./AppShell.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/api/session-runs/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/sessions/search/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/sessions/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/session-storage-scope.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/favorites/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/session-categories/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/i18n/messages/zh-CN.ts", import.meta.url), "utf8"),
]);

test("device dropdown收纳 group contains 隐藏页, 收藏页, 待讨论, 待修改, 已完成", () => {
  assert.match(activityPanel, /const TO_DISCUSS_PAGE_VALUE = "__to_discuss_page__"/);
  assert.match(activityPanel, /const TO_REVISE_PAGE_VALUE = "__to_revise_page__"/);
  assert.match(activityPanel, /const COMPLETED_PAGE_VALUE = "__completed_page__"/);
  assert.match(activityPanel, /collectionOptions = \[[\s\S]*?hiddenPageOption[\s\S]*?favoritesPageOption[\s\S]*?toDiscussPageOption[\s\S]*?toRevisePageOption[\s\S]*?completedPageOption/);
  assert.match(zhCN, /"sessionActivity\.toDiscussPage": "待讨论"/);
  assert.match(zhCN, /"sessionActivity\.toRevisePage": "待修改"/);
  assert.match(zhCN, /"sessionActivity\.completedPage": "已完成"/);
});

test("session rows replace dropdown chevron with inline rename button and handle context menu", () => {
  // Chevron button removed; pencil edit button present directly on row
  assert.match(activityPanel, /<Pencil size=\{12\}/);
  assert.match(activityPanel, /setName\(item\.session\.name \?\? ""\); setEditing\(true\);/);
  // Context menu trigger on row
  assert.match(activityPanel, /onContextMenu=\{\(event\) => \{[\s\S]*?setContextMenuPoint\(\{ x: event\.clientX, y: event\.clientY \}\);/);
  assert.match(activityPanel, /<SessionContextMenu/);
});

test("SessionContextMenu places moveToSubproject first and includes categories in order", () => {
  const subprojectPos = sessionContextMenu.indexOf('t("sessionActivity.moveToSubproject")');
  const favoritePos = sessionContextMenu.indexOf('t("sessionActivity.favoriteSession")');
  const toDiscussPos = sessionContextMenu.indexOf('t("sessionActivity.toDiscuss")');
  const toRevisePos = sessionContextMenu.indexOf('t("sessionActivity.toRevise")');
  const completedPos = sessionContextMenu.indexOf('t("sessionActivity.completed")');
  const subagentsPos = sessionContextMenu.indexOf('t("sidebar.showSubagents")');
  const hidePos = sessionContextMenu.indexOf('t("sessionActivity.hideSession")');

  assert.ok(subprojectPos > 0, "moveToSubproject exists in context menu");
  assert.ok(favoritePos > subprojectPos, "favorite comes after subproject");
  assert.ok(toDiscussPos > favoritePos, "toDiscuss comes after favorite");
  assert.ok(toRevisePos > toDiscussPos, "toRevise comes after toDiscuss");
  assert.ok(completedPos > toRevisePos, "completed comes after toRevise");
  assert.ok(subagentsPos > completedPos, "subagent visibility comes after categories");
  assert.ok(subagentsPos < hidePos, "subagent visibility sits next to hide");
  assert.ok(hidePos > completedPos, "hide comes after categories");
});

test("session-runs API supports to_discuss, to_revise, and completed scopes", () => {
  assert.match(sessionRunsRoute, /"to_discuss" \| "to_revise" \| "completed"/);
  assert.match(sessionRunsRoute, /scope === "to_discuss"/);
  assert.match(sessionRunsRoute, /scope === "to_revise"/);
  assert.match(sessionRunsRoute, /scope === "completed"/);
});

test("all storage scopes use one exclusive projection", () => {
  assert.match(activityPanel, /resolveActivityScope[\s\S]*toDiscussView[\s\S]*return "to_discuss"/);
  assert.match(storageScope, /function sessionStorageScopeFor/);
  assert.match(storageScope, /if \(membership\.hidden\) return "hidden"/);
  assert.match(storageScope, /if \(membership\.favorite\) return "favorites"/);
  assert.match(sessionRunsRoute, /const classification = sessionStorageScopeFor/);
  assert.match(sessionRunsRoute, /favorite: item\.favorite === true/);
  assert.match(sessionRunsRoute, /hidden: isHiddenInState/);
  assert.match(sessionRunsRoute, /favorite: classification === "favorites"/);
  assert.match(sessionSearchRoute, /matchesSessionStorageScope\(storageScope/);
  assert.match(sessionsRoute, /function filterDefaultSessions[\s\S]*matchesSessionStorageScope\("normal"/);
  assert.match(favoritesRoute, /setSessionCategory\(body\.id, null\)/);
  assert.match(categoriesRoute, /if \(body\.category !== null\)[\s\S]*setFavorite\(body\.id, false\)/);
  assert.doesNotMatch(activityPanel, /item\.favorite && \([\s\S]*?sessionActivity\.favoritesPage/);
});

test("AppShell synchronizes and restores to_discuss, to_revise, and completed scopes", () => {
  assert.match(appShell, /toDiscussScope/);
  assert.match(appShell, /toReviseScope/);
  assert.match(appShell, /completedScope/);
  assert.match(appShell, /setToDiscussView/);
  assert.match(appShell, /setToReviseView/);
  assert.match(appShell, /setCompletedView/);
});
