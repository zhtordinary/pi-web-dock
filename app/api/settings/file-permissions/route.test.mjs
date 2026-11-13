import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "reader-old-permissions-"));
const policy = path.join(root, "file-permissions.json");
const marker = `${policy}.initialized`;
const previous = process.env.PI_WEB_FILE_PERMISSIONS_FILE;
process.env.PI_WEB_FILE_PERMISSIONS_FILE = policy;
test.after(() => {
  if (previous === undefined) delete process.env.PI_WEB_FILE_PERMISSIONS_FILE;
  else process.env.PI_WEB_FILE_PERMISSIONS_FILE = previous;
  fs.rmSync(root, { recursive: true, force: true });
});
const { GET, PUT } = await createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false }).import("./route.ts");

const request = (method, host = "localhost", contentType = "application/json") => new Request(`http://${host}/api/settings/file-permissions`, {
  method, headers: { host, "content-type": contentType }, ...(method === "PUT" ? { body: "{}" } : {}),
});

test("old clients receive an explicit retirement response without changing legacy state", async () => {
  const original = '{"version":1,"read":[],"write":[]}\n';
  fs.writeFileSync(policy, original);
  fs.writeFileSync(marker, "1\n");
  for (const method of ["GET", "PUT"]) {
    const response = await (method === "GET" ? GET(request(method)) : PUT(request(method)));
    assert.equal(response.status, 410);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal(fs.readFileSync(policy, "utf8"), original);
  assert.equal(fs.readFileSync(marker, "utf8"), "1\n");
  assert.equal((await GET(request("GET", "evil.example"))).status, 403);
  assert.equal((await PUT(request("PUT", "localhost", "text/plain"))).status, 415);
});
