import type { NextConfig } from "next";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const configDir = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(join(configDir, "package.json"), "utf8")) as { version: string };
let piVersion = "unknown";
try {
  const piPkgPath = join(configDir, "node_modules/@earendil-works/pi-coding-agent/package.json");
  piVersion = (JSON.parse(readFileSync(piPkgPath, "utf8")) as { version: string }).version;
} catch { /* package not found, use default */ }
let readerCommit = "";
const configuredReaderCommit = process.env.NEXT_PUBLIC_READER_COMMIT?.trim();
if (configuredReaderCommit && /^[0-9a-f]{40}$/i.test(configuredReaderCommit)) readerCommit = configuredReaderCommit;
// The preview's Git transport has its own snapshot SHA; display the task HEAD
// from the same local identity that the preview CLI checks, never in production.
if (process.env.NODE_ENV === "development") try {
  const preview = JSON.parse(readFileSync(join(configDir, ".preview/state.json"), "utf8")) as { identity?: { head?: unknown } };
  if (typeof preview.identity?.head === "string" && /^[0-9a-f]{40}$/i.test(preview.identity.head)) {
    readerCommit = preview.identity.head;
  }
} catch { /* ordinary source worktrees still use their exact Git HEAD below */ }
if (!readerCommit) try {
  const release = JSON.parse(readFileSync(join(configDir, ".pi-web-reader-release.json"), "utf8")) as { readerCommit?: unknown };
  if (typeof release.readerCommit === "string" && /^[0-9a-f]{40}$/i.test(release.readerCommit)) {
    readerCommit = release.readerCommit;
  }
 } catch { /* source trees without a production-install receipt fall back to exact Git HEAD below */ }
if (!readerCommit) {
  try {
    const gitHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: configDir, encoding: "utf8" }).trim();
    if (/^[0-9a-f]{40}$/i.test(gitHead)) readerCommit = gitHead;
  } catch { /* non-Git production installs require the release metadata file */ }
}

// Use the same explicit host allowlist for Next's dev/HMR origin check.
// Production keeps its existing configuration and request-security checks.
const devHosts = process.env.NODE_ENV === "development"
  ? (process.env.PI_WEB_ALLOWED_HOSTS ?? "").split(",").map((host) => host.trim())
    .filter((host) => /^[A-Za-z0-9.-]+$/.test(host))
  : [];

// One immutable value is compiled into server and browser bundles for this build.
const readerBuildId = process.env.PI_WEB_READER_BUILD_ID?.trim() || "development";
const nextConfig: NextConfig = {
  generateBuildId: async () => {
    if (readerBuildId === "development") throw new Error("Build identity missing: use npm run build");
    return readerBuildId;
  },
  devIndicators: false,
  outputFileTracingRoot: configDir,
  experimental: {
    // proxy.ts matches /api/:path*, and Next buffers the request body whenever
    // a proxy is present, capped at 10 MB by default. The upload route accepts
    // up to 100 MB per request, so raise the buffer above that or large uploads
    // are truncated and fail with "Failed to parse body as FormData."
    proxyClientMaxBodySize: "128mb",
  },
  // next/image is only used for the static logo, so the /_next/image optimizer
  // (and its sharp/libheif attack surface, see GHSA-2xp9-vwfh-vxw4) is not needed.
  images: { unoptimized: true },
  // The bundled local Pi extension follows Node ESM's .js-on-output convention,
  // while its source is TypeScript. Let webpack resolve those specifiers to source files.
  webpack(config) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
  serverExternalPackages: [
    "jiti",
    "node-pty",
    "undici",
    "web-push",
    // Keep ws optional native fallbacks out of Webpack's empty-module aliases.
    "ws",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-tui",
  ],
  // Allow loopback, RFC1918 LAN ranges, Tailscale CGNAT (100.64/10), and mDNS hosts
  allowedDevOrigins: [
    "localhost",
    "127.0.0.1",
    "10.*.*.*",
    "100.*.*.*",
    "172.16.*.*",
    "172.17.*.*",
    "172.18.*.*",
    "172.19.*.*",
    "172.20.*.*",
    "172.21.*.*",
    "172.22.*.*",
    "172.23.*.*",
    "172.24.*.*",
    "172.25.*.*",
    "172.26.*.*",
    "172.27.*.*",
    "172.28.*.*",
    "172.29.*.*",
    "172.30.*.*",
    "172.31.*.*",
    "192.168.*.*",
    "*.local",
    ...devHosts,
  ],
  async headers() {
    return [
      {
        source: "/",
        headers: [
          { key: "Cache-Control", value: "private, no-cache, max-age=0, must-revalidate" },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/manifest.webmanifest",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
        ],
      },
    ];
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_PI_VERSION: piVersion,
    NEXT_PUBLIC_READER_COMMIT: readerCommit,
    NEXT_PUBLIC_READER_BUILD_ID: readerBuildId,
  },
};

export default nextConfig;
