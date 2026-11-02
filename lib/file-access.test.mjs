import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Loaded through jiti so the module's own extensionless imports resolve the way
// the app resolves them (tsconfig moduleResolution: "bundler"); bare
// `import("./path-security.ts")` only works while that file has no imports.
async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./path-security.ts");
}

async function loadFileAccess() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url, {
    alias: { "@": process.cwd() },
    interopDefault: true,
    moduleCache: false,
  }).import("./file-access.ts");
}

test("authorization inventory preserves orphan assignments and does not persist the session scan index", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "reader-observe-roots-"));
  const envKeys = ["PI_CODING_AGENT_DIR", "PI_WEB_SUBPROJECTS_FILE", "PI_WEB_PROJECTS_FILE", "PI_WEB_FILE_PERMISSIONS_FILE"];
  const previous = envKeys.map(key => process.env[key]);
  process.env.PI_WEB_FILE_PERMISSIONS_FILE = path.join(base, "file-permissions.json");
  process.env.PI_CODING_AGENT_DIR = base;
  process.env.PI_WEB_SUBPROJECTS_FILE = path.join(base, "subprojects.json");
  process.env.PI_WEB_PROJECTS_FILE = path.join(base, "projects.json");
  fs.writeFileSync(process.env.PI_WEB_PROJECTS_FILE, JSON.stringify({ projects: [] }));
  for (const root of ["sessions", "archived_sessions", "deleted_sessions"]) fs.mkdirSync(path.join(base, root, "project"), { recursive: true });
  fs.writeFileSync(path.join(base, "sessions/project/observed.jsonl"), JSON.stringify({ type: "session", version: 3,
    id: "observed", cwd: base, timestamp: "2026-10-15T00:00:00.000Z" }) + "\n");
  const { createJiti } = await import("jiti"); const jiti = createJiti(import.meta.url, { moduleCache: false });
  const state = await jiti.import("./subproject-state.ts");
  const scanner = await jiti.import("./session-list-scanner.ts");
  state.resetSubprojectStateForTests(); scanner.resetSessionScanIndexForTests();
  globalThis.__piKnownProjectsRuntime = undefined; globalThis.__piAllowedRootsCache = undefined;
  t.after(() => {
    envKeys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    state.resetSubprojectStateForTests(); scanner.resetSessionScanIndexForTests();
    globalThis.__piKnownProjectsRuntime = undefined; globalThis.__piAllowedRootsCache = undefined;
    fs.rmSync(base, { recursive: true, force: true });
  });
  const group = state.createSubproject("orphan-project", "Preserve");
  state.assignSession("orphan-project", "permanently-deleted", group.id);
  const before = fs.readFileSync(process.env.PI_WEB_SUBPROJECTS_FILE);
  const { getAllowedFileRoots } = await loadFileAccess();
  assert.ok((await getAllowedFileRoots()).has(base));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fs.readFileSync(process.env.PI_WEB_SUBPROJECTS_FILE), before);
  assert.equal(fs.existsSync(path.join(base, "pi-web-session-index.json")), false);
});

test("rejects an existing path that escapes an allowed root through a symlink", async (t) => {
  const { isExistingPathWithinRoots, isPathWithinRoots } = await loadSubject();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-file-access-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const allowed = path.join(base, "allowed");
  const outside = path.join(base, "outside");
  fs.mkdirSync(allowed);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  const link = path.join(allowed, "link");
  fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  const target = path.join(link, "secret.txt");
  const roots = new Set([allowed]);

  assert.equal(isPathWithinRoots(target, roots), true);
  assert.equal(isExistingPathWithinRoots(target, roots), false);
});

test("keeps persisted known projects allowed after runtime cache rebuild", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-known-project-root-"));
  const project = path.join(base, "project");
  const projectsFile = path.join(base, "projects.json");
  fs.mkdirSync(project);
  fs.writeFileSync(projectsFile, JSON.stringify({ projects: [{ path: project, addedAt: new Date().toISOString() }] }));
  const previousProjectsFile = process.env.PI_WEB_PROJECTS_FILE;
  const previousPolicyFile = process.env.PI_WEB_FILE_PERMISSIONS_FILE;
  process.env.PI_WEB_FILE_PERMISSIONS_FILE = path.join(base, "file-permissions.json");
  process.env.PI_WEB_PROJECTS_FILE = projectsFile;
  globalThis.__piKnownProjectsRuntime = undefined;
  globalThis.__piAllowedRootsCache = undefined;
  t.after(() => {
    if (previousProjectsFile === undefined) delete process.env.PI_WEB_PROJECTS_FILE;
    else process.env.PI_WEB_PROJECTS_FILE = previousProjectsFile;
    if (previousPolicyFile === undefined) delete process.env.PI_WEB_FILE_PERMISSIONS_FILE;
    else process.env.PI_WEB_FILE_PERMISSIONS_FILE = previousPolicyFile;
    globalThis.__piKnownProjectsRuntime = undefined;
    globalThis.__piAllowedRootsCache = undefined;
    fs.rmSync(base, { recursive: true, force: true });
  });

  const { getAllowedFileRoots, isExistingFilePathAllowed } = await loadFileAccess();
  const roots = await getAllowedFileRoots();
  assert.equal(isExistingFilePathAllowed(project, roots), true);
});

