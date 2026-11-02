import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-hidden-"));
const hiddenFile = path.join(directory, "hidden.json");
process.env.PI_WEB_HIDDEN_FILE = hiddenFile;
const hidden = await import("./hidden-state.ts");

test.after(() => fs.rmSync(directory, { recursive: true, force: true }));

test("starts empty and persists add/remove", async () => {
  globalThis.__piHiddenStateCache = undefined;
  assert.deepEqual(hidden.readHiddenState(), { sessions: [], projects: [], devices: [], visibleSessions: [] });
  hidden.setHidden("session", "s1", true);
  hidden.setHidden("project", "/proj", true);
  assert.deepEqual(hidden.readHiddenState(), { sessions: ["s1"], projects: ["/proj"], devices: [], visibleSessions: [] });
  hidden.setHidden("session", "s1", false);
  assert.deepEqual(hidden.readHiddenState(), { sessions: [], projects: ["/proj"], devices: [], visibleSessions: ["s1"] });
  const persisted = JSON.parse(fs.readFileSync(hiddenFile, "utf8"));
  assert.equal(persisted.schemaVersion, 1);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(hiddenFile).mode & 0o777, 0o600);
  }
});

test("dedupes ids and ignores invalid entries on load", () => {
  globalThis.__piHiddenStateCache = undefined;
  hidden.setHidden("device", "d1", true);
  hidden.setHidden("device", "d1", true);
  fs.writeFileSync(hiddenFile, JSON.stringify({ schemaVersion: 1, sessions: ["s1", "s1", 7, ""], projects: "nope", devices: ["d1"] }));
  globalThis.__piHiddenStateCache = undefined;
  assert.deepEqual(hidden.readHiddenState(), { sessions: ["s1"], projects: [], devices: ["d1"], visibleSessions: [] });
});

test("idempotent remove and blank id are no-ops", () => {
  globalThis.__piHiddenStateCache = undefined;
  fs.rmSync(hiddenFile, { force: true });
  hidden.setHidden("session", "s1", true);
  hidden.setHidden("session", "s1", false);
  hidden.setHidden("session", "s1", false);
  hidden.setHidden("session", "  ", true);
  assert.deepEqual(hidden.readHiddenState(), { sessions: [], projects: [], devices: [], visibleSessions: ["s1"] });
});

test("moving a session out of a hidden project creates only the needed visibility exception", () => {
  globalThis.__piHiddenStateCache = undefined;
  fs.rmSync(hiddenFile, { force: true });
  hidden.setHidden("project", "p1", true);
  hidden.setHidden("session", "s1", true);
  hidden.restoreSessionForStorage("s1", "p1");
  assert.deepEqual(hidden.readHiddenState(), { sessions: [], projects: ["p1"], devices: [], visibleSessions: ["s1"] });

  hidden.restoreSessionForStorage("s2", "p2");
  assert.deepEqual(hidden.readHiddenState(), { sessions: [], projects: ["p1"], devices: [], visibleSessions: ["s1"] });
});

test("restoring a project clears every child hide and visibility exception without affecting other projects", () => {
  globalThis.__piHiddenStateCache = undefined;
  fs.rmSync(hiddenFile, { force: true });
  hidden.setHidden("project", "p1", true);
  hidden.setHidden("session", "s1", true);
  hidden.setHidden("session", "s2", false);
  hidden.setHidden("session", "s3", true);
  hidden.setHidden("session", "exception", false);
  hidden.setHidden("session", "other", true);
  const sessions = [
    { id: "s1", projectKey: "p1" },
    { id: "s2", projectKey: "p2" },
    { id: "s3", projectKey: "p1" },
    { id: "exception", projectKey: "p1" },
    { id: "other", projectKey: "p2" },
  ];
  hidden.clearProjectHidden("p1", sessions);
  assert.deepEqual(hidden.readHiddenState(), { sessions: ["other"], projects: [], devices: [], visibleSessions: ["s2"] });
  assert.equal(hidden.isHidden("d1", "s1", "p1"), false);
  assert.equal(hidden.isHidden("d1", "s3", "p1"), false);
  assert.equal(hidden.isHidden("d1", "inherited", "p1"), false);
  hidden.clearProjectHidden("p1", sessions);
  assert.deepEqual(hidden.readHiddenState(), { sessions: ["other"], projects: [], devices: [], visibleSessions: ["s2"] });
});

test("session visibility override beats inherited project hiding and direct hide wins", () => {
  globalThis.__piHiddenStateCache = undefined;
  fs.rmSync(hiddenFile, { force: true });
  hidden.setHidden("project", "p1", true);
  assert.equal(hidden.isHidden("d1", "s1", "p1"), true);
  hidden.setHidden("session", "s1", false);
  assert.equal(hidden.isHidden("d1", "s1", "p1"), false);
  hidden.setHidden("session", "s1", true);
  assert.equal(hidden.isHidden("d1", "s1", "p1"), true);
  hidden.setHidden("device", "d1", true);
  hidden.setHidden("session", "s4", false);
  assert.equal(hidden.isHidden("d1", "s2", "p2"), true);
  assert.equal(hidden.isHidden("d1", "s4", "p2"), true);
  assert.equal(hidden.isHidden("d2", "s3", undefined), false);
});

test("clearing a deleted session removes direct and visible records", () => {
  globalThis.__piHiddenStateCache = undefined;
  fs.rmSync(hiddenFile, { force: true });
  hidden.setHidden("session", "s1", false);
  hidden.setHidden("session", "s2", true);
  hidden.clearSessionHidden("s1");
  hidden.clearSessionHidden("s2");
  assert.deepEqual(hidden.readHiddenState(), { sessions: [], projects: [], devices: [], visibleSessions: [] });
});
