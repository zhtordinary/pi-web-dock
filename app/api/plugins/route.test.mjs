import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { persistProjectPluginOverride } = await jiti.import("../../../lib/project-resource-policy.ts");
const { collectTopLevelExtensions, updateTopLevelExtensionPaths } = await jiti.import("../../../lib/top-level-extension-resources.ts");

const root = await mkdtemp(join(tmpdir(), "reader-plugin-route-"));
const agentDir = join(root, "agent");
const cwd = join(root, "project");
await mkdir(agentDir);
await mkdir(cwd);
const disabledMarker = "!__pi_web_package_disabled_missing__";
const disabledPresentMarker = "!__pi_web_package_disabled_present__";
const disabledEntry = (source) => ({
  source,
  extensions: ["!**", disabledMarker],
  skills: ["!**", disabledMarker],
  prompts: ["!**", disabledMarker],
  themes: ["!**", disabledMarker],
});
await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const { GET, POST } = await jiti.import("./route.ts");
test.after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
});

test("flushes project plugin override before the caller reads it again", async () => {
  const settings = SettingsManager.inMemory(
    { packages: ["npm:tool@1.0.0"] },
    { projectTrusted: true },
  );
  const flush = settings.flush.bind(settings);
  let flushCount = 0;
  settings.flush = async () => {
    flushCount += 1;
    await flush();
  };

  await persistProjectPluginOverride(settings, "npm:tool@1.0.0", "disabled");
  await persistProjectPluginOverride(settings, "npm:tool@1.0.0", null);

  assert.equal(flushCount, 2);
});

test("collects top-level extensions with enabled state and scope", () => {
  const paths = {
    extensions: [
      {
        path: "/home/alice/.pi/agent/extensions/execution-supervisor/index.ts",
        enabled: true,
        metadata: {
          source: "auto",
          scope: "user",
          origin: "top-level",
          baseDir: "/home/alice/.pi/agent",
        },
      },
      {
        path: "/home/alice/.pi/agent/extensions/tokentracker-notify.ts",
        enabled: false,
        metadata: {
          source: "auto",
          scope: "user",
          origin: "top-level",
          baseDir: "/home/alice/.pi/agent",
        },
      },
      {
        path: "/tmp/project/.pi/extensions/project.ts",
        enabled: true,
        metadata: {
          source: "path",
          scope: "project",
          origin: "top-level",
          baseDir: "/tmp/project/.pi",
        },
      },
    ],
    skills: [],
    prompts: [],
    themes: [],
  };

  assert.deepEqual(collectTopLevelExtensions(paths, "global").map((item) => ({
    name: item.name,
    relativePath: item.relativePath,
    enabled: item.enabled,
    scope: item.scope,
    status: item.status,
  })), [
    {
      name: "execution-supervisor",
      relativePath: "extensions/execution-supervisor/index.ts",
      enabled: true,
      scope: "global",
      status: "loaded",
    },
    {
      name: "tokentracker-notify",
      relativePath: "extensions/tokentracker-notify.ts",
      enabled: false,
      scope: "global",
      status: "disabled",
    },
  ]);

  assert.equal(collectTopLevelExtensions(paths, "project").length, 3);
});

test("SDK discovers flat top-level extension files", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "reader-top-level-extension-"));
  try {
    await mkdir(join(agentDir, "extensions"));
    const extensionPath = join(agentDir, "extensions", "tokentracker-notify.ts");
    await writeFile(extensionPath, "export default () => {};\n");
    const settings = SettingsManager.inMemory({}, { projectTrusted: true });
    const resolved = await new DefaultPackageManager({
      cwd: agentDir,
      agentDir,
      settingsManager: settings,
    }).resolve(async () => "skip");
    assert.deepEqual(resolved.extensions.map((resource) => ({
      path: resource.path,
      enabled: resource.enabled,
      source: resource.metadata.source,
      origin: resource.metadata.origin,
    })), [{
      path: extensionPath,
      enabled: true,
      source: "auto",
      origin: "top-level",
    }]);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("updates one top-level extension pattern without duplicate entries", () => {
  assert.deepEqual(
    updateTopLevelExtensionPaths(
      ["+extensions/other.ts", "-extensions/execution-supervisor/index.ts"],
      "extensions/execution-supervisor/index.ts",
      true,
    ),
    ["+extensions/other.ts", "+extensions/execution-supervisor/index.ts"],
  );
});

async function makePackage(name) {
  const packageDir = join(root, name);
  await mkdir(join(packageDir, "extensions"), { recursive: true });
  await writeFile(join(packageDir, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
  await writeFile(join(packageDir, "extensions", "index.ts"), "export default () => {};\n");
  return packageDir;
}

test("package inventory exposes the installed manifest description", async () => {
  const source = await makePackage("metadata-fixture");
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "metadata-fixture", version: "1.0.0", description: "测试扩展说明 /fixtureSettings" }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [source] }));
  const response = await GET(new Request(`http://localhost/api/plugins?cwd=${encodeURIComponent(cwd)}&scope=global`));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.packages.find((item) => item.source === source)?.description, "测试扩展说明 /fixtureSettings");
});

