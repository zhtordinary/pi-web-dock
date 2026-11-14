import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { GET } = await createJiti(import.meta.url).import("../app/manifest.webmanifest/route.ts");

test("public manifest route returns the installable app metadata", async () => {
  const response = GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/manifest+json");

  const manifest = await response.json();
  assert.deepEqual(
    [manifest.id, manifest.name, manifest.short_name, manifest.start_url, manifest.scope],
    ["/", "Pi Web", "Pi Web", "/", "/"],
  );
  assert.deepEqual(manifest.icons, [
    { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
  ]);
});
