import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  APP_PACKAGE_NAME,
  APP_REPOSITORY_URL,
  APP_UPDATE_PACKAGE_NAME,
  APP_UPDATE_REPOSITORY_URL,
  getPiWebReleaseUrl,
  isNewerStableVersion,
} = await jiti.import("./app-update.ts");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("update checks follow the package identity declared in package.json", () => {
  assert.equal(APP_PACKAGE_NAME, packageJson.name);
  assert.equal(`git+${APP_REPOSITORY_URL}.git`, packageJson.repository.url);
  assert.equal(`${APP_REPOSITORY_URL}/issues`, packageJson.bugs.url);
});

test("checks the official upstream Pi Web package for updates", () => {
  assert.equal(APP_UPDATE_PACKAGE_NAME, "@agegr/pi-web");
  assert.equal(APP_UPDATE_REPOSITORY_URL, "https://github.com/agegr/pi-web");
});

test("detects newer stable Pi Web versions", () => {
  assert.equal(isNewerStableVersion("0.8.8", "0.8.7"), true);
  assert.equal(isNewerStableVersion("0.9.0", "0.8.7"), true);
  assert.equal(isNewerStableVersion("1.0.0", "0.9.9"), true);
});

test("does not report equal, older, or unsupported versions as updates", () => {
  assert.equal(isNewerStableVersion("0.8.7", "0.8.7"), false);
  assert.equal(isNewerStableVersion("0.13.0", "0.13.0"), false);
  assert.equal(isNewerStableVersion("0.8.6", "0.8.7"), false);
  assert.equal(isNewerStableVersion("0.8.8-beta.1", "0.8.7"), false);
  assert.equal(isNewerStableVersion("invalid", "0.8.7"), false);
});

test("builds a release-notes URL only for stable versions", () => {
  assert.equal(
    getPiWebReleaseUrl("0.8.8"),
    "https://github.com/agegr/pi-web/releases/tag/v0.8.8",
  );
  assert.equal(getPiWebReleaseUrl("0.8.8-beta.1"), null);
});
