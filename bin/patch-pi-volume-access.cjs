/* eslint-disable @typescript-eslint/no-require-imports */
const { dirname, join } = require("node:path");
const { readFileSync, writeFileSync } = require("node:fs");

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const SUPPORTED_VERSIONS = new Set(["1.2.0", "1.4.0"]);
const PATCH_MARKER_PREFIX = "pi-web-volume-access:";

// macOS APFS volumes with ownership disabled can return EPERM from access(2)
// while open/read/write and process spawn still work. Treat that preflight as
// inconclusive; the real operation remains the authoritative permission check.
const PATCHES = [
  {
    relative: "dist/core/tools/read.js",
    marker: `${PATCH_MARKER_PREFIX}read`,
    oldText: `    access: (path) => fsAccess(path, constants.R_OK),`,
    newText: `    /* ${PATCH_MARKER_PREFIX}read */
    access: async (path) => {
        try {
            await fsAccess(path, constants.R_OK);
        }
        catch (error) {
            if (error?.code !== "EPERM")
                throw error;
        }
    },`,
  },
  {
    relative: "dist/core/tools/edit.js",
    marker: `${PATCH_MARKER_PREFIX}edit`,
    oldText: `    access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),`,
    newText: `    /* ${PATCH_MARKER_PREFIX}edit */
    access: async (path) => {
        try {
            await fsAccess(path, constants.R_OK | constants.W_OK);
        }
        catch (error) {
            if (error?.code !== "EPERM")
                throw error;
        }
    },`,
  },
  {
    relative: "dist/core/tools/edit-diff.js",
    marker: `${PATCH_MARKER_PREFIX}edit-diff`,
    oldText: `        catch (error) {
            const errorMessage = error instanceof Error && "code" in error ? \`Error code: \${error.code}\` : String(error);
            return { error: \`Could not edit file: \${path}. \${errorMessage}.\` };
        }`,
    newText: `        catch (error) {
            /* ${PATCH_MARKER_PREFIX}edit-diff */
            if (error?.code !== "EPERM") {
                const errorMessage = error instanceof Error && "code" in error ? \`Error code: \${error.code}\` : String(error);
                return { error: \`Could not edit file: \${path}. \${errorMessage}.\` };
            }
        }`,
  },
  {
    relative: "dist/core/tools/bash.js",
    marker: `${PATCH_MARKER_PREFIX}bash`,
    oldText: `            try {
                await fsAccess(cwd, constants.F_OK);
            }
            catch {
                throw new Error(\`Working directory does not exist: \${cwd}\\nCannot execute \${shellName} commands.\`);
            }`,
    newText: `            /* ${PATCH_MARKER_PREFIX}bash */
            try {
                await fsAccess(cwd, constants.F_OK);
            }
            catch (error) {
                if (error?.code !== "EPERM") {
                    throw new Error(\`Working directory does not exist: \${cwd}\\nCannot execute \${shellName} commands.\`);
                }
            }`,
  },
];

function piPackageRoot() {
  // The package is ESM-only at its export entry, so CommonJS require.resolve
  // cannot resolve it by package name during npm's postinstall hook. A direct
  // dependency gives us the installed node_modules directory without bypassing
  // package resolution outside the current install.
  const nodeModules = dirname(dirname(require.resolve("node-pty/package.json")));
  return join(nodeModules, "@earendil-works", "pi-coding-agent");
}

function patchPiFileTools(packageRoot = piPackageRoot()) {
  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  if (!SUPPORTED_VERSIONS.has(packageJson.version)) {
    throw new Error(`${PACKAGE_NAME} ${[...SUPPORTED_VERSIONS].join(" or ")} patch expected, found ${packageJson.version}`);
  }

  let changed = 0;
  for (const patch of PATCHES) {
    const file = join(packageRoot, patch.relative);
    const source = readFileSync(file, "utf8");
    if (source.includes(patch.marker)) continue;
    const occurrences = source.split(patch.oldText).length - 1;
    if (occurrences !== 1) {
      throw new Error(`Cannot apply ${patch.marker}: expected one match in ${file}, found ${occurrences}`);
    }
    writeFileSync(file, source.replace(patch.oldText, patch.newText));
    changed += 1;
  }
  return changed;
}

module.exports = { PACKAGE_NAME, SUPPORTED_VERSIONS, PATCHES, patchPiFileTools, piPackageRoot };

if (require.main === module) {
  const changed = patchPiFileTools();
  process.stdout.write(`pi-coding-agent volume-access patch: ${changed ? `${changed} files patched` : "already applied"}\n`);
}
