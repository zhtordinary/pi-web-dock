import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { POST } = await jiti.import("./route.ts");

function request(body, headers = {}) {
  const request = new Request("http://localhost:30141/api/git/write", {
    method: "POST",
    headers: { host: "localhost:30141", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return Object.assign(request, { nextUrl: new URL(request.url) });
}

test("rejects write actions before filesystem access when cwd is invalid", async () => {
  const response = await POST(request({ cwd: "relative", action: "commit" }));
  assert.equal(response.status, 400);
  assert.match(await response.text(), /cwd must be an absolute path/);
});

test("rejects unsupported and non-JSON write requests", async () => {
  const unsupported = await POST(request({ cwd: "/tmp", action: "delete" }));
  assert.equal(unsupported.status, 400);
  const nonJson = await POST(request({ cwd: "/tmp", action: "push" }, { "content-type": "text/plain" }));
  assert.equal(nonJson.status, 415);
});