const off = { extensions: [], skills: [], prompts: [], themes: [] };
const settingsPath = join(agentDir, "settings.json");

async function readPackages() {
  return JSON.parse(await readFile(settingsPath, "utf8")).packages;
}

function postPlugins(body, projectCwd = cwd) {
  return POST(new Request("http://localhost/api/plugins", {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ cwd: projectCwd, ...body }),
  }));
}

test("bulk disable writes every listed package and reports each one", async () => {
  const [alpha, beta, gamma] = await Promise.all(["bulk-alpha", "bulk-beta", "bulk-gamma"].map(makePackage));
  await writeFile(settingsPath, JSON.stringify({
    packages: [alpha, { source: beta, ...off }, gamma],
  }));

  const response = await postPlugins({
    action: "disable",
    packages: [
      { source: alpha, scope: "global" },
      { source: beta, scope: "global" },
      { source: "npm:removed-since-load", scope: "global" },
    ],
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.results, [
    { source: alpha, scope: "global" },
    { source: beta, scope: "global" },
    { source: "npm:removed-since-load", scope: "global", error: "Package is not configured" },
  ]);
  // gamma was not listed, so the bulk write leaves it alone.
  assert.deepEqual(await readPackages(), [disabledEntry(alpha), { source: beta, ...off }, gamma]);
  const disabled = Object.fromEntries(body.packages.map((pkg) => [pkg.source, pkg.disabled]));
  assert.deepEqual(disabled, { [alpha]: true, [beta]: true, [gamma]: false });
});

test("bulk enable restores disabled packages and keeps a filtered one's filters", async () => {
  const [alpha, beta] = await Promise.all(["bulk-alpha", "bulk-beta"].map(makePackage));
  const filtered = { source: beta, extensions: ["extensions/index.ts"] };
  await writeFile(settingsPath, JSON.stringify({ packages: [{ source: alpha, ...off }, filtered] }));

  const response = await postPlugins({
    action: "enable",
    packages: [{ source: alpha, scope: "global" }, { source: beta, scope: "global" }],
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.results.map((result) => result.error), [undefined, undefined]);
  assert.deepEqual(await readPackages(), [alpha, filtered]);
});

test("bulk toggles refuse an untrusted project's packages without stopping global ones", async () => {
  const alpha = await makePackage("bulk-alpha");
  const untrusted = join(root, "untrusted-project");
  await mkdir(join(untrusted, ".pi"), { recursive: true });
  const projectSettings = JSON.stringify({ packages: ["npm:project-only"] });
  await writeFile(join(untrusted, ".pi", "settings.json"), projectSettings);
  await writeFile(settingsPath, JSON.stringify({ packages: [alpha] }));

  const response = await postPlugins({
    action: "disable",
    packages: [{ source: alpha, scope: "global" }, { source: "npm:project-only", scope: "project" }],
  }, untrusted);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.results[0].error, undefined);
  assert.match(body.results[1].error, /must be trusted/);
  assert.deepEqual(await readPackages(), [disabledEntry(alpha)]);
  assert.equal(await readFile(join(untrusted, ".pi", "settings.json"), "utf8"), projectSettings);
});

test("bulk toggles report a settings file the SDK could not load instead of success", async () => {
  const alpha = await makePackage("bulk-alpha");
  await writeFile(settingsPath, `{ "packages": ["${alpha}"]`);

  const response = await postPlugins({ action: "disable", packages: [{ source: alpha, scope: "global" }] });
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.match(body.error, /JSON|property value|parse/i);
  assert.equal(await readFile(settingsPath, "utf8"), `{ "packages": ["${alpha}"]`);
  await writeFile(settingsPath, JSON.stringify({ packages: [] }));
});

test("bulk toggles reject malformed package lists and other actions", async () => {
  const notAList = await postPlugins({ action: "disable", packages: "npm:x" });
  assert.equal(notAList.status, 400);
  const missingSource = await postPlugins({ action: "disable", packages: [{ scope: "global" }] });
  assert.equal(missingSource.status, 400);
  const remove = await postPlugins({ action: "remove", packages: [{ source: "npm:x", scope: "global" }] });
  assert.equal(remove.status, 400);
});

test("bulk disable preserves a filtered package's patterns while disabling it", async () => {
  const [alpha, beta] = await Promise.all(["bulk-alpha", "bulk-beta"].map(makePackage));
  const filtered = { source: beta, extensions: ["extensions/index.ts"] };
  await writeFile(settingsPath, JSON.stringify({ packages: [alpha, filtered] }));

  const response = await postPlugins({
    action: "disable",
    packages: [{ source: alpha, scope: "global" }, { source: beta, scope: "global" }],
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.results, [
    { source: alpha, scope: "global" },
    { source: beta, scope: "global" },
  ]);
  assert.deepEqual(await readPackages(), [
    disabledEntry(alpha),
    {
      source: beta,
      extensions: ["extensions/index.ts", "!**", disabledPresentMarker],
      skills: ["!**", disabledMarker],
      prompts: ["!**", disabledMarker],
      themes: ["!**", disabledMarker],
    },
  ]);
});

test("enabling restores an entry's own settings from the disabled snapshot", async () => {
  const [alpha, beta] = await Promise.all(["bulk-alpha", "bulk-beta"].map(makePackage));
  const alphaEntry = { source: alpha, autoload: false };
  const betaEntry = { source: beta, autoload: false, extensions: ["extensions/index.ts"] };
  await writeFile(settingsPath, JSON.stringify({
    packages: [
      { ...disabledEntry(alpha), autoload: false },
      {
        ...betaEntry,
        extensions: ["extensions/index.ts", "!**", disabledPresentMarker],
        skills: ["!**", disabledMarker],
        prompts: ["!**", disabledMarker],
        themes: ["!**", disabledMarker],
      },
    ],
  }));

  const single = await postPlugins({ action: "enable", source: alpha, scope: "global" });
  assert.equal(single.status, 200);
  const bulk = await postPlugins({ action: "enable", packages: [{ source: beta, scope: "global" }] });
  assert.equal(bulk.status, 200);

  assert.deepEqual(await readPackages(), [alphaEntry, betaEntry]);
});


test("bulk plugin disable preserves filters and enable restores them exactly", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-plugin-group-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const pkg = join(root, "fixture-package");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await mkdir(agentDir);
    await mkdir(cwd);
    await mkdir(pkg);
    await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "fixture-package", version: "1.0.0" }));
    const original = { source: pkg, skills: ["skills/a", "+skills/b"], autoload: false };
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [original] }));
    const instance = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });
    const { POST } = await instance.import("./route.ts");
    const toggle = (enabled) => POST(new Request("http://localhost/api/plugins", {
      method: "POST", headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ action: "set_packages_enabled", cwd, viewScope: "global", enabled,
        packages: [{ source: pkg, scope: "global" }, { source: "not-configured", scope: "global" }, { source: pkg, scope: "global" }] }),
    }));
    const disabled = await toggle(false);
    assert.equal(disabled.status, 200);
    assert.deepEqual((await disabled.json()).results, [
      { source: pkg, scope: "global" },
      { source: "not-configured", scope: "global", error: "Package is not configured" },
    ]);
    const stored = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
    assert.equal(stored.packages[0].autoload, false);
    assert.deepEqual(stored.packages[0].skills.slice(0, 2), original.skills);
    const enabled = await toggle(true);
    assert.equal(enabled.status, 200);
    assert.deepEqual(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")).packages, [original]);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});


test("global plugin view caps a disabled parent after CLI appends a child include and enable preserves that rule", async () => {
  const source = await makePackage("cli-after-disabled");
  const entry = disabledEntry(source);
  entry.extensions.push("+extensions/index.ts");
  await writeFile(settingsPath, JSON.stringify({ packages: [entry] }));
  const response = await GET(new Request(`http://localhost/api/plugins?cwd=${encodeURIComponent(cwd)}&scope=global`));
  assert.equal(response.status, 200);
  const body = await response.json();
  const item = body.packages.find(pkg => pkg.source === source);
  assert.equal(item.disabled, true);
  assert.equal(item.counts.extensions, 0);
  assert.equal(item.resources[0].resourceState, "disabled");
  assert.deepEqual(await readPackages(), [entry]);
  const enabled = await postPlugins({ action: "enable", source, scope: "global" });
  assert.equal(enabled.status, 200);
  assert.deepEqual(await readPackages(), [{ source, extensions: ["+extensions/index.ts"] }]);
});
