import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const templateSource = await readFile(new URL("./SettingsUi.tsx", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");
const globalCssSource = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const layoutSource = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
const enSource = await readFile(new URL("../lib/i18n/messages/en.ts", import.meta.url), "utf8");
const zhSource = await readFile(new URL("../lib/i18n/messages/zh-CN.ts", import.meta.url), "utf8");

test("provides one template for config layout and controls", () => {
  for (const primitive of [
    "ConfigPanelShell",
    "ConfigSplitView",
    "ConfigSidebar",
    "ConfigSidebarItem",
    "ConfigSidebarText",
    "ConfigDetail",
    "ConfigDetailStack",
    "ConfigDetailHeader",
    "ConfigDetailHeaderInfo",
    "ConfigDetailActions",
    "ConfigDetailTitle",
    "ConfigSectionTitle",
    "ConfigField",
    "ConfigEmptyState",
    "ConfigFooter",
    "ConfigButton",
    "ConfigSwitch",
    "ConfigListAction",
    "ConfigStatusDot",
    "ConfigScopeTag",
    "ConfigScopeSwitch",
    "ConfigSaveTarget",
    "ConfigAddSourceHeading",
    "ConfigAddSourcePanel",
    "ConfigDetailGrid",
    "ConfigDetailGridRow",
    "ConfigFooterStatus",
    "ConfigNotice",
    "ConfigTrustNotice",
  ]) {
    assert.match(templateSource, new RegExp(`export function ${primitive}`));
  }
  assert.match(templateSource, /className=\{\["config-sidebar"/);
  assert.match(templateSource, /className="config-detail"/);
  assert.match(cssSource, /\.config-sidebar \{[\s\S]*?width: var\(--config-sidebar-width, 240px\)/);
  assert.match(cssSource, /\.config-detail \{[\s\S]*?padding: 20px/);
  assert.match(cssSource, /@media \(max-width: 640px\)[\s\S]*?\.config-sidebar \{[\s\S]*?width: 100%/);
  assert.match(cssSource, /@media \(max-width: 640px\)[\s\S]*?\.config-detail \{[\s\S]*?padding: 14px/);
});

test("resource toolbars share their surface, height and spacing", async () => {
  for (const panel of ["AgentsConfig", "PluginsConfig", "SkillsConfig"]) {
    const source = await readFile(new URL(`./${panel}.tsx`, import.meta.url), "utf8");
    assert.match(source, /className="config-resource-toolbar"/);
  }
  const toolbar = cssSource.match(/\.config-resource-toolbar \{([^}]+)\}/)?.[1];
  assert.ok(toolbar);
  assert.match(toolbar, /min-height: 47px/);
  assert.match(toolbar, /padding: 8px 18px/);
  assert.match(toolbar, /background: var\(--bg\)/);
  assert.match(toolbar, /flex-wrap: wrap/);
});

test("settings section dividers share the 47px toolbar height", async () => {
  const prompts = await readFile(new URL("./PromptsConfig.tsx", import.meta.url), "utf8");
  const models = await readFile(new URL("./ModelsConfig.tsx", import.meta.url), "utf8");
  const favorites = await readFile(new URL("./FavoritesConfig.tsx", import.meta.url), "utf8");
  const mcp = await readFile(new URL("./McpConfig.tsx", import.meta.url), "utf8");
  assert.match(prompts, /className="prompts-config-toolbar"/);
  assert.match(cssSource, /\.prompts-config-toolbar \{[\s\S]*?min-height: 47px[\s\S]*?padding: 7px 18px/);
  assert.match(models, /minHeight: 47, boxSizing: "border-box"/);
  assert.match(favorites, /minHeight: 47, boxSizing: "border-box", borderBottom: "1px solid var\(--border\)"/);
  assert.match(mcp, /<ConfigDetail className="is-mcp">/);
  assert.match(cssSource, /\.config-detail\.is-mcp \{[\s\S]*?padding-top: 16px/);
  for (const panel of ["AgentsConfig", "PluginsConfig", "SkillsConfig"]) {
    const source = await readFile(new URL(`./${panel}.tsx`, import.meta.url), "utf8");
    assert.match(source, /className="config-detail-header"/);
  }
});

test("resource detail headers share the sub-agent top inset", async () => {
  assert.match(cssSource, /--config-detail-padding-top: 16px/);
  for (const panel of ["AgentsConfig", "PluginsConfig", "SkillsConfig"]) {
    const source = await readFile(new URL(`./${panel}.tsx`, import.meta.url), "utf8");
    assert.match(source, /padding: "var\(--config-detail-padding-top\) /, panel);
  }
});

test("resource scope labels share the sub-agent presentation", async () => {
  const tag = cssSource.match(/\.config-scope-tag \{([^}]+)\}/)?.[1];
  for (const declaration of ["padding: 2px 7px", "border-radius: 4px", "font-size: 11px", "font-weight: 600", "line-height: 1.5", "background: var(--bg-selected, #e0e7ff)", "color: var(--accent, #3b82f6)"]) {
    assert.ok(tag?.includes(declaration), declaration);
  }
  for (const panel of ["AgentsConfig", "PluginsConfig", "SkillsConfig", "McpConfig"]) {
    const source = await readFile(new URL(`./${panel}.tsx`, import.meta.url), "utf8");
    assert.match(source, /<ConfigScopeTag scope=\{/, panel);
    assert.doesNotMatch(source, /function ScopeTag\(/, panel);
  }
});

test("settings switches share the 36 by 20 agent detail size", async () => {
  const track = cssSource.match(/\.config-switch \{([^}]+)\}/)?.[1];
  const knob = cssSource.match(/\.config-switch-knob \{([^}]+)\}/)?.[1];
  assert.match(track, /width: 36px/);
  assert.match(track, /height: 20px/);
  assert.match(knob, /width: 14px/);
  assert.match(knob, /height: 14px/);
  assert.match(knob, /top: 3px/);
  assert.match(knob, /left: 3px/);
  assert.match(cssSource, /\.config-switch\[aria-checked="true"\] \.config-switch-knob \{\s*transform: translateX\(16px\)/);
  assert.match(cssSource, /\.config-switch::before \{[^}]*inset: -12px -4px/);
  assert.doesNotMatch(cssSource, /\.config-switch\.is-small/);
  for (const [panel, count] of [["GeneralConfig", 7], ["AgentsConfig", 2], ["PluginsConfig", 2]]) {
    const source = await readFile(new URL(`./${panel}.tsx`, import.meta.url), "utf8");
    assert.equal((source.match(/<ConfigSwitch\b/g) ?? []).length, count, panel);
    assert.doesNotMatch(source, /opacity: 0, width: 0, height: 0|function Toggle\(/);
  }
});

test("loads settings presentation from its dedicated stylesheet", () => {
  assert.match(layoutSource, /import "\.\/globals\.css";\s*import "\.\/settings\.css";/);
  assert.match(cssSource, /\.config-panel-root \{/);
  assert.match(cssSource, /\.settings-dialog-backdrop \{/);
  assert.doesNotMatch(globalCssSource, /\.config-panel-root \{/);
  assert.doesNotMatch(globalCssSource, /\.settings-dialog-backdrop \{/);
});

test("all shared config sidebar items use a fixed 30px height", () => {
  assert.match(cssSource, /\.config-sidebar-item \{[\s\S]*?height: 30px[\s\S]*?padding: 0 8px/);
  assert.match(cssSource, /\.config-list-action-button \{[\s\S]*?height: 30px[\s\S]*?min-height: 30px/);
});

test("skill scope group labels are localized", () => {
  for (const scope of ["global", "project", "path"]) {
    assert.match(enSource, new RegExp(`"skills\.scope\.${scope}":`));
    assert.match(zhSource, new RegExp(`"skills\.scope\.${scope}":`));
  }
  assert.match(zhSource, /"skills\.scope\.global": "全局"/);
  assert.match(zhSource, /"skills\.scope\.project": "项目"/);
});

test("keeps shared static presentation in the stylesheet", () => {
  assert.doesNotMatch(templateSource, /<style>/);
  assert.doesNotMatch(templateSource, /style=\{\{/);
  assert.doesNotMatch(templateSource, /onMouseEnter|onMouseLeave/);
  for (const className of [
    "config-panel-surface",
    "config-split-view",
    "config-sidebar-item",
    "config-detail-stack",
    "config-button",
    "config-switch",
    "config-scope-switch",
    "config-save-target",
    "config-detail-grid",
    "config-add-source-input",
    "config-add-source-example",
    "config-footer-status-list",
    "config-notice",
  ]) {
    assert.match(templateSource, new RegExp(className));
    assert.match(cssSource, new RegExp(`\\.${className}\\b`));
  }
});
