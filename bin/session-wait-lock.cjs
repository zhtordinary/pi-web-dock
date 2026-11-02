/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";
const fs = require("node:fs");
const childProcess = require("node:child_process");
function startIdentity(pid, platform = process.platform, runPs = childProcess.execFileSync) {
  if (platform === "linux") { try { return `linux:${fs.readFileSync(`/proc/${pid}/stat`, "utf8").trim().split(" ")[21] || ""}`; } catch { return null; } }
  if (platform === "darwin") { try { return `darwin:${runPs("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim()}`; } catch { return null; } }
  return null;
}
function isAlive(pid, token, platform = process.platform, current = (value) => startIdentity(value, platform)) {
  if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); } catch (error) { return error?.code === "EPERM"; } const now = current(pid); return !token || !now || now === token;
}
module.exports = { startIdentity, isAlive };
