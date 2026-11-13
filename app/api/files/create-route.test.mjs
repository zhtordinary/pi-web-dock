import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const source = fs.readFileSync(new URL("./[...path]/route.ts", import.meta.url), "utf8");

test("file create route keeps bounded JSON and race-safe conflicts", () => {
  assert.match(source, /type === "create-folder" \|\| type === "create-file"/);
  assert.match(source, /readJsonWithinLimit\(request, MAX_CREATE_REQUEST_BYTES\)/);
  assert.match(source, /validateUploadFileNames\(\[parsed\.name\]\)/);
  assert.match(source, /const targetPath = path\.join\(directory, parsed\.name\)/);
  assert.match(source, /hasParentDirectorySegment\(directory\)/);
  assert.match(source, /isCreateDirectoryStillBound\(directory, directoryIdentityAtStart\)/);
  assert.match(source, /fs\.mkdirSync\(targetPath\)/);
  assert.match(source, /fs\.writeFileSync\(targetPath, "", \{ flag: "wx" \}\)/);
  assert.match(source, /A file or folder with that name already exists/);
  assert.match(source, /const MAX_CREATE_REQUEST_BYTES = 16 \* 1024/);
  assert.match(source, /status: 413/);
});

// macOS exposes the temporary directory through /var while filesystem APIs
// resolve it to /private/var. Keep the fixture's allowed roots physical so the
// route exercises the same canonical paths it uses for writes.
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-file-create-")));
const home = path.join(fixture, "home");
const workspace = path.join(home, "workspace");
const outside = path.join(fixture, "outside");
fs.mkdirSync(path.join(home, ".pi", "agent", "sessions"), { recursive: true });
fs.mkdirSync(path.join(home, ".config"), { recursive: true });
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(outside, { recursive: true });
const projectsFile = path.join(home, "projects.json");
fs.writeFileSync(projectsFile, JSON.stringify({ projects: [{ path: workspace, addedAt: new Date().toISOString() }] }));
const previousEnv = {
  HOME: process.env.HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  PI_WEB_PROJECTS_FILE: process.env.PI_WEB_PROJECTS_FILE,
};
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = path.join(home, ".config");
process.env.PI_CODING_AGENT_DIR = path.join(home, ".pi", "agent");
process.env.PI_WEB_PROJECTS_FILE = projectsFile;
globalThis.__piAllowedRootsCache = undefined;
globalThis.__piKnownProjectsRuntime = undefined;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false });
const { POST } = await jiti.import("./[...path]/route.ts");

function request(type, name, segments = ["~", "workspace"]) {
  const request = new Request(`http://localhost/api/files/${segments.join("/")}?type=${type}`, {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost" },
    body: JSON.stringify({ name }),
  });
  Object.defineProperty(request, "nextUrl", { value: new URL(request.url) });
  return request;
}

async function post(type, name, segments = ["~", "workspace"]) {
  return POST(request(type, name, segments), { params: Promise.resolve({ path: segments }) });
}

test.after(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.__piAllowedRootsCache = undefined;
  globalThis.__piKnownProjectsRuntime = undefined;
  fs.rmSync(fixture, { recursive: true, force: true });
});

test("creates a folder and blank document in the selected project", async () => {
  const folder = await post("create-folder", "docs");
  assert.equal(folder.status, 200);
  assert.deepEqual(await folder.json(), {
    created: true,
    path: path.join(workspace, "docs"),
    name: "docs",
    isDir: true,
  });
  assert.equal(fs.statSync(path.join(workspace, "docs")).isDirectory(), true);

  const file = await post("create-file", "README.md", ["~", "workspace", "docs"]);
  assert.equal(file.status, 200);
  assert.deepEqual(await file.json(), {
    created: true,
    path: path.join(workspace, "docs", "README.md"),
    name: "README.md",
    isDir: false,
  });
  assert.equal(fs.readFileSync(path.join(workspace, "docs", "README.md"), "utf8"), "");
});

test("rejects conflicts and invalid names while permitting external linked directories", async () => {
  const conflict = await post("create-file", "README.md", ["~", "workspace", "docs"]);
  assert.equal(conflict.status, 409);

  const traversal = await post("create-file", "../escape.md");
  assert.equal(traversal.status, 400);

  const link = path.join(workspace, "outside-link");
  fs.symlinkSync(outside, link, "dir");
  const linked = await post("create-file", "linked.md", ["~", "workspace", "outside-link"]);
  assert.equal(linked.status, 200);
  assert.equal(fs.readFileSync(path.join(outside, "linked.md"), "utf8"), "");

  const outsideSegments = outside.split(path.sep).filter(Boolean);
  const outsideResponse = await post("create-file", "direct.md", outsideSegments);
  assert.equal(outsideResponse.status, 200);
  assert.equal(fs.readFileSync(path.join(outside, "direct.md"), "utf8"), "");
});


test("rejects a parent replacement observed by final identity validation", async () => {
  const raceDirectory = path.join(workspace, "race-dir");
  const parkedDirectory = path.join(workspace, "race-dir-parked");
  fs.mkdirSync(raceDirectory);
  const originalRealpathSync = fs.realpathSync;
  let directoryRealpathCalls = 0;
  fs.realpathSync = ((target, ...args) => {
    if (path.resolve(String(target)) === path.resolve(raceDirectory)) {
      directoryRealpathCalls += 1;
      if (directoryRealpathCalls === 2) {
        fs.renameSync(raceDirectory, parkedDirectory);
        fs.symlinkSync(outside, raceDirectory, "dir");
      }
    }
    return originalRealpathSync(target, ...args);
  });
  try {
    const response = await post("create-file", "escaped.md", ["~", "workspace", "race-dir"]);
    assert.equal(response.status, 409);
    assert.equal(fs.existsSync(path.join(outside, "escaped.md")), false);
  } finally {
    fs.realpathSync = originalRealpathSync;
    if (fs.existsSync(raceDirectory) || fs.lstatSync(raceDirectory, { throwIfNoEntry: false })?.isSymbolicLink()) fs.rmSync(raceDirectory, { recursive: true, force: true });
    if (fs.existsSync(parkedDirectory)) fs.renameSync(parkedDirectory, raceDirectory);
  }
});
