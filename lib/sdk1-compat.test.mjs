import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";

const require = createRequire(import.meta.url);
const SDK_NAMES = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-codemode",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-mcp",
  "@earendil-works/pi-telemetry",
  "@earendil-works/pi-tui",
];

async function packageRoot(name) {
  const resolved = await import.meta.resolve(name);
  let directory = dirname(new URL(resolved).pathname);
  while (directory !== dirname(directory)) {
    try {
      const metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      if (metadata.name === name) return { directory, metadata };
    } catch {}
    directory = dirname(directory);
  }
  throw new Error(`package root not found: ${name}`);
}

test("SDK 1.4 package identities, services/session ABI, and package-local CLI stay bound", async () => {
  const packages = Object.fromEntries(await Promise.all(SDK_NAMES.map(async (name) => [name, await packageRoot(name)])));
  for (const name of SDK_NAMES) assert.equal(packages[name].metadata.version, "1.4.0", name);

  const core = await import("@earendil-works/pi-agent-core");
  const ai = await import("@earendil-works/pi-ai");
  const coding = await import("@earendil-works/pi-coding-agent");
  const tui = await import("@earendil-works/pi-tui");
  assert.ok(core);
  assert.equal(typeof ai.createAssistantMessageEventStream, "function");
  assert.equal(typeof tui.KeybindingsManager, "function");
  assert.equal(typeof coding.createAgentSessionServices, "function");
  assert.equal(typeof coding.createAgentSessionFromServices, "function");

  const root = await mkdtemp(join(tmpdir(), "reader-sdk1-compat-"));
  try {
    const project = join(root, "project");
    const agentDir = join(root, "agent");
    await mkdir(project, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    const services = await coding.createAgentSessionServices({
      cwd: project,
      agentDir,
      resourceLoaderOptions: { enableSkillCommands: false },
    });
    assert.deepEqual(services.diagnostics, []);
    const manager = coding.SessionManager.create(project, join(agentDir, "sessions"));
    const created = await coding.createAgentSessionFromServices({
      services,
      sessionManager: manager,
      noTools: true,
    });
    assert.equal(created.session.sessionManager, manager);
    assert.equal(manager.getCwd(), project);
    created.session.dispose();

    const cli = join(packages["@earendil-works/pi-coding-agent"].directory, packages["@earendil-works/pi-coding-agent"].metadata.bin.pi);
    const version = spawnSync(process.execPath, [cli, "--version"], {
      cwd: project,
      encoding: "utf8",
      env: {
        HOME: join(root, "home"),
        USERPROFILE: join(root, "home"),
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
      },
    });
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout.trim(), "1.4.0");

    const route = await readFile(new URL("../app/api/sessions/[id]/export/route.ts", import.meta.url), "utf8");
    assert.match(route, /dist\", \"bundle\", \"cli\.js\"/);
    assert.match(route, /resolvePiPackageIndex/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
