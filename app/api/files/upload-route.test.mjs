import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-upload-route-")));
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

const routeSource = fs.readFileSync(new URL("./[...path]/route.ts", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false });
const { POST } = await jiti.import("./[...path]/route.ts");

function uploadRequest(files, conflict = "error", segments = ["~", "workspace"]) {
  const form = new FormData();
  for (const file of files) form.append("files", new File([file.content], file.name));
  const url = new URL(`http://localhost:30141/api/files/${segments.join("/")}`);
  url.searchParams.set("type", "upload");
  url.searchParams.set("conflict", conflict);
  const request = new Request(url, {
    method: "POST",
    headers: { host: "localhost:30141" },
    body: form,
  });
  Object.defineProperty(request, "nextUrl", { value: url });
  return request;
}

async function post(files, conflict = "error", segments) {
  return POST(uploadRequest(files, conflict, segments), {
    params: Promise.resolve({ path: segments ?? ["~", "workspace"] }),
  });
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

test("keeps conflict strategies and writes complete atomic upload bytes", async () => {
  fs.writeFileSync(path.join(workspace, "existing.txt"), "old complete bytes");

  const error = await post([{ name: "existing.txt", content: "new bytes" }], "error");
  assert.equal(error.status, 409);
  assert.equal(fs.readFileSync(path.join(workspace, "existing.txt"), "utf8"), "old complete bytes");

  const skipped = await post([{ name: "existing.txt", content: "skipped bytes" }], "skip");
  assert.equal(skipped.status, 200);
  assert.deepEqual(await skipped.json(), { uploaded: [], skipped: ["existing.txt"], errors: [] });
  assert.equal(fs.readFileSync(path.join(workspace, "existing.txt"), "utf8"), "old complete bytes");

  const overwritten = await post([{ name: "existing.txt", content: "new complete bytes" }], "overwrite");
  assert.equal(overwritten.status, 200);
  assert.deepEqual(await overwritten.json(), { uploaded: ["existing.txt"], skipped: [], errors: [] });
  assert.equal(fs.readFileSync(path.join(workspace, "existing.txt"), "utf8"), "new complete bytes");
  assert.deepEqual(fs.readdirSync(workspace), ["existing.txt"]);
});

test("preserves old bytes when the atomic replacement fails", async () => {
  const destination = path.join(workspace, "replace-failure.txt");
  fs.writeFileSync(destination, "old bytes survive");
  const originalRename = fs.renameSync;
  fs.renameSync = ((from, to) => {
    if (path.resolve(String(to)) === path.resolve(destination)) {
      const error = new Error("synthetic upload replace failure");
      error.code = "EIO";
      throw error;
    }
    return originalRename(from, to);
  });
  try {
    const response = await post([{ name: "replace-failure.txt", content: "new bytes must not leak" }], "overwrite");
    assert.equal(response.status, 207);
    const body = await response.json();
    assert.deepEqual(body.uploaded, []);
    assert.equal(body.errors.length, 1);
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(fs.readFileSync(destination, "utf8"), "old bytes survive");
  assert.deepEqual(fs.readdirSync(workspace).filter((name) => name.includes("upload.tmp")), []);
});

test("rejects unsafe file names and directory conflicts, while allowing external linked directories", async () => {
  fs.mkdirSync(path.join(workspace, "folder"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  fs.symlinkSync(outside, path.join(workspace, "outside-link"), "dir");

  const directory = await post([{ name: "folder", content: "not a file" }], "overwrite");
  assert.equal(directory.status, 207);
  assert.match((await directory.json()).errors[0].error, /directory or symbolic link/);

  const traversal = await post([{ name: "../escape.txt", content: "no" }], "error");
  assert.equal(traversal.status, 400);
  const linkDirectory = await post([{ name: "linked.txt", content: "linked" }], "error", ["~", "workspace", "outside-link"]);
  assert.equal(linkDirectory.status, 200);
  assert.equal(fs.readFileSync(path.join(outside, "linked.txt"), "utf8"), "linked");
  const outsideSegments = outside.split(path.sep).filter(Boolean);
  const outsideResponse = await post([{ name: "direct.txt", content: "direct" }], "error", outsideSegments);
  assert.equal(outsideResponse.status, 200);
  assert.equal(fs.readFileSync(path.join(outside, "direct.txt"), "utf8"), "direct");
});

test("keeps the directory identity recheck and atomic helper in the upload branch", () => {
  assert.match(routeSource, /isCreateDirectoryStillBound\(directory, directoryIdentityAtStart\)/);
  assert.match(routeSource, /writeUploadFileAtomicSync\(destination, bytes/);
  assert.doesNotMatch(routeSource, /fs\.unlinkSync\(destination\)/);
  assert.match(routeSource, /MAX_UPLOAD_FILE_BYTES/);
  assert.match(routeSource, /MAX_UPLOAD_TOTAL_BYTES/);
});
