import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const source = await readFile(new URL("./FilePermissionsConfig.tsx", import.meta.url), "utf8");
const general = await readFile(new URL("./GeneralConfig.tsx", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { FilePermissionsConfig } = await jiti.import("./FilePermissionsConfig.tsx");
const { getLocalePlugin, getSupportedLocales } = await jiti.import("../lib/i18n/registry.ts");

test("general settings contains the accessible per-device permission section", () => {
  const html = renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(FilePermissionsConfig, { remotePeer: "mini" })));
  assert.match(html, /id="general-sec-file-permissions"/);
  assert.match(html, /aria-labelledby="general-file-permissions-heading"/);
  assert.match(html, /文件访问权限/);
  assert.match(html, /Agent、终端、扩展和外部应用/);
  assert.match(html, /role="status"/);
  assert.match(general, /<FilePermissionsConfig remotePeer=\{remotePeer\} controllerRef=\{controllerRef\}/);
  assert.match(general, /general-sec-file-permissions/);
});

test("permission editor exposes add, edit, save, discard and confirmed restore", () => {
  for (const key of ["filePermissionsRead", "filePermissionsWrite", "filePermissionsAdd", "filePermissionsRemove", "filePermissionsSave", "filePermissionsDiscard", "filePermissionsRestore"]) assert.match(source, new RegExp(`settings\\.${key}`));
  assert.match(source, /apiPathForPeer\(remotePeer, "settings\/file-permissions"\)/);
  assert.match(source, /revision: view\.snapshot\.revision/);
  assert.match(source, /response\.status === 409/);
  assert.match(source, /window\.confirm\(t\("settings\.filePermissionsRestoreConfirm"\)\)/);
  assert.match(source, /aria-label=\{t\("settings\.filePermissionsInput"/);
  assert.match(source, /role="alert"/);
  assert.match(source, /generation\.current !== request/);
  assert.match(source, /loadAbort\.current\?\.abort\(\)/);
  assert.match(source, /signal: controller\.signal/);
  assert.match(source, /isDirty: \(\) => Object\.values\(views\)/);
  assert.match(source, /beforeunload/);
});

test("every file permission label exists in all built-in locales", () => {
  const keys = [...new Set([...source.matchAll(/\bt\("([^"]+)"/g)].map((match) => match[1]))];
  assert.ok(keys.includes("settings.filePermissionsTitle"));
  for (const locale of getSupportedLocales()) {
    const { messages } = getLocalePlugin(locale);
    for (const key of keys) assert.ok(messages[key], `${locale}.${key}`);
  }
});
