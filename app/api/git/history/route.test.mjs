import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { GET } = await jiti.import("./route.ts");

function request(query) {
  const request = new Request(`http://localhost:30141/api/git/history?${query}`, {
    headers: { host: "localhost:30141" },
  });
  return Object.assign(request, { nextUrl: new URL(request.url) });
}

test("rejects relative history cwd", async () => {
  const response = await GET(request("cwd=relative"));
  assert.equal(response.status, 400);
  assert.match(await response.text(), /cwd must be an absolute path/);
});

test("rejects non-hex commit hashes", async () => {
  const response = await GET(request("cwd=%2Ftmp&hash=HEAD~1"));
  assert.equal(response.status, 400);
  assert.match(await response.text(), /hash must be a Git commit hash/);
});
