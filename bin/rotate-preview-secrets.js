"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const crypto = require("crypto");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");

const PREVIEW_SECRET_KEYS = Object.freeze([
  "previewModeId",
  "previewModeSigningKey",
  "previewModeEncryptionKey",
]);
const PREVIEW_SECRET_BYTES = 32;

function invalidManifest() {
  return new Error("Preview prerender manifest is invalid.");
}

function readManifest(manifestPath, fsModule) {
  let source;
  try {
    source = fsModule.readFileSync(manifestPath, "utf8");
  } catch {
    throw new Error("Preview prerender manifest could not be read.");
  }

  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch {
    throw invalidManifest();
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw invalidManifest();
  }

  const preview = manifest.preview;
  if (!preview || typeof preview !== "object" || Array.isArray(preview)) {
    throw invalidManifest();
  }
  for (const key of PREVIEW_SECRET_KEYS) {
    if (typeof preview[key] !== "string" || preview[key].length === 0) {
      throw invalidManifest();
    }
  }
  return manifest;
}

function createRotatedManifest(manifest, randomBytes) {
  const preview = { ...manifest.preview };
  for (const key of PREVIEW_SECRET_KEYS) {
    const value = randomBytes(PREVIEW_SECRET_BYTES);
    if (!Buffer.isBuffer(value) || value.length !== PREVIEW_SECRET_BYTES) {
      throw new Error("Preview secret generator returned invalid bytes.");
    }
    preview[key] = value.toString("hex");
  }
  return { ...manifest, preview };
}

function writeAll(fd, bytes, fsModule) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fsModule.writeSync(fd, bytes, offset, bytes.length - offset, null);
    if (!Number.isInteger(written) || written <= 0) {
      throw new Error("Preview prerender manifest write made no progress.");
    }
    offset += written;
  }
}

/**
 * Rotate Next's three preview-mode values without exposing them in output.
 * The temporary file is created exclusively beside the manifest, flushed, and
 * renamed over the old file only after the complete JSON document is written.
 */
function rotatePreviewSecrets(
  manifestPath,
  {
    fsModule = fs,
    randomBytes = crypto.randomBytes,
    randomUUID = crypto.randomUUID,
  } = {},
) {
  const manifest = readManifest(manifestPath, fsModule);
  let targetStat;
  try {
    const targetLstat = fsModule.lstatSync(manifestPath);
    if (!targetLstat.isFile() || targetLstat.isSymbolicLink()) throw invalidManifest();
    targetStat = fsModule.statSync(manifestPath);
  } catch (error) {
    if (error?.message === "Preview prerender manifest is invalid.") throw error;
    throw new Error("Preview prerender manifest could not be inspected.");
  }

  const rotated = createRotatedManifest(manifest, randomBytes);
  const bytes = Buffer.from(`${JSON.stringify(rotated, null, 2)}\n`, "utf8");
  const directory = path.dirname(manifestPath);
  const tempPath = path.join(
    directory,
    `.${path.basename(manifestPath)}-${randomUUID()}.tmp`,
  );
  const mode = targetStat.mode & 0o777;
  let fd = null;
  let tempOwned = false;

  try {
    fd = fsModule.openSync(tempPath, "wx", mode);
    tempOwned = true;
    writeAll(fd, bytes, fsModule);
    fsModule.fsyncSync(fd);
    fsModule.closeSync(fd);
    fd = null;
    fsModule.renameSync(tempPath, manifestPath);
    tempOwned = false;
  } finally {
    if (fd !== null) {
      try {
        fsModule.closeSync(fd);
      } catch {
        // Preserve the original write/replace failure.
      }
    }
    if (tempOwned) {
      try {
        fsModule.unlinkSync(tempPath);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          // Never remove or rewrite a path other than this invocation's temp.
        }
      }
    }
  }
}

module.exports = { PREVIEW_SECRET_KEYS, rotatePreviewSecrets };
