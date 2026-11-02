import assert from "node:assert/strict";
import test from "node:test";

import { apiPathForPeer, fileApiPath, htmlPreviewResourceBase } from "./file-api.ts";

test("file API keeps local requests local", () => {
  assert.equal(fileApiPath("/repo/a b.md", "read"), "/api/files/repo/a%20b.md?type=read");
});

test("file API routes remote requests through the selected peer", () => {
  assert.equal(
    fileApiPath("/repo/a b.md", "read", "session-1", "debian", { v: 3 }),
    "/api/remote/files/repo/a%20b.md?type=read&sessionId=session-1&v=3&peer=debian",
  );
});

test("generic peer API path preserves endpoint query and encodes peer", () => {
  assert.equal(
    apiPathForPeer("mac mini", "files/open-apps?ext=md"),
    "/api/remote/files/open-apps?ext=md&peer=mac%20mini",
  );
});

test("file API builds remote write paths with the source session", () => {
  assert.equal(
    fileApiPath("/repo/a b.md", "write", "session-1", "debian"),
    "/api/remote/files/repo/a%20b.md?type=write&sessionId=session-1&peer=debian",
  );
});

test("HTML preview resource base keeps local directory and session context", () => {
  assert.equal(
    htmlPreviewResourceBase("/repo/book/index.html", "session-1"),
    "/api/html-preview/session-1/repo/book/",
  );
});

test("HTML preview resource base keeps remote peer and session context", () => {
  assert.equal(
    htmlPreviewResourceBase("/repo/book/index.html", "session-1", "debian"),
    "/api/remote/html-preview/debian/session-1/repo/book/",
  );
});
