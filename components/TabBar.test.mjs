import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { TabBar } = await jiti.import("./TabBar.tsx");

function renderTabBar(onReorderTab) {
  const tabs = [
    { id: "file:a", label: "a.ts", filePath: "/repo/a.ts" },
    { id: "terminal:1", label: "Terminal", filePath: "/repo" },
  ];
  return renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(TabBar, { tabs, activeTabId: "file:a", onSelectTab() {}, onCloseTab() {}, onReorderTab }),
  ));
}

test("right-panel tabs become draggable only when a reorder handler is provided", () => {
  assert.match(renderTabBar(() => {}), /role="tab"[^>]*draggable="true"/);
  assert.doesNotMatch(renderTabBar(), /role="tab"[^>]*draggable="true"/);
});

test("tab close controls do not start a tab drag", () => {
  const html = renderTabBar(() => {});
  assert.match(html, /draggable="false"/);
  assert.match(html, /role="tab"[^>]*aria-selected="true"/);
});
