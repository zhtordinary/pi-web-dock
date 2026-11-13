import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { createJiti } from "jiti";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-files-route-")));
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
const { GET } = await jiti.import("./[...path]/route.ts");

function write(filePath, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function request(filePath, type, query = "") {
  const segments = filePath.replace(/\\/g, "/").split("/").filter(Boolean);
  return GET(
    new NextRequest(`http://localhost/api/files/x?type=${type}${query ? `&${query}` : ""}`),
    { params: Promise.resolve({ path: segments }) },
  );
}

async function listNames(dir, query = "") {
  const response = await request(dir, "list", query);
  assert.equal(response.status, 200);
  const { entries } = await response.json();
  return entries.map((entry) => entry.name);
}

test("shows Git-ignored entries by default and hides them when the project enables it", async () => {
  const repo = path.join(root, "repo");
  write(path.join(repo, ".gitignore"), "dist/\n");
  write(path.join(repo, "build/index.js"));
  write(path.join(repo, "dist/bundle.js"), "bundle");
  write(path.join(repo, "src/main.ts"));
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", ["-C", repo, "add", ".gitignore", "build", "src"]);

  assert.deepEqual(await listNames(repo), ["build", "dist", "src", ".gitignore"]);
  assert.deepEqual(await listNames(repo, "hideGitIgnored=1"), ["build", "src"]);
  // Explicit dotfile filtering is independent of Git visibility.
  assert.deepEqual(await listNames(repo, "hideDot=1"), ["build", "dist", "src"]);
  // Revealing dotfiles includes .git; filtering is not an access boundary.
  const visibleDotfiles = await listNames(repo, "hideDot=0");
  assert.ok(visibleDotfiles.includes(".git"));
  assert.ok(visibleDotfiles.includes(".gitignore"));

  // Visibility only: an ignored file is still readable by its path.
  const read = await request(path.join(repo, "dist/bundle.js"), "read");
  assert.equal(read.status, 200);
  assert.equal((await read.json()).content, "bundle");
});

test("reports explicit list errors for invalid, missing and non-directory paths", async () => {
  const repo = path.join(root, "errors");
  write(path.join(repo, "file.txt"), "text");
  execFileSync("git", ["-C", repo, "init", "-q"]);

  assert.equal((await request(repo, "unknown")).status, 400);
  assert.equal((await request(path.join(repo, "missing"), "list")).status, 404);
  assert.equal((await request(path.join(repo, "file.txt"), "list")).status, 400);
});

test("keeps the name list for a directory outside Git", async () => {
  const plain = path.join(root, "plain");
  write(path.join(plain, "build/index.js"));
  write(path.join(plain, "node_modules/pkg/index.js"));
  write(path.join(plain, "src/main.ts"));

  assert.deepEqual(await listNames(plain), ["src"]);
});
