import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const globalsCss = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const settingsCss = readFileSync(new URL("../app/settings.css", import.meta.url), "utf8");

const themeBlocks = [
  ["light", /:root,\s*\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/],
  ["dark", /\[data-theme="dark"\],\s*html\.dark\s*\{([\s\S]*?)\n\}/],
  ["mist", /html\[data-theme="mist"\],\s*\[data-theme="mist"\]\s*\{([\s\S]*?)\n\}/],
  ["rose", /html\[data-theme="rose"\],\s*\[data-theme="rose"\]\s*\{([\s\S]*?)\n\}/],
  ["pine", /html\[data-theme="pine"\],\s*\[data-theme="pine"\]\s*\{([\s\S]*?)\n\}/],
];

const backgroundTokens = [
  "--bg",
  "--bg-panel",
  "--bg-hover",
  "--bg-selected",
  "--user-bg",
  "--assistant-bg",
  "--tool-bg",
  "--bg-subtle",
];

test("keeps every Reader theme's background palette complete", () => {
  for (const [name, pattern] of themeBlocks) {
    const match = globalsCss.match(pattern);
    assert.ok(match, `${name} theme block is missing`);
    for (const token of backgroundTokens) {
      assert.match(match[1], new RegExp(`${token}\\s*:`), `${name} theme lacks ${token}`);
    }
  }
});

test("keeps settings and Markdown surfaces on existing background tokens", () => {
  assert.match(globalsCss, /html, body\s*\{[\s\S]*?background:\s*var\(--bg\);/);
  assert.match(globalsCss, /\.markdown-body \.markdown-inline-code\s*\{[\s\S]*?background:\s*var\(--bg-subtle\);/);
  assert.match(settingsCss, /\.config-panel-surface\s*\{[\s\S]*?background:\s*var\(--bg\);/);
  assert.match(settingsCss, /\.config-sidebar\s*\{[\s\S]*?background:\s*var\(--bg-panel\);/);
});
