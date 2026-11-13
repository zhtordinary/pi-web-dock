/* eslint-disable @typescript-eslint/no-require-imports */
const { readFileSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");

const PACKAGE_NAME = "@earendil-works/pi-ai";
const SUPPORTED_VERSION = "1.5.0";
const RELATIVE_FILE = "dist/api/openai-codex-responses.js";
const PATCH_MARKER = "pi-web-side-ask-cache-route";
const OLD_TEXT = `            const websocketHeaders = buildWebSocketHeaders(identityHeaders, model.headers, options?.headers, accountId, apiKey, websocketRequestId);`;
const NEW_TEXT = `${OLD_TEXT}
            /* ${PATCH_MARKER} */
            const sideAskCacheRoute = body[Symbol.for("pi-web:side-ask-cache-route")];
            if (typeof sideAskCacheRoute === "string" && sideAskCacheRoute === body.prompt_cache_key
                && /^[\\x21-\\x7e]{1,64}$/.test(sideAskCacheRoute)) {
                sseHeaders.set("session-id", sideAskCacheRoute);
                websocketHeaders.set("session-id", sideAskCacheRoute);
            }`;

function piAiPackageRoot() {
  const nodeModules = dirname(dirname(require.resolve("node-pty/package.json")));
  return join(nodeModules, "@earendil-works", "pi-ai");
}

function patchPiCodexCacheRoute(packageRoot = piAiPackageRoot()) {
  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  if (packageJson.version !== SUPPORTED_VERSION) {
    throw new Error(`${PACKAGE_NAME} ${SUPPORTED_VERSION} patch expected, found ${packageJson.version}`);
  }
  const file = join(packageRoot, RELATIVE_FILE);
  const source = readFileSync(file, "utf8");
  const occurrences = source.split(OLD_TEXT).length - 1;
  const markers = source.split(PATCH_MARKER).length - 1;
  if (markers) {
    if (markers === 1 && occurrences === 1 && source.split(NEW_TEXT).length === 2) return 0;
    throw new Error(`Cannot verify ${PATCH_MARKER} in ${file}`);
  }
  if (occurrences !== 1) {
    throw new Error(`Cannot apply ${PATCH_MARKER}: expected one match in ${file}, found ${occurrences}`);
  }
  writeFileSync(file, source.replace(OLD_TEXT, NEW_TEXT));
  return 1;
}

module.exports = { PACKAGE_NAME, SUPPORTED_VERSION, RELATIVE_FILE, PATCH_MARKER, OLD_TEXT, NEW_TEXT,
  piAiPackageRoot, patchPiCodexCacheRoute };

if (require.main === module) {
  const changed = patchPiCodexCacheRoute();
  process.stdout.write(`pi-ai Codex cache-route patch: ${changed ? "patched" : "already applied"}\n`);
}
