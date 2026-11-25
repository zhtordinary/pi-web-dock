"use strict";

const { dirname, join } = require("node:path");
const { findPackageJSON, registerHooks } = require("node:module");
const { pathToFileURL } = require("node:url");

function replaceOnce(source, before, after) {
  const at = source.indexOf(before);
  if (at < 0 || at !== source.lastIndexOf(before)) throw new Error("Unsupported Pi Codex cache-affinity adapter");
  return source.slice(0, at) + after + source.slice(at + before.length);
}

function patchCodexAffinitySource(source) {
  // shortcut: Pi 1.6.0 has no separate cache-affinity option; remove when the SDK exposes one.
  const changes = [
    [
      "            const websocketRequestId = codexSessionId || uuidv7();",
      `            const websocketRequestId = codexSessionId || uuidv7();
            const readerAffinity = body?.[Symbol.for("pi-web:prompt-cache-affinity")];
            const readerRoutingId = codexSessionId && typeof readerAffinity === "string" && readerAffinity.length > 0 && readerAffinity === body.prompt_cache_key && readerAffinity.length <= 64 && /^[\\x21-\\x7e]+$/u.test(readerAffinity) ? readerAffinity : codexSessionId;`,
    ],
    [
      "buildSSEHeaders(identityHeaders, model.headers, options?.headers, accountId, apiKey, codexSessionId)",
      "buildSSEHeaders(identityHeaders, model.headers, options?.headers, accountId, apiKey, codexSessionId, readerRoutingId)",
    ],
    [
      "buildWebSocketHeaders(identityHeaders, model.headers, options?.headers, accountId, apiKey, websocketRequestId)",
      "buildWebSocketHeaders(identityHeaders, model.headers, options?.headers, accountId, apiKey, websocketRequestId, readerRoutingId || websocketRequestId)",
    ],
    [
      "function buildSSEHeaders(defaultHeaders, initHeaders, additionalHeaders, accountId, token, sessionId) {",
      "function buildSSEHeaders(defaultHeaders, initHeaders, additionalHeaders, accountId, token, sessionId, readerRoutingId) {",
    ],
    ["headers.set(\"session-id\", sessionId);", "headers.set(\"session-id\", readerRoutingId);"],
    [
      "function buildWebSocketHeaders(defaultHeaders, initHeaders, additionalHeaders, accountId, token, requestId) {",
      "function buildWebSocketHeaders(defaultHeaders, initHeaders, additionalHeaders, accountId, token, requestId, readerRoutingId) {",
    ],
    ["headers.set(\"session-id\", requestId);", "headers.set(\"session-id\", readerRoutingId);"],
  ];
  for (const [before, after] of changes) source = replaceOnce(source, before, after);
  return `${source}\nexport const readerCacheAffinity = true;\n`;
}

function loadCodexAffinityAdapter() {
  if (globalThis.__piWebCodexAffinityAdapter) return globalThis.__piWebCodexAffinityAdapter;
  const loading = (async () => {
    const manifest = findPackageJSON("@earendil-works/pi-ai", pathToFileURL(join(process.cwd(), "package.json")));
    if (!manifest) throw new Error("Pi AI package is unavailable");
    const url = pathToFileURL(join(dirname(manifest), "dist/api/openai-codex-responses.js"));
    url.searchParams.set("pi-web-cache-affinity", "1");
    const target = url.href;
    const hooks = registerHooks({
      load(specifier, context, nextLoad) {
        const result = nextLoad(specifier, context);
        if (specifier !== target) return result;
        if (result.format !== "module" || result.source == null) throw new Error("Pi Codex adapter source is unavailable");
        const source = typeof result.source === "string" ? result.source : Buffer.from(result.source).toString("utf8");
        return { ...result, source: patchCodexAffinitySource(source) };
      },
    });
    try {
      // Preserve native ESM loading through Jiti and the production Webpack bundle.
      const adapter = await new Function("specifier", "return import(specifier)")(target);
      if (adapter.readerCacheAffinity !== true) throw new Error("Pi Codex cache-affinity adapter was not loaded");
      return adapter;
    } finally {
      hooks.deregister();
    }
  })();
  globalThis.__piWebCodexAffinityAdapter = loading;
  void loading.catch(() => {
    if (globalThis.__piWebCodexAffinityAdapter === loading) globalThis.__piWebCodexAffinityAdapter = undefined;
  });
  return loading;
}

module.exports = { loadCodexAffinityAdapter, patchCodexAffinitySource };
