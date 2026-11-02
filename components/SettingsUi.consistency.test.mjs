import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");

// Follow the settings entry points so a new nested tab cannot escape the audit.
async function settingsComponents() {
  const files = new Map();
  const pending = ["components/SettingsPanel.tsx", "components/UnifiedSettingsModal.tsx"];
  while (pending.length) {
    const relative = pending.pop();
    if (files.has(relative)) continue;
    const absolute = path.join(root, relative);
    const source = await readFile(absolute, "utf8");
    const tree = ts.createSourceFile(absolute, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    files.set(relative, { source, tree });
    for (const imported of ts.preProcessFile(source, true, true).importedFiles) {
      const specifier = imported.fileName;
      const target = specifier.startsWith("@/") ? path.join(root, specifier.slice(2))
        : specifier.startsWith(".") ? path.resolve(path.dirname(absolute), specifier) : null;
      if (!target) continue;
      for (const candidate of [target, `${target}.tsx`, path.join(target, "index.tsx")]) {
        if (!candidate.endsWith(".tsx")) continue;
        try {
          await readFile(candidate, "utf8");
          pending.push(path.relative(root, candidate));
          break;
        } catch (error) {
          if (error.code !== "ENOENT" && error.code !== "EISDIR") throw error;
        }
      }
    }
  }
  return files;
}

function attribute(node, name) {
  return node.attributes.properties.find((item) => ts.isJsxAttribute(item) && item.name.getText() === name);
}

function textValue(value) {
  return value && ts.isStringLiteral(value) ? value.text : undefined;
}

function visit(node, action) {
  action(node);
  ts.forEachChild(node, (child) => visit(child, action));
}

const components = await settingsComponents();

test("every settings subpanel uses the shared sliding switch", () => {
  for (const required of ["ModelRoutingConfig", "ImageGenConfig", "McpAddServer", "FavoritesConfig"]) {
    assert.ok(components.has(`components/${required}.tsx`), `${required} is reachable`);
  }
  const violations = [];
  for (const [file, { tree }] of components) {
    assert.doesNotMatch(components.get(file).source, /\bsettings-form-action\b/, `${file} uses the shared action component`);
    if (file === "components/SettingsUi.tsx") continue;
    visit(tree, (node) => {
      if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return;
      if (textValue(attribute(node, "role")?.initializer) === "switch") violations.push(`${file}: custom switch`);
      if (node.tagName.getText() !== "input" || textValue(attribute(node, "type")?.initializer) !== "checkbox") return;
      const style = attribute(node, "style")?.initializer;
      if (!style || !ts.isJsxExpression(style) || !style.expression || !ts.isObjectLiteralExpression(style.expression)) return;
      const hidden = style.expression.properties.some((item) => ts.isPropertyAssignment(item)
        && ["opacity", "width", "height"].includes(item.name.getText()) && item.initializer.getText() === "0");
      if (hidden) violations.push(`${file}: hidden checkbox switch`);
    });
  }
  assert.deepEqual(violations, []);
});

test("detail actions do not draw their own buttons", () => {
  const violations = [];
  for (const [file, { tree }] of components) {
    visit(tree, (node) => {
      if (!ts.isJsxElement(node)) return;
      const opening = node.openingElement;
      const classes = textValue(attribute(opening, "className")?.initializer)?.split(/\s+/) ?? [];
      if (opening.tagName.getText() !== "ConfigDetailActions" && !classes.includes("config-detail-actions")) return;
      visit(node, (child) => {
        if (ts.isJsxOpeningElement(child) && child.tagName.getText() === "button") violations.push(file);
      });
    });
  }
  assert.deepEqual(violations, []);
});

test("buttons, form actions and resource footers share the same presentation", async () => {
  const css = await readFile(path.join(root, "app/settings.css"), "utf8");
  for (const declaration of ["--config-control-height: 32px", "--config-control-font-size: 12px", "--config-control-radius: 6px", "--config-control-icon-size: 14px"]) {
    assert.ok(css.includes(declaration), declaration);
  }
  assert.match(css, /\.config-button-default \{[^}]*height: var\(--config-control-height\)[^}]*font-size: var\(--config-control-font-size\)/);
  assert.match(css, /\.config-button-small \{[^}]*height: 28px[^}]*font-size: var\(--config-control-font-size\)/);
  assert.match(css, /\.config-detail-actions \.config-button \{[^}]*height: var\(--config-control-height\)/);
  assert.match(css, /\.config-button \{[^}]*width: auto/);
  assert.doesNotMatch(css, /\.config-footer-actions[^{}]*\.config-button-default\s*\{[^}]*min-width/);
  for (const name of ["PluginsConfig", "SkillsConfig", "McpConfig"]) {
    const { source } = components.get(`components/${name}.tsx`);
    assert.match(source, /<ConfigFooter\b/);
    assert.match(source, /<ConfigPanelRefreshButton\b/);
    assert.match(source, /<ConfigButton onClick=\{onClose\}>/);
  }
  const { source: refresh } = components.get("components/ConfigPanelShared.tsx");
  assert.match(refresh, /<ConfigButton/);
  assert.doesNotMatch(refresh, /<button\b/);
});
