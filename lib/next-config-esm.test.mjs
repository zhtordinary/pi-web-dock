import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const configUrl = new URL("../next.config.ts", import.meta.url);
const source = await readFile(configUrl, "utf8");

test("resolves config paths without CommonJS globals", async () => {
  assert.doesNotMatch(source, /\b__dirname\b/);
  assert.match(source, /dirname\(fileURLToPath\(import\.meta\.url\)\)/);

  const config = await import(`${configUrl.href}?esm-test`);
  assert.equal(config.default.env.NEXT_PUBLIC_APP_VERSION, "0.13.0");
  assert.equal(config.default.env.NEXT_PUBLIC_PI_VERSION, "1.4.0");
});
