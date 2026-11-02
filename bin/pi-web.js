#!/usr/bin/env node
"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getUnsupportedNodeVersionMessage, isNodeVersionSupported } = require("./node-version");

if (!isNodeVersionSupported(process.versions.node)) {
  console.error(getUnsupportedNodeVersionMessage(process.versions.node));
  process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn } = require("child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { homedir } = require("os");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getHelpText, parseLaunchOptions } = require("./pi-web-options");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getNextNodeArgs } = require("./pi-web-node-args");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { wireChildProcessLifecycle } = require("./process-lifecycle");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { rotatePreviewSecrets } = require("./rotate-preview-secrets");

const DEFAULT_PACKAGE_DIR = path.join(__dirname, "..");

function isPhysicalPreviewSelectorInstall({ port, packageDir, env, fsModule }) {
  if (port !== "30142") return true;
  const installRoot = path.resolve(
    env.PI_WEB_INSTALL_DIR?.trim() || path.join(homedir(), ".local", "share", "pi-web-reader"),
  );
  const selector = path.resolve(
    env.PI_WEB_30142_SELECTOR?.trim() || path.join(installRoot, "preview-30142"),
  );
  try {
    const target = fsModule.realpathSync(selector);
    const releases = fsModule.realpathSync(path.join(installRoot, "releases"));
    const relativeTarget = path.relative(releases, target);
    return fsModule.realpathSync(packageDir) === target
      && relativeTarget
      && !relativeTarget.startsWith("..")
      && !path.isAbsolute(relativeTarget);
  } catch {
    return false;
  }
}

function resolveNextBin(packageDir) {
  // Resolve next's CLI entry directly to avoid relying on .bin symlinks (which
  // may not exist when installed via npx).
  try {
    return require.resolve("next/dist/bin/next", { paths: [packageDir] });
  } catch {
    try {
      const nextPkg = require.resolve("next/package.json", { paths: [packageDir] });
      return path.join(path.dirname(nextPkg), "dist", "bin", "next");
    } catch {
      return path.join(packageDir, "node_modules", "next", "dist", "bin", "next");
    }
  }
}

function startPiWeb({
  args = process.argv.slice(2),
  env = process.env,
  spawnImpl = spawn,
  fsModule = fs,
  packageDir = DEFAULT_PACKAGE_DIR,
  wireLifecycle = wireChildProcessLifecycle,
  nextBin: providedNextBin,
  processImpl = process,
  rotateSecrets = rotatePreviewSecrets,
} = {}) {
  const launchOptions = parseLaunchOptions(args, env);
  if (launchOptions.help) return { help: true, started: false };

  const { port, hostname, openBrowser } = launchOptions;
  const nextDir = path.join(packageDir, ".next");

  if (!isPhysicalPreviewSelectorInstall({ port, packageDir, env, fsModule })) {
    return {
      help: false,
      started: false,
      error: "30142 requires the physical production install selected by preview-30142.",
    };
  }

  const nextBin = providedNextBin ?? resolveNextBin(packageDir);
  const loopbackHostnames = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  const passwordEnabled = Boolean(env.PI_WEB_PASSWORD);

  if (!fsModule.existsSync(nextDir)) {
    return {
      help: false,
      started: false,
      error: "Build artifacts not found. Please report this issue.",
    };
  }

  if (!loopbackHostnames.has(hostname)) {
    if (passwordEnabled) {
      console.warn(
        `Warning: pi-web is listening on ${hostname} with password authentication over HTTP. Use HTTPS or a trusted VPN to protect the password in transit.`,
      );
    } else {
      console.warn(
        `Warning: pi-web is listening on ${hostname} without authentication. Only use this on a trusted network.`,
      );
    }
  }

  try {
    rotateSecrets(path.join(nextDir, "prerender-manifest.json"), { fsModule });
  } catch {
    // Do not print the underlying error: it may contain a path from a malformed
    // fixture, while the manifest itself must never be echoed with its secrets.
    return {
      help: false,
      started: false,
      error: "Preview secret rotation failed; refusing to start.",
    };
  }

  const nextArgs = ["start", "-p", port];
  nextArgs.push("-H", hostname);

  // Always run next's JS entry with node directly — avoids .bin symlink issues
  // and path-with-spaces problems on Windows when shell: true is used.
  const childEnv = { ...env, PI_WEB_HOSTNAME: hostname, PI_WEB_BOUND_PORT: port };
  const child = spawnImpl(processImpl.execPath, getNextNodeArgs(nextBin, nextArgs), {
    cwd: packageDir,
    stdio: ["inherit", "pipe", "inherit"],
    env: childEnv,
  });
  wireLifecycle(child);

  let browserOpened = false;
  let browserHostname = hostname;
  if (hostname === "0.0.0.0") browserHostname = "127.0.0.1";
  else if (hostname === "::" || hostname === "[::]") browserHostname = "[::1]";
  else if (hostname.includes(":") && !hostname.startsWith("[")) browserHostname = `[${hostname}]`;
  const url = `http://${browserHostname}:${port}`;
  child.stdout?.on("data", (chunk) => {
    const text = chunk.toString();
    processImpl.stdout.write(text);
    if (openBrowser && !browserOpened && text.includes("Ready")) {
      browserOpened = true;
      const isWindows = processImpl.platform === "win32";
      const isMac = processImpl.platform === "darwin";
      // Avoid `shell: true` to suppress Node.js DEP0190 deprecation
      // ("Passing args to a child process with shell option true can lead to
      // security vulnerabilities").
      // Pass a structured argv so Node.js handles escaping instead of
      // concatenating the args into a shell command string.
      let opener;
      if (isWindows) {
        // `start` is a cmd.exe built-in, so invoke cmd directly. The empty
        // title argument is required by `start` before the target URL.
        opener = spawnImpl(processImpl.env.ComSpec || "cmd.exe", ["/c", "start", "", url], {
          stdio: "ignore",
          detached: true,
        });
      } else if (isMac) {
        opener = spawnImpl("open", [url], {
          stdio: "ignore",
          detached: true,
        });
      } else {
        opener = spawnImpl("xdg-open", [url], {
          stdio: "ignore",
          detached: true,
        });
      }

      opener.on("error", (error) => {
        console.warn(`Could not open browser automatically: ${error.message}`);
      });

      opener.unref();
    }
  });

  return { help: false, started: true, child };
}

function main() {
  let result;
  try {
    result = startPiWeb();
  } catch (error) {
    fs.writeSync(
      process.stderr.fd,
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (result.help) {
    fs.writeSync(process.stdout.fd, getHelpText());
    return;
  }
  if (!result.started) {
    console.error(result.error);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { isPhysicalPreviewSelectorInstall, startPiWeb };
