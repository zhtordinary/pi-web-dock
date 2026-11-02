import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { createJiti } from "jiti";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reader-file-permissions-")));
const config = path.join(root, "permissions.json");
const env = {
  PI_WEB_FILE_PERMISSIONS_FILE: config,
  PI_CODING_AGENT_DIR: path.join(root, "agent"),
  PI_WEB_PROJECTS_FILE: path.join(root, "projects.json"),
  PI_WEB_SUBPROJECTS_FILE: path.join(root, "subprojects.json"),
};
const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
Object.assign(process.env, env);
fs.writeFileSync(env.PI_WEB_PROJECTS_FILE, JSON.stringify({ projects: [] }));
test.after(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  globalThis.__piKnownProjectsRuntime = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });
const { getAllowedFileRoots, isFilePathAllowed, isExistingFilePathAllowed, allowFileRoot } = await jiti.import("./file-access.ts");
const { readFilePermissions } = await jiti.import("./file-permissions.ts");
const files = await jiti.import("../app/api/files/[...path]/route.ts");
const { POST: validateCwd } = await jiti.import("../app/api/cwd/validate/route.ts");
const folder = (name) => { const p = path.join(root, name); fs.mkdirSync(p, { recursive: true }); return p; };
const policy = (read = [], write = []) => fs.writeFileSync(config, JSON.stringify({ version: 1, read, write }));
function request(method, file, body, type = method === "GET" ? "read" : "write") {
  const init = { method, headers: { host: "localhost", "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return files[method](new NextRequest(`http://localhost/api/files/x?type=${type}`, init), {
    params: Promise.resolve({ path: file.replace(/\\/g, "/").split("/").filter(Boolean) }),
  });
}

test("first use migrates legacy roots once; later discovery does not bypass the policy", async () => {
  const legacy = folder("legacy");
  allowFileRoot(legacy);
  assert.equal(fs.existsSync(config), false);
  assert.equal((await getAllowedFileRoots()).has(legacy), true);
  assert.equal((await getAllowedFileRoots("write")).has(legacy), true);
  const initial = readFilePermissions();
  assert.ok(initial.read.includes("~/.agents/skills"));
  if (process.platform !== "win32") assert.equal(fs.statSync(config).mode & 0o777, 0o600);
  const discovered = folder("discovered");
  fs.writeFileSync(env.PI_WEB_PROJECTS_FILE, JSON.stringify({ projects: [{ path: discovered, addedAt: "now" }] }));
  assert.equal((await getAllowedFileRoots()).has(discovered), false);
  policy();
  assert.deepEqual([...(await getAllowedFileRoots())], []);
  assert.deepEqual([...(await getAllowedFileRoots("write"))], []);
});

test("read and write lists are independent and configuration edits take effect immediately", async () => {
  const read = folder("read"); const write = folder("write");
  policy([read], [write]);
  assert.equal((await getAllowedFileRoots()).has(read), true);
  assert.equal((await getAllowedFileRoots()).has(write), false);
  assert.equal((await getAllowedFileRoots("write")).has(read), false);
  policy([write], []);
  assert.equal((await getAllowedFileRoots()).has(read), false);
  assert.equal((await getAllowedFileRoots()).has(write), true);
});

test("malformed, unsupported, relative and dangling policies fail closed without being replaced", async () => {
  for (const contents of ["{", JSON.stringify({ version: 2, read: [], write: [] }), JSON.stringify({ version: 1, read: ["relative"], write: [] }), JSON.stringify({ version: 1, read: ["/a/../b"], write: [] }), JSON.stringify({ version: 1, read: [], write: [], extra: true })]) {
    fs.writeFileSync(config, contents);
    await assert.rejects(getAllowedFileRoots(), /Cannot read file permissions/);
    assert.throws(() => allowFileRoot(root), /Cannot read file permissions/);
    assert.equal(fs.readFileSync(config, "utf8"), contents);
  }
  fs.unlinkSync(config);
  fs.symlinkSync(path.join(root, "missing-policy"), config);
  await assert.rejects(getAllowedFileRoots(), /Cannot read file permissions/);
  assert.equal(fs.lstatSync(config).isSymbolicLink(), true);
  fs.unlinkSync(config);
  await assert.rejects(getAllowedFileRoots(), /Cannot read file permissions/);
  assert.equal(fs.existsSync(config), false, "a removed policy is not silently recreated");
  policy();
});

test("explicit grants persist, preserve read-only directories and allow read-only link targets", async () => {
  const readonly = folder("readonly-grant"); const fresh = folder("fresh-grant"); const linked = folder("browse-grant");
  policy([readonly], []);
  allowFileRoot(readonly);
  assert.deepEqual(readFilePermissions().write, []);
  allowFileRoot(root);
  assert.equal((await getAllowedFileRoots("write")).has(root), false, "a parent cannot upgrade a protected child");
  policy([readonly], []);
  allowFileRoot(fresh);
  assert.equal((await getAllowedFileRoots("write")).has(fresh), true);
  allowFileRoot(linked, "read");
  assert.equal((await getAllowedFileRoots()).has(linked), true);
  assert.equal((await getAllowedFileRoots("write")).has(linked), false);
});

