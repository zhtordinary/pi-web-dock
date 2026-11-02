import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { POST } = await jiti.import("./route.ts");

function request(body, headers = {}) {
  return new Request("http://localhost:30141/api/git/summary", {
    method: "POST",
    headers: {
      host: "localhost:30141",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

test("rejects invalid Git AI mode before touching the filesystem", async () => {
  const response = await POST(request({ cwd: "/tmp", mode: "write" }));
  assert.equal(response.status, 400);
  assert.match(await response.text(), /mode must be summary, commit-message, or release-notes/);
});

test("rejects non-absolute cwd", async () => {
  const response = await POST(request({ cwd: "relative", mode: "summary" }));
  assert.equal(response.status, 400);
  assert.match(await response.text(), /cwd must be an absolute path/);
});

test("rejects non-JSON requests", async () => {
  const response = await POST(new Request("http://localhost:30141/api/git/summary", {
    method: "POST",
    headers: { host: "localhost:30141", "content-type": "text/plain" },
    body: "{}",
  }));
  assert.equal(response.status, 415);
});
