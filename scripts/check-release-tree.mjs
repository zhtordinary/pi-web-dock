#!/usr/bin/env node

import { execFileSync } from "node:child_process";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

const branch = git("branch", "--show-current");
const commit = git("rev-parse", "HEAD");
const dirty = git("status", "--porcelain");

if (dirty) {
  console.error("release tree is dirty; commit or hand off all changes before building");
  console.error(dirty);
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ clean: true, branch, commit }));
}
