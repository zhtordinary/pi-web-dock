import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { createJiti } from "jiti";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-file-index-")));
fs.writeFileSync(path.join(root, "gitconfig"), "");
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = path.join(root, "gitconfig");
process.env.XDG_CONFIG_HOME = path.join(root, "xdg");
process.env.GIT_CEILING_DIRECTORIES = root;
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET } = await jiti.import("./route.ts");

function write(filePath, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function git(cwd, ...args) {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}

function request(cwd, params = {}) {
  const query = new URLSearchParams({ cwd, ...params });
  return GET(new NextRequest(`http://localhost/api/file-index?${query}`));
}

test("disables repository fsmonitor while enumerating the full Git listing", { skip: process.platform === "win32" }, async () => {
  const repo = path.join(root, "fsmonitor-repo");
  write(path.join(repo, "src", "main.ts"));
  git(repo, "init", "-q");
  const marker = path.join(root, "file-index-fsmonitor-ran");
  const hook = path.join(root, "file-index-fsmonitor-hook.sh");
  fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  git(repo, "config", "core.fsmonitor", hook);

  const response = await request(repo);
  assert.equal(response.status, 200);
  assert.equal(fs.existsSync(marker), false);
});

test("shows Git-ignored files by default and hides them when requested", async () => {
  const repo = path.join(root, "repo");
  write(path.join(repo, ".gitignore"), [
    "/.archify/",
    "/.build/",
    "/.ruff_cache/",
    "/.pi/messenger/",
    "/.pi/task-plans-by-plan-execute/",
    "ignored/",
    "__pycache__/",
    "*.py[cod]",
  ].join("\n") + "\n");
  write(path.join(repo, ".build", "tracked.txt"));
  write(path.join(repo, ".build", "untracked.txt"));
  write(path.join(repo, ".pi", "task-plans-by-plan-execute", "tracked.md"));
  write(path.join(repo, ".pi", "messenger", "hidden.json"));
  write(path.join(repo, "ignored", "nested", "hidden.txt"));
  write(path.join(repo, "notes", "readme.md"));
  write(path.join(repo, "src", "tracked.ts"));
  git(repo, "init", "-q");
  git(repo, "add", ".gitignore", "notes", "src");
  git(repo, "add", "-f", ".build/tracked.txt", ".pi/task-plans-by-plan-execute/tracked.md");

  const listingResponse = await request(repo);
  assert.equal(listingResponse.status, 200);
  const listing = await listingResponse.json();
  assert.equal(listing.truncated, false);
  assert.deepEqual(new Set(listing.files), new Set([
    ".gitignore",
    ".build/tracked.txt",
    ".build/untracked.txt",
    ".pi/messenger/hidden.json",
    ".pi/task-plans-by-plan-execute/tracked.md",
    "ignored/nested/hidden.txt",
    "notes/readme.md",
    "src/tracked.ts",
  ]));

  const hiddenListingResponse = await request(repo, { hideGitIgnored: "1" });
  assert.equal(hiddenListingResponse.status, 200);
  const hiddenListing = await hiddenListingResponse.json();
  assert.deepEqual(new Set(hiddenListing.files), new Set([
    ".gitignore",
    ".build/tracked.txt",
    ".pi/task-plans-by-plan-execute/tracked.md",
    "notes/readme.md",
    "src/tracked.ts",
  ]));

  const trackedSearch = await request(repo, { q: "tracked.md" });
  assert.equal(trackedSearch.status, 200);
  assert.deepEqual((await trackedSearch.json()).matches.map((match) => match.path), [
    ".pi/task-plans-by-plan-execute/tracked.md",
  ]);

  const ignoredSearch = await request(repo, { q: "hidden" });
  assert.equal(ignoredSearch.status, 200);
  assert.deepEqual(new Set((await ignoredSearch.json()).matches.map((match) => match.path)), new Set([
    ".pi/messenger/hidden.json",
    "ignored/nested/hidden.txt",
  ]));

  const hiddenSearch = await request(repo, { q: "hidden", hideGitIgnored: "1" });
  assert.equal(hiddenSearch.status, 200);
  assert.deepEqual((await hiddenSearch.json()).matches, []);
});

test("the non-Git walk hides generated candidates without hiding ordinary project files", async () => {
  const plain = path.join(root, "plain");
  for (const file of [
    ".archify/index.html",
    ".build/output.js",
    ".ruff_cache/state",
    ".pi/messenger/events.json",
    ".pi/task-plans-by-plan-execute/plan.md",
    "__pycache__/module.pyc",
    "module.pyo",
    "module.pyd",
    "docs/guide.md",
    "keep/notes.txt",
  ]) write(path.join(plain, file));

  const listing = await request(plain);
  assert.equal(listing.status, 200);
  assert.deepEqual(new Set((await listing.json()).files), new Set(["docs/guide.md", "keep/notes.txt"]));

  const visibleSearch = await request(plain, { q: "guide" });
  assert.deepEqual((await visibleSearch.json()).matches.map((match) => match.path), ["docs/guide.md"]);
  const hiddenSearch = await request(plain, { q: "messenger" });
  assert.deepEqual((await hiddenSearch.json()).matches, []);
});

test("file-index reports invalid, missing and non-directory cwd explicitly", async () => {
  const file = path.join(root, "plain-file.txt");
  write(file, "file");

  assert.equal((await request("relative/path")).status, 400);
  assert.equal((await request(`${root}/../outside`)).status, 400);
  assert.equal((await request(path.join(root, "missing"))).status, 404);
  assert.equal((await request(file)).status, 400);
});

test("limits broad non-Git walks and yields while indexing", async () => {
  const broad = path.join(root, "broad");
  fs.mkdirSync(broad);
  for (let index = 0; index < 2050; index++) fs.mkdirSync(path.join(broad, `folder-${index}`));
  let yielded = false;
  setTimeout(() => { yielded = true; }, 0);
  const response = await request(broad);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).truncated, true);
  assert.equal(yielded, true);
});
