#!/usr/bin/env node
"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
function defaultRoot() { return process.env.PI_WEB_SESSION_WAIT_STATE_ROOT || path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "session-control-waits"); }
function parse(argv) {
  const out = { platform: process.platform === "darwin" ? "darwin" : "linux", channel: "reader", stateRoot: defaultRoot(), readerUrl: process.env.PI_WEB_SESSION_WAIT_READER_URL || null, dryRun: false, apply: false, executeManager: false, action: "render", entry: null, healthFile: null, peerUrl: null, pullPeerId: null, privateKeyFile: null, senderDeviceId: null, senderSessionId: null, senderFile: null, mode: "push", allowedPeerUrls: [] };
  for (let i = 0; i < argv.length; i += 1) { const arg = argv[i]; const next = () => argv[++i];
    if (arg === "--platform") out.platform = next(); else if (arg.startsWith("--platform=")) out.platform = arg.slice(11);
    else if (arg === "--channel") out.channel = next(); else if (arg.startsWith("--channel=")) out.channel = arg.slice(10);
    else if (arg === "--state-root") out.stateRoot = next(); else if (arg.startsWith("--state-root=")) out.stateRoot = arg.slice(13);
    else if (arg === "--entry") out.entry = next(); else if (arg.startsWith("--entry=")) out.entry = arg.slice(8);
    else if (arg === "--health-file") out.healthFile = next(); else if (arg.startsWith("--health-file=")) out.healthFile = arg.slice(14);
    else if (arg === "--peer-url") out.peerUrl = next(); else if (arg.startsWith("--peer-url=")) out.peerUrl = arg.slice(11);
    else if (arg === "--pull-peer-id") out.pullPeerId = next(); else if (arg.startsWith("--pull-peer-id=")) out.pullPeerId = arg.slice(16);
    else if (arg === "--reader-url") out.readerUrl = next(); else if (arg.startsWith("--reader-url=")) out.readerUrl = arg.slice(13);
    else if (arg === "--mode") out.mode = next(); else if (arg.startsWith("--mode=")) out.mode = arg.slice(7);
    else if (arg === "--sender-file") out.senderFile = next(); else if (arg.startsWith("--sender-file=")) out.senderFile = arg.slice(14);
    else if (arg === "--allowed-peer-url") out.allowedPeerUrls.push(next()); else if (arg.startsWith("--allowed-peer-url=")) out.allowedPeerUrls.push(arg.slice(19));
    else if (arg === "--private-key-file") out.privateKeyFile = next(); else if (arg.startsWith("--private-key-file=")) out.privateKeyFile = arg.slice(19);
    else if (arg === "--sender-device-id") out.senderDeviceId = next(); else if (arg.startsWith("--sender-device-id=")) out.senderDeviceId = arg.slice(19);
    else if (arg === "--sender-session-id") out.senderSessionId = next(); else if (arg.startsWith("--sender-session-id=")) out.senderSessionId = arg.slice(19);
    else if (arg === "--action") out.action = next(); else if (arg.startsWith("--action=")) out.action = arg.slice(9);
    else if (arg === "--dry-run") out.dryRun = true; else if (arg === "--apply") out.apply = true; else if (arg === "--execute-manager") out.executeManager = true;
  }
  if (!out.dryRun && !out.apply && !out.executeManager) out.dryRun = true;
  if (!["linux", "darwin"].includes(out.platform)) throw new Error("platform must be linux or darwin");
  if (!["push", "pull"].includes(out.mode)) throw new Error("mode must be push or pull");
  if (!["render", "install", "status", "stop", "recover"].includes(out.action)) throw new Error("unsupported service action");
  return out;
}
function quote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }
function xmlEscape(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;"); }
function uid() { return typeof process.getuid === "function" ? String(process.getuid()) : String(process.env.UID || "unknown"); }
function healthFile(options) { return path.resolve(options.healthFile || path.join(options.stateRoot, `worker-${options.channel}.health.json`)); }
function workerArgs(options, health) {
  const args = ["--state-root", options.stateRoot, "--channel", options.channel, "--health-file", health]; if (options.mode === "pull") args.push("--mode", "pull");
  for (const [flag, value] of [["--peer-url", options.peerUrl], ["--pull-peer-id", options.pullPeerId], ["--reader-url", options.readerUrl], ["--private-key-file", options.privateKeyFile], ["--sender-file", options.senderFile], ["--sender-device-id", options.senderDeviceId], ["--sender-session-id", options.senderSessionId]]) if (value) args.push(flag, value);
  for (const value of options.allowedPeerUrls) args.push("--allowed-peer-url", value);
  return args;
}
function render(options) {
  const entry = options.entry || path.join(process.cwd(), "bin", "session-wait-worker.cjs"); const health = healthFile(options); const argv = [process.execPath, entry, ...workerArgs(options, health)];
  if (options.platform === "linux") { const command = argv.map(quote).join(" "); return { kind: "systemd-user", file: `pi-web-session-wait-${options.channel}.service`, content: `[Unit]\nDescription=Pi Web Reader persistent session wait worker (${options.channel})\nAfter=default.target\n\n[Service]\nExecStart=${command}\nRestart=on-failure\nRestartSec=5\nNoNewPrivileges=true\nPrivateTmp=true\n\n[Install]\nWantedBy=default.target\n`, manager: { install: ["systemctl", "--user", "enable", "--now", `pi-web-session-wait-${options.channel}.service`], stop: ["systemctl", "--user", "stop", `pi-web-session-wait-${options.channel}.service`] } }; }
  const label = `com.pi-web.reader.session-wait.${options.channel}`; const plistArgs = argv.map(xmlEscape).map((value) => `<string>${value}</string>`).join(""); return { kind: "launchd-user", file: `${label}.plist`, content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xmlEscape(label)}</string><key>ProgramArguments</key><array>${plistArgs}</array><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer></dict></plist>\n`, manager: { install: ["launchctl", "bootstrap", `gui/${uid()}`, path.join(process.env.HOME || os.homedir(), "Library", "LaunchAgents", `${label}.plist`)], stop: ["launchctl", "bootout", `gui/${uid()}/${label}`] } };
}
function managerPlan(options, template, action) { if (options.platform === "linux") return action === "status" ? ["systemctl", "--user", "is-active", template.file] : action === "stop" ? template.manager.stop : template.manager.install; return action === "status" ? ["launchctl", "print", `gui/${uid()}/${template.file.replace(/\.plist$/, "")}`] : action === "stop" ? template.manager.stop : template.manager.install; }
function servicePath(options, template) { return options.platform === "darwin" ? path.join(process.env.HOME || os.homedir(), "Library", "LaunchAgents", template.file) : path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || os.homedir(), ".config"), "systemd", "user", template.file); }
function maybeExecuteManager(options, command) { if (!options.executeManager) return null; const result = childProcess.spawnSync(command[0], command.slice(1), { encoding: "utf8" }); return { command, status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" }; }
function readStatus(options) { const health = healthFile(options); let worker = null; try { worker = JSON.parse(fs.readFileSync(health, "utf8")); } catch { worker = { status: "blocked", reason: "health file missing", healthFile: health }; } return { action: "status", stateRoot: path.resolve(options.stateRoot), channel: options.channel, healthFile: health, lockPresent: fs.existsSync(path.join(path.resolve(options.stateRoot), `.worker-${options.channel}.lock`)), worker }; }
function main() { const options = parse(process.argv.slice(2)); const template = render(options); const plan = managerPlan(options, template, options.action); if (options.action === "status") { const call = maybeExecuteManager(options, plan); console.log(JSON.stringify({ ok: !call || call.status === 0, mode: options.executeManager ? "execute-manager" : options.dryRun ? "dry-run" : "apply", ...readStatus(options), managerPlan: plan, managerCalls: call ? [call] : [] }, null, 2)); return; } const destination = servicePath(options, template); if (["stop", "recover"].includes(options.action)) { const marker = path.join(path.resolve(options.stateRoot), `${options.action}.request.json`); const call = maybeExecuteManager(options, plan); console.log(JSON.stringify({ ok: !call || call.status === 0, mode: options.executeManager ? "execute-manager" : options.dryRun ? "dry-run" : "apply", action: options.action, stateRoot: path.resolve(options.stateRoot), managerPlan: plan, managerCalls: call ? [call] : [], marker }, null, 2)); return; } let written = null; let lifecycle = null; if (options.apply) { fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 }); fs.writeFileSync(destination, template.content, { mode: 0o600 }); lifecycle = `${destination}.lifecycle.json`; fs.writeFileSync(lifecycle, JSON.stringify({ manager: template.manager, managerPlan: plan, destination, note: "AI/project activation must explicitly invoke --execute-manager; this entry never invokes a service manager by default" }, null, 2) + "\n", { mode: 0o600 }); written = destination; } const call = maybeExecuteManager(options, plan); console.log(JSON.stringify({ ok: !call || call.status === 0, mode: options.executeManager ? "execute-manager" : options.dryRun ? "dry-run" : "apply", action: options.action, platform: options.platform, channel: options.channel, stateRoot: path.resolve(options.stateRoot), managerPlan: plan, managerCalls: call ? [call] : [], template, ...(written ? { written, lifecycle } : {}) }, null, 2)); }
main();
