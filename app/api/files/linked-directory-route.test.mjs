import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reader-linked-route-")));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR);
test.after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  fs.rmSync(base, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { GET, POST, PUT } = await jiti.import("./[...path]/route.ts");
const { fileVersion } = await jiti.import("../../../lib/file-edit.ts");
const { encodeFilePathForApi } = await jiti.import("../../../lib/file-paths.ts");
const { NextRequest } = await jiti.import("next/server");

function request(method, filePath, type, body) {
  const encoded = encodeFilePathForApi(filePath);
  const init = { method, headers: { host: "localhost", ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
  const handler = method === "GET" ? GET : method === "PUT" ? PUT : POST;
  return handler(new NextRequest(`http://localhost/api/files/${encoded}?type=${type}`, init), {
    params: Promise.resolve({ path: encoded.split("/").map(decodeURIComponent) }),
  });
}

function fixture(t) {
  const hub = fs.mkdtempSync(path.join(base, "hub-"));
  const target = fs.mkdtempSync(path.join(base, "target-"));
  fs.writeFileSync(path.join(target, "linked.txt"), "linked");
  try {
    fs.symlinkSync(target, path.join(hub, "linked"), process.platform === "win32" ? "junction" : "dir");
    fs.symlinkSync(path.join(base, "missing"), path.join(hub, "dangling"));
  } catch (error) {
    if (error?.code === "EPERM") { t.skip("Creating symbolic links requires additional privileges"); return null; }
    throw error;
  }
  return { hub, target };
}

test("directory links outside the project are shown and can be read and edited without approval", async (t) => {
  const data = fixture(t); if (!data) return;
  const { entries } = await (await request("GET", data.hub, "list")).json();
  assert.equal(entries.find((entry) => entry.name === "linked")?.isDir, true);
  assert.equal(entries.find((entry) => entry.name === "linked")?.isSymlink, true);
  assert.equal(entries.find((entry) => entry.name === "dangling")?.isSymlink, true);
  assert.deepEqual((await (await request("GET", path.join(data.hub, "linked"), "list")).json()).entries.map((entry) => entry.name), ["linked.txt"]);
  const file = path.join(data.hub, "linked", "linked.txt");
  const response = await request("GET", file, "read");
  const body = await response.json();
  assert.equal(body.content, "linked");
  assert.equal(body.editable, true);
  assert.equal((await request("PUT", file, "write", { content: "changed", version: body.version })).status, 200);
  assert.equal(fs.readFileSync(path.join(data.target, "linked.txt"), "utf8"), "changed");
  assert.equal((await request("PUT", file, "write", { content: "stale", version: body.version })).status, 409);
  assert.equal(fs.readFileSync(path.join(data.target, "linked.txt"), "utf8"), "changed");
  assert.equal((await request("POST", path.join(data.hub, "linked"), "allow-link", { target: data.target })).status, 410);
});

test("binary and media files cannot be overwritten as text", async (t) => {
  const data = fixture(t); if (!data) return;
  for (const [name, original] of [["binary.dat", Buffer.from([65, 0, 66, 67])], ["photo.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xd9])]]) {
    const file = path.join(data.target, name);
    fs.writeFileSync(file, original);
    const response = await request("PUT", file, "write", { content: "replacement", version: fileVersion(fs.statSync(file)) });
    assert.equal(response.status, 415);
    assert.deepEqual(fs.readFileSync(file), original);
  }
  const binary = path.join(data.target, "binary.dat");
  assert.equal((await (await request("GET", binary, "read&offset=1")).json()).editable, false);
});

test("PDF navigation retains range support for linked files", async (t) => {
  const data = fixture(t); if (!data) return;
  const file = path.join(data.target, "outside.pdf");
  const link = path.join(data.hub, "linked.pdf");
  fs.writeFileSync(file, "%PDF-outside");
  fs.symlinkSync(file, link);
  const encoded = encodeFilePathForApi(link);
  const context = { params: Promise.resolve({ path: encoded.split("/").map(decodeURIComponent) }) };
  const headers = { host: "localhost", "sec-fetch-site": "same-origin", range: "bytes=0-3" };
  const response = await GET(new NextRequest(`http://localhost/api/files/${encoded}?type=read`, { headers }), context);
  assert.equal(response.status, 206);
  assert.equal(await response.text(), "%PDF");
  assert.match(response.headers.get("content-range"), /^bytes 0-3\//);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});
