import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const {
  CONFIG_SIDEBAR_DEFAULT_WIDTH,
  CONFIG_SIDEBAR_MIN_WIDTH,
  CONFIG_SIDEBAR_MAX_WIDTH,
  getConfigSidebarMaxWidth,
  ConfigPanelRefreshButton,
} = await jiti.import("./ConfigPanelShared.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { getLocalePlugin } = await jiti.import("../lib/i18n/registry.ts");

test("skills and plugins share the same bounded sidebar defaults", () => {
  assert.equal(CONFIG_SIDEBAR_DEFAULT_WIDTH, 240);
  assert.equal(CONFIG_SIDEBAR_MIN_WIDTH, 180);
  assert.equal(CONFIG_SIDEBAR_MAX_WIDTH, 420);
  assert.equal(getConfigSidebarMaxWidth(320), 180);
  assert.equal(getConfigSidebarMaxWidth(1024), 420);
});

test("refresh button uses the language catalog for each locale", () => {
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    const messages = getLocalePlugin(locale).messages;
    assert.ok(messages["settings.refreshList"]);
    assert.ok(messages["settings.refreshListHint"]);
    const html = renderToStaticMarkup(React.createElement(I18nProvider, { initialLocale: locale },
      React.createElement(ConfigPanelRefreshButton, { disabled: false, onRefresh() {} })));
    assert.ok(html.includes(messages["settings.refreshList"]));
    assert.ok(html.includes(messages["settings.refreshListHint"]));
  }
});

test("refresh copy distinguishes list refresh from session reload in every locale", () => {
  for (const [locale, label, hint] of [
    ["zh-CN", "刷新列表", "只刷新列表，不会重新加载当前会话"],
    ["zh-TW", "重新整理列表", "只重新整理列表，不會重新載入目前工作階段"],
    ["en", "Refresh list", "Refreshes the list only; it does not reload the current session."],
  ]) {
    const messages = getLocalePlugin(locale).messages;
    assert.equal(messages["settings.refreshList"], label);
    assert.equal(messages["settings.refreshListHint"], hint);
  }
});
