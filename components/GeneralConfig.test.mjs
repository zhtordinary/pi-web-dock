import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const source = await readFile(new URL("./GeneralConfig.tsx", import.meta.url), "utf8");
const modalSource = await readFile(new URL("./UnifiedSettingsModal.tsx", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { getLocalePlugin, getSupportedLocales } = await jiti.import("../lib/i18n/registry.ts");
const { translateMessage } = await jiti.import("../lib/i18n/format.ts");
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { GeneralConfig } = await jiti.import("./GeneralConfig.tsx");

test("GeneralConfig renders a readable default shortcut and only the width slider", () => {
  const html = renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(GeneralConfig)));
  assert.match(html, /⌘E \/ Ctrl\+E \(默认\)/);
  assert.match(html, /aria-label="聊天内容宽度"/);
  assert.equal((html.match(/type="range"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /settings\.default|聊天字体大小/);
});

test("GeneralConfig literal translations exist in every built-in locale", () => {
  const keys = [...source.matchAll(/\bt\("([^"]+)"/g)].map((match) => match[1]);
  assert.ok(keys.includes("settings.quoteShortcut"));
  for (const locale of getSupportedLocales()) {
    const { messages } = getLocalePlugin(locale);
    for (const key of keys) assert.ok(messages[key], `${locale}.${key}`);
  }
});

test("the default quote shortcut shows a translated label", () => {
  const key = source.match(/value: "Mod\+e", label: [^\n]*?t\("([^"]+)"\)/)?.[1];
  assert.ok(key, "the default shortcut option must translate its label");
  const messages = Object.fromEntries(getSupportedLocales().map((id) => [id, getLocalePlugin(id).messages]));
  for (const [locale, label] of [["en", "Default"], ["zh-CN", "默认"], ["zh-TW", "預設"]]) {
    assert.equal(translateMessage(locale, key, messages), label, locale);
  }
});

test("GeneralConfig owns explicit Web Push subscription controls", () => {
  assert.match(source, /requestPushSubscription/);
  assert.match(source, /unsubscribePushSubscription/);
  assert.match(source, /pushPermissionState/);
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /settings\.pushSubscribed/);
  assert.match(source, /settings\.pushDenied/);
});


test("remote GeneralConfig disables origin-bound Web Push controls", () => {
  assert.match(source, /if \(remotePeer\)/);
  assert.match(source, /pushRemoteDisabled/);
  assert.match(source, /if \(remotePeer \|\| pushBusy\)/);
  assert.match(modalSource, /<GeneralConfig[\s\S]*?remotePeer=\{remotePeer\}/, "UnifiedSettingsModal owns passing the remote peer");
});

test("GeneralConfig renders sound notification controls and supports status options", () => {
  assert.match(source, /settings\.soundTitle/);
  assert.match(source, /settings\.soundDescription/);
  assert.match(source, /settings\.soundDone/);
  assert.match(source, /settings\.soundError/);
  assert.match(source, /settings\.soundWait/);
  assert.match(source, /updateSoundSettings/);
  assert.match(source, /playPreviewSound\("done"\)/);
  assert.match(source, /playPreviewSound\("error"\)/);
  assert.match(source, /playPreviewSound\("wait"\)/);
  assert.match(source, /soundSettings\.enabled/);
  assert.match(source, /soundSettings\.done/);
  assert.match(source, /soundSettings\.error/);
  assert.match(source, /soundSettings\.wait/);
});