test("lexical siblings and physical symlink escapes remain denied", async () => {
  const inside = folder("inside"); const outside = folder("inside-other");
  fs.writeFileSync(path.join(outside, "data.txt"), "outside");
  fs.symlinkSync(outside, path.join(inside, "link"), process.platform === "win32" ? "junction" : "dir");
  policy([inside], [inside]);
  for (const access of ["read", "write"]) {
    const roots = await getAllowedFileRoots(access);
    assert.equal(isFilePathAllowed(outside, roots), false);
    assert.equal(isFilePathAllowed(path.join(inside, "link", "data.txt"), roots), true);
    assert.equal(isExistingFilePathAllowed(path.join(inside, "link", "data.txt"), roots), false);
  }
});

test("file routes allow reading a read-only file but refuse all mutations and honor later grants", async () => {
  const dir = folder("route-readonly"); const file = path.join(dir, "note.md");
  fs.writeFileSync(file, "original"); policy([dir], []);
  const response = await request("GET", file);
  assert.equal(response.status, 200);
  const data = await response.json(); assert.equal(data.content, "original"); assert.equal(data.editable, false);
  for (const [method, target, body, type] of [
    ["PUT", file, { content: "changed", version: data.version }, "write"],
    ["PATCH", file, { name: "renamed.md" }, "rename"],
    ["DELETE", file, undefined, "trash"],
    ["POST", dir, { name: "created.md" }, "create-file"],
    ["POST", dir, { fileNames: ["upload.md"] }, "upload-check"],
  ]) assert.equal((await request(method, target, body, type)).status, 403, method);
  assert.equal(fs.readFileSync(file, "utf8"), "original");
  policy([dir], [dir]);
  assert.equal((await request("PUT", file, { content: "changed", version: data.version })).status, 200);
  assert.equal(fs.readFileSync(file, "utf8"), "changed");
  policy([], [dir]);
  for (const type of ["read", "meta", "download", "watch"]) assert.equal((await request("GET", file, undefined, type)).status, 403);
});

test("revoking write access while a rename body is being read prevents the rename", async () => {
  const dir = folder("rename-revoke"); const file = path.join(dir, "note.txt");
  fs.writeFileSync(file, "original"); policy([dir], [dir]);
  const encoded = file.replace(/\\/g, "/").split("/").filter(Boolean);
  const req = new NextRequest("http://localhost/api/files/x?type=rename", {
    method: "PATCH", headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ name: "renamed.txt" }),
  });
  const stream = req.body;
  const reader = stream.getReader.bind(stream);
  Object.defineProperty(stream, "getReader", { value: () => { policy([dir], []); return reader(); } });
  const response = await files.PATCH(req, { params: Promise.resolve({ path: encoded }) });
  assert.equal(response.status, 403);
  assert.equal(fs.readFileSync(file, "utf8"), "original");
  assert.equal(fs.existsSync(path.join(dir, "renamed.txt")), false);
});

test("generic file APIs cannot change the policy or rename/trash a directory containing it", async () => {
  policy([root], [root]); const original = fs.readFileSync(config, "utf8");
  const data = await (await request("GET", config)).json(); assert.equal(data.editable, false);
  for (const [method, target, body, type] of [
    ["PUT", config, { content: "{}", version: data.version }, "write"],
    ["PATCH", config, { name: "moved.json" }, "rename"],
    ["DELETE", config, undefined, "trash"],
    ["PATCH", root, { name: "moved" }, "rename"],
    ["DELETE", root, undefined, "trash"],
    ["POST", root, { name: path.basename(config) }, "create-file"],
  ]) assert.equal((await request(method, target, body, type)).status, 403, method);
  assert.equal(fs.readFileSync(config, "utf8"), original);
});

test("only trusted explicit directory selection grants access and never upgrades read-only", async () => {
  const readonly = folder("selection-readonly"); const fresh = folder("selection-new"); policy([readonly], []);
  const select = (cwd, host = "localhost") => validateCwd(new Request(`http://${host}/api/cwd/validate`, {
    method: "POST", headers: { host, "content-type": "application/json" }, body: JSON.stringify({ cwd, grant: true }),
  }));
  assert.equal((await select(fresh, "evil.example")).status, 403);
  assert.deepEqual(readFilePermissions().write, []);
  const passive = await validateCwd(new Request("http://localhost/api/cwd/validate", {
    method: "POST", headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ cwd: fresh }),
  }));
  assert.equal(passive.status, 200);
  assert.equal((await getAllowedFileRoots()).has(fresh), false, "passive restoration cannot grant access");
  assert.equal((await select(readonly)).status, 200);
  assert.deepEqual(readFilePermissions().write, []);
  assert.equal((await select(fresh)).status, 200);
  assert.equal((await getAllowedFileRoots("write")).has(fresh), true);
});
