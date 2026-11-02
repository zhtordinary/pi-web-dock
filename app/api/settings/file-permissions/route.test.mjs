import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reader-permission-settings-")));
const config = path.join(root, "permissions.json");
const names = ["PI_WEB_FILE_PERMISSIONS_FILE", "PI_WEB_PROJECTS_FILE", "PI_CODING_AGENT_DIR"];
const previous = names.map((name) => process.env[name]);
process.env.PI_WEB_FILE_PERMISSIONS_FILE = config;
process.env.PI_WEB_PROJECTS_FILE = path.join(root, "projects.json");
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
fs.writeFileSync(process.env.PI_WEB_PROJECTS_FILE, JSON.stringify({ projects: [] }));
test.after(() => {
  names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
  fs.rmSync(root, { recursive: true, force: true });
});
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });
const { GET, PUT } = await jiti.import("./route.ts");
const { allowFileRoot, getAllowedFileRoots } = await jiti.import("../../../../lib/file-access.ts");
const request = (body, host = "localhost", contentType = "application/json") => new Request(`http://${host}/api/settings/file-permissions`, {
  method: "PUT", headers: { host, "content-type": contentType }, body: JSON.stringify(body),
});
const get = () => GET(new Request("http://localhost/api/settings/file-permissions", { headers: { host: "localhost" } }));

test("the settings endpoint initializes once and saves independent read and write lists", async () => {
  const initial = await get();
  assert.equal(initial.status, 200); assert.equal(initial.headers.get("cache-control"), "no-store");
  const snapshot = await initial.json(); assert.equal(snapshot.path, config); assert.match(snapshot.revision, /^[a-f0-9]{64}$/);
  const allowed = path.join(root, "allowed"); fs.mkdirSync(allowed);
  const result = await PUT(request({ action: "save", revision: snapshot.revision, read: [allowed], write: [] }));
  assert.equal(result.status, 200);
  const saved = await result.json();
  assert.deepEqual(saved.policy.read, [allowed]); assert.deepEqual(saved.policy.write, []);
  assert.deepEqual(saved.policy.previous, { read: snapshot.policy.read, write: snapshot.policy.write });
  assert.notEqual(saved.revision, snapshot.revision);
  assert.deepEqual([...await getAllowedFileRoots()], [allowed]);
  assert.deepEqual([...await getAllowedFileRoots("write")], []);
});

test("conflict, invalid path, untrusted host and wrong content type do not overwrite the policy", async () => {
  const initial = await (await get()).json();
  const direct = JSON.stringify({ ...initial.policy, read: [root] }, null, 2) + "\n";
  fs.writeFileSync(config, direct);
  const stale = await PUT(request({ action: "save", revision: initial.revision, read: [], write: [] }));
  assert.equal(stale.status, 409); assert.equal((await stale.json()).code, "revision_conflict");
  assert.equal(fs.readFileSync(config, "utf8"), direct);
  const current = await (await get()).json();
  for (const body of [
    { action: "save", revision: current.revision, read: ["relative"], write: [] },
    { action: "save", revision: current.revision, read: [], write: ["/bad/../escape"] },
    { action: "save", revision: current.revision, read: [], write: "wrong" },
  ]) assert.equal((await PUT(request(body))).status, 400);
  assert.equal((await PUT(request({ action: "save", revision: current.revision, read: [], write: [] }, "evil.example"))).status, 403);
  assert.equal((await PUT(request({ action: "save", revision: current.revision, read: [], write: [] }, "localhost", "text/plain"))).status, 415);
  assert.equal(fs.readFileSync(config, "utf8"), direct);
});

test("restore swaps to the preceding permission snapshot under the same revision check", async () => {
  const before = await (await get()).json();
  const changedResponse = await PUT(request({ action: "save", revision: before.revision, read: [], write: [] }));
  assert.equal(changedResponse.status, 200); const changed = await changedResponse.json();
  const restoredResponse = await PUT(request({ action: "restore", revision: changed.revision }));
  assert.equal(restoredResponse.status, 200); const restored = await restoredResponse.json();
  assert.deepEqual(restored.policy.read, before.policy.read);
  assert.deepEqual(restored.policy.write, before.policy.write);
  assert.deepEqual(restored.policy.previous, { read: [], write: [] });
  assert.equal((await PUT(request({ action: "restore", revision: changed.revision }))).status, 409);
});

test("an explicit directory grant conflicts with an already-open settings draft", async () => {
  const initial = await (await get()).json();
  assert.equal((await PUT(request({ action: "save", revision: initial.revision, read: [], write: [] }))).status, 200);
  const before = await (await get()).json();
  const added = path.join(root, "new-project"); fs.mkdirSync(added);
  allowFileRoot(added);
  const response = await PUT(request({ action: "save", revision: before.revision, read: [], write: [] }));
  assert.equal(response.status, 409);
  assert.ok((await (await get()).json()).policy.read.includes(added));
});
