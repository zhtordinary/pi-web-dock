import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { GET, POST } = await jiti.import("./route.ts");

function request(query, body, headers = {}) {
  const request = new Request(`http://localhost:30141/api/git/github${query ? `?${query}` : ""}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { host: "localhost:30141", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return Object.assign(request, { nextUrl: new URL(request.url) });
}

test("rejects relative GitHub cwd", async () => {
  const response = await GET(request("cwd=relative"));
  assert.equal(response.status, 400);
  assert.match(await response.text(), /cwd must be an absolute path/);
});

test("does not expose a GitHub data shell without an eligible repository", async () => {
  const response = await GET(request("cwd=%2Ftmp"));
  assert.equal(response.status, 403);
});

test("requires JSON and an absolute cwd before PR creation", async () => {
  const relative = await POST(request("", { title: "x" }));
  assert.equal(relative.status, 400);
  assert.match(await relative.text(), /cwd must be an absolute path/);
  const nonJson = await POST(request("", { cwd: "/tmp", title: "x" }, { "content-type": "text/plain" }));
  assert.equal(nonJson.status, 415);
});
