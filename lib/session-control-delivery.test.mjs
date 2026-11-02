import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

test("peer delivery distinguishes accepted, blocked and unknown transport", async (t) => {
  const source = await readFile(new URL("./session-control-delivery.ts", import.meta.url), "utf8");
  assert.match(source, /transport: "unknown"/); assert.match(source, /transport: "blocked"/); assert.match(source, /operation/); assert.match(source, /allowedPeerUrls/);
  const received = [];
  const server = createServer((request, response) => { let body = ""; request.on("data", (chunk) => { body += chunk; }); request.on("end", () => { received.push(JSON.parse(body)); response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ accepted: true, status: "accepted" })); }); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); t.after(() => server.close()); const port = server.address().port; const base = `http://127.0.0.1:${port}`; const previousConfig = process.env.PI_WEB_SESSION_ACTIVITY_CONFIG; process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "d" }, peers: [{ id: "peer", name: "Peer", url: base }] }); t.after(() => { if (previousConfig === undefined) delete process.env.PI_WEB_SESSION_ACTIVITY_CONFIG; else process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = previousConfig; });
  const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false }); const delivery = await jiti.import("./session-control-delivery.ts"); const keys = (await jiti.import("./session-control-auth.ts")).generateSessionControlKeyPair();
  const result = await delivery.pullSessionControlPeer({ url: base, allowedPeerUrls: [base], privateKey: keys.privateKey, sender: { deviceId: "d", sessionId: "s" }, recipient: "peer" });
  assert.equal(result.transport, "accepted"); assert.equal(received[0].operation, "pull_messages"); assert.deepEqual(received[0].scope, ["pull_messages"]);
  await assert.rejects(delivery.pullSessionControlPeer({ url: base, allowedPeerUrls: [], privateKey: keys.privateKey, sender: { deviceId: "d", sessionId: "s" }, recipient: "peer" }), /configured peer/);
});
