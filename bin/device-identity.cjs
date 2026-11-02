/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// One resolver for Reader and its standalone workers. Cache parsed bytes, not
// identity: environment changes and explicit file replacements are rechecked on
// every call. There is no TTL that can silently keep an obsolete device id.
let cachedInline;
let inlineConfig;
let cachedFile;
let fileFingerprint;
let fileConfig;

function activityConfigFile() {
  return process.env.PI_WEB_SESSION_ACTIVITY_CONFIG_FILE
    || path.join(process.env.HOME || ".", ".config", "pi-web-reader", "session-activity-peers.json");
}

function freezeConfig(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeConfig(child);
    Object.freeze(value);
  }
  return value;
}

function parseConfig(text) {
  const config = JSON.parse(text);
  return freezeConfig(config && typeof config === "object" && !Array.isArray(config) ? config : {});
}

function fingerprint(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

function readActivityConfig() {
  const inline = process.env.PI_WEB_SESSION_ACTIVITY_CONFIG;
  if (inline) {
    if (inline !== cachedInline) {
      cachedInline = inline;
      try { inlineConfig = parseConfig(inline); }
      catch { inlineConfig = undefined; }
    }
    if (inlineConfig) return inlineConfig;
  }
  const file = activityConfigFile();
  try {
    const before = fs.statSync(file, { bigint: true });
    if (!before.isFile()) return {};
    const key = fingerprint(before);
    if (cachedFile === file && fileFingerprint === key) return fileConfig;
    const parsed = parseConfig(fs.readFileSync(file, "utf8"));
    const after = fs.statSync(file, { bigint: true });
    // Do not publish/cache a configuration that changed during its read.
    if (fingerprint(after) !== key) return {};
    cachedFile = file;
    fileFingerprint = key;
    fileConfig = parsed;
    return parsed;
  } catch {
    // Missing/invalid configuration must not reuse the last successful value.
    cachedFile = undefined;
    fileFingerprint = undefined;
    fileConfig = undefined;
    return {};
  }
}

function nonempty(value) { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function localDeviceId(config = readActivityConfig()) {
  return nonempty(config?.device?.id) || nonempty(process.env.PI_WEB_DEVICE_ID) || os.hostname();
}
function localDeviceName(config = readActivityConfig()) {
  return nonempty(config?.device?.name) || nonempty(process.env.PI_WEB_DEVICE_NAME) || os.hostname();
}

module.exports = { activityConfigFile, readActivityConfig, localDeviceId, localDeviceName };
