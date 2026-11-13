import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { ProviderIcon } = await jiti.import("./ProviderIcon.tsx");

function renderIcon(id) {
  return renderToStaticMarkup(React.createElement(ProviderIcon, { id, size: 20 }));
}

test("known OpenAI providers use the local sprite and preserve mono color behavior", () => {
  for (const provider of ["openai", "openai-subscription", "openai-api"]) {
    const html = renderIcon(provider);
    assert.match(html, /<svg[^>]*width="20"[^>]*height="20"/);
    assert.match(html, /style="color:var\(--text-muted\);/);
    assert.match(html, /<use href="\/provider-icons\.svg#openai"><\/use>/);
  }
});

test("unknown providers keep the readable initials fallback", () => {
  const html = renderIcon("custom-provider");
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, />CP<\/span>/);
  assert.doesNotMatch(html, /<use /);
});
