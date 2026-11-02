import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { createJiti } from "jiti";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-cwd-browse-")));
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = path.join(root, "gitconfig");
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, "");
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

async function browse(directory, query = "") {
  const response = await GET(new NextRequest(
    `http://localhost/api/cwd/browse?path=${encodeURIComponent(directory)}${query ? `&${query}` : ""}`,
  ));
  return { response, data: await response.json() };
}

test("cwd browse shows Git-ignored choices by default and supports opt-in hiding", async () => {
  const repo = path.join(root, "repo");
  write(path.join(repo, ".gitignore"), "ignored/\n");
  write(path.join(repo, "ignored", "tracked", "keep.txt"));
  fs.mkdirSync(path.join(repo, "ignored", "untracked"), { recursive: true });
  fs.mkdirSync(path.join(repo, "project"));
  git(repo, "init", "-q");
  git(repo, "add", ".gitignore");
  git(repo, "add", "-f", "ignored/tracked/keep.txt");

  const rootResult = await browse(repo);
  assert.equal(rootResult.response.status, 200);
  assert.deepEqual(rootResult.data.directories.map((entry) => entry.name), ["ignored", "project"]);

  const ignoredResult = await browse(path.join(repo, "ignored"));
  assert.equal(ignoredResult.response.status, 200);
  assert.deepEqual(ignoredResult.data.directories.map((entry) => entry.name), ["tracked", "untracked"]);

  const hiddenIgnoredResult = await browse(path.join(repo, "ignored"), "hideGitIgnored=1");
  assert.equal(hiddenIgnoredResult.response.status, 200);
  assert.deepEqual(hiddenIgnoredResult.data.directories.map((entry) => entry.name), ["tracked"]);

  const plain = path.join(root, "plain");
  fs.mkdirSync(path.join(plain, ".build"), { recursive: true });
  fs.mkdirSync(path.join(plain, ".ruff_cache"), { recursive: true });
  fs.mkdirSync(path.join(plain, ".pi", "messenger"), { recursive: true });
  fs.mkdirSync(path.join(plain, ".pi", "task-plans-by-plan-execute"), { recursive: true });
  fs.mkdirSync(path.join(plain, ".pi", "normal"), { recursive: true });
  fs.mkdirSync(path.join(plain, ".archify"));
  fs.mkdirSync(path.join(plain, "project"));
  const plainResult = await browse(plain);
  assert.equal(plainResult.response.status, 200);
  assert.deepEqual(plainResult.data.directories.map((entry) => entry.name), [".pi", "project"]);

  const piResult = await browse(path.join(plain, ".pi"));
  assert.equal(piResult.response.status, 200);
  assert.deepEqual(piResult.data.directories.map((entry) => entry.name), ["normal"]);
});

test("cwd browse distinguishes missing paths and files", async () => {
  const file = path.join(root, "file.txt");
  write(file, "file");

  const missing = await browse(path.join(root, "missing"));
  assert.equal(missing.response.status, 404);
  const nonDirectory = await browse(file);
  assert.equal(nonDirectory.response.status, 400);
});
