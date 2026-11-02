import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { createJiti } from "jiti";
import { tmpdir } from "node:os";
import { join } from "node:path";
const source = await readFile(new URL("./image-generation-package.ts", import.meta.url), "utf8");
const root = await mkdtemp(join(tmpdir(), "reader-image-package-"));
after(() => rm(root, { recursive: true, force: true }));
const executable = stripTypeScriptTypes(source.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""));
const { loadImageGenerationPackage } = new Function("deps", `const { createJiti, join, getAgentDir } = deps;\n${executable}\nreturn { loadImageGenerationPackage };`)({ createJiti, join, getAgentDir: () => root });
const fixture = await readFile(new URL("../test-fixtures/image-generation/config.ts", import.meta.url), "utf8");

test("reads the independent package and observes a package-only update without restarting Reader", async () => {
  const directory = join(root, "packages/pi-image-generation"); await mkdir(directory, { recursive: true });
  const path = join(directory, "config.ts"); await writeFile(path, fixture);
  assert.equal(loadImageGenerationPackage().generationPanelCapabilities()["fixture-model"].note, "fixture-v1");
  await writeFile(path, fixture.replace("fixture-v1", "fixture-v2"));
  assert.equal(loadImageGenerationPackage().generationPanelCapabilities()["fixture-model"].note, "fixture-v2");
});
test("rejects a missing package or incompatible contract without exposing local paths", async () => {
  assert.throws(() => loadImageGenerationPackage(join(root, "missing")), /package is unavailable or incompatible/);
  const directory = join(root, "incompatible/packages/pi-image-generation"); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "config.ts"), fixture.replace("CONFIG_API_VERSION = 1", "CONFIG_API_VERSION = 99"));
  assert.throws(() => loadImageGenerationPackage(join(root, "incompatible")), /package is unavailable or incompatible/);
});

test("the package loader keeps jiti in the production bundle contract", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.dependencies.jiti, "^2.7.0");
  assert.equal(manifest.devDependencies.jiti, undefined);
  assert.match(source, /import \{ createJiti \} from "jiti"/);
  assert.doesNotMatch(source, /createRequire/);
});