test("rejects a `..` that climbs out beside a link's target", async (t) => {
  const { hasParentDirectorySegment, isExistingPathWithinRoots } = await loadSubject();
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-file-access-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const allowed = path.join(base, "allowed");
  const outside = path.join(base, "outside");
  fs.mkdirSync(allowed);
  fs.mkdirSync(path.join(outside, "linked"), { recursive: true });
  fs.symlinkSync(path.join(outside, "linked"), path.join(allowed, "link"), process.platform === "win32" ? "junction" : "dir");
  const roots = new Set([allowed]);

  // realpathSync reads `allowed/link/..` as `allowed`; opening it lists `outside`.
  const climb = `${allowed}${path.sep}link${path.sep}..`;
  assert.equal(isExistingPathWithinRoots(climb, roots), false);
  assert.equal(isExistingPathWithinRoots(path.join(allowed, "link"), new Set([allowed, outside])), true);

  assert.equal(hasParentDirectorySegment("/a/b/../c"), true);
  assert.equal(hasParentDirectorySegment("C:\\a\\..\\c"), true);
  assert.equal(hasParentDirectorySegment("/a/..b/c.."), false);
  if (process.platform !== "win32") assert.equal(hasParentDirectorySegment("/a/b\\..\\c"), false);
});

test("opens global .agents/skills in the file reader without allowing sibling folders or escaping links", async (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-global-skill-root-")));
  const fakeHome = path.join(base, "home");
  const skillPath = path.join(fakeHome, ".agents", "skills", "demo", "SKILL.md");
  const physicalAgents = path.join(base, "shared-agents");
  const projectsFile = path.join(base, "projects.json");
  const envKeys = ["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "PI_WEB_PROJECTS_FILE", "PI_WEB_SUBPROJECTS_FILE", "PI_WEB_FILE_PERMISSIONS_FILE"];
  const previous = envKeys.map((key) => process.env[key]);
  t.after(() => {
    envKeys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    globalThis.__piKnownProjectsRuntime = undefined;
    globalThis.__piAllowedRootsCache = undefined;
    fs.rmSync(base, { recursive: true, force: true });
  });

  const linkType = process.platform === "win32" ? "junction" : "dir";
  const content = "---\ndescription: demo\n---\n";
  fs.mkdirSync(fakeHome);
  fs.mkdirSync(path.join(physicalAgents, "skills", "demo"), { recursive: true });
  fs.writeFileSync(path.join(physicalAgents, "skills", "demo", "SKILL.md"), content);
  fs.symlinkSync(physicalAgents, path.join(fakeHome, ".agents"), linkType);
  fs.mkdirSync(path.join(physicalAgents, "skills-other"));
  fs.writeFileSync(path.join(physicalAgents, "skills-other", "SKILL.md"), content);
  const outside = path.join(base, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "SKILL.md"), content);
  fs.symlinkSync(outside, path.join(physicalAgents, "skills", "escape"), linkType);
  fs.writeFileSync(projectsFile, JSON.stringify({ projects: [] }));
  process.env.PI_WEB_FILE_PERMISSIONS_FILE = path.join(base, "permissions.json");
  process.env.HOME = fakeHome;
  if (process.platform === "win32") process.env.USERPROFILE = fakeHome;
  process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
  process.env.PI_WEB_PROJECTS_FILE = projectsFile;
  process.env.PI_WEB_SUBPROJECTS_FILE = path.join(base, "subprojects.json");
  globalThis.__piKnownProjectsRuntime = undefined;
  globalThis.__piAllowedRootsCache = undefined;

  const { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed } = await loadFileAccess();
  const roots = await getAllowedFileRoots();
  assert.equal(isFilePathAllowed(skillPath, roots), true);
  assert.equal(isExistingFilePathAllowed(skillPath, roots), true);
  const sibling = path.join(fakeHome, ".agents", "skills-other", "SKILL.md");
  const escape = path.join(fakeHome, ".agents", "skills", "escape", "SKILL.md");
  assert.equal(isFilePathAllowed(sibling, roots), false);
  assert.equal(isFilePathAllowed(escape, roots), true);
  assert.equal(isExistingFilePathAllowed(escape, roots), false);

  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });
  const { NextRequest } = await import("next/server.js");
  const { GET } = await jiti.import("../app/api/files/[...path]/route.ts");
  const read = (filePath) => GET(new NextRequest("http://localhost/api/files/x?type=read"), {
    params: Promise.resolve({ path: filePath.replace(/\\/g, "/").split("/").filter(Boolean) }),
  });
  const response = await read(skillPath);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.content, content);
  assert.equal(body.editable, true);
  for (const denied of [sibling, escape]) {
    const refusal = await read(denied);
    assert.equal(refusal.status, 403);
    assert.deepEqual(await refusal.json(), { error: "Access denied" });
  }
});
