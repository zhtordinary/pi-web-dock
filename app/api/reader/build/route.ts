import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { APP_PACKAGE_NAME } from "@/lib/app-update";
import { getReaderRuntimeChannel, type ReaderRuntimeChannel } from "@/lib/reader-runtime-build";
import { join, relative, resolve } from "node:path";

type ReaderBuildIdentity = {
  channel: ReaderRuntimeChannel;
  schema: 5;
  artifact: string;
  artifactBytes: string;
  version: string;
  readerCommit: string;
  buildId: string;
  artifactSha256: string;
  lockfileSha256: string;
  installationPath: string;
};

function installRoot(): string {
  return resolve(process.env.PI_WEB_INSTALL_DIR?.trim() || join(homedir(), ".local", "share", "pi-web-reader"));
}

function selectorPath(channel: ReaderRuntimeChannel): string {
  return channel === "preview"
    ? resolve(process.env.PI_WEB_30142_SELECTOR?.trim() || join(installRoot(), "preview-30142"))
    : join(installRoot(), "current");
}

async function assertRegularFile(path: string, maxBytes: number): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error("Reader identity file is not a bounded regular file");
}

async function assertPhysicalDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Reader identity root is not a physical directory");
}

function isHex(value: unknown, length: number): value is string {
  return typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`, "i").test(value);
}

function isBuildId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

/** Read the physical installation selected for this listener's own channel. */
async function readReaderBuildIdentity(channel: ReaderRuntimeChannel): Promise<ReaderBuildIdentity> {
  const root = await realpath(installRoot());
  const selector = selectorPath(channel);
  const target = await realpath(selector);
  const releasesRoot = await realpath(join(root, "releases"));
  await assertPhysicalDirectory(releasesRoot);
  const targetRelative = relative(releasesRoot, target);
  if (!targetRelative || targetRelative.startsWith("..") || targetRelative.startsWith("/") || targetRelative.includes("\0")) {
    throw new Error("Reader selector is outside the production releases root");
  }
  await assertPhysicalDirectory(target);
  if (await realpath(process.cwd()) !== target) throw new Error("Reader process cwd does not match its channel selector");

  const metadataPath = join(target, ".pi-web-reader-release.json");
  const buildPath = join(target, ".next", "BUILD_ID");
  await assertRegularFile(metadataPath, 64 * 1024);
  await assertRegularFile(buildPath, 256);
  await assertPhysicalDirectory(join(target, ".next"));
  await assertPhysicalDirectory(join(target, "node_modules"));
  await assertRegularFile(join(target, "package.json"), 256 * 1024);
  await assertRegularFile(join(target, "bin", "pi-web.js"), 256 * 1024);

  const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
  const packageJson = JSON.parse(await readFile(join(target, "package.json"), "utf8")) as Record<string, unknown>;
  const diskBuild = (await readFile(buildPath, "utf8")).trim();
  if (
    metadata.schema !== 5
    || typeof metadata.artifact !== "string" || !metadata.artifact.endsWith(".tgz")
    || typeof metadata.artifactBytes !== "string" || !/^[1-9][0-9]*$/.test(metadata.artifactBytes)
    || typeof metadata.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(metadata.version)
    || packageJson.name !== APP_PACKAGE_NAME || packageJson.version !== metadata.version
    || metadata.managedBy !== "pi-web-reader-release"
    || metadata.installationMode !== "production"
    || metadata.installationPath !== target
    || (metadata.health !== "healthy" && metadata.health !== "pending")
    || (metadata.sourceDirty !== undefined && metadata.sourceDirty !== false)
    || !isHex(metadata.artifactSha256, 64)
    || !isHex(metadata.lockfileSha256, 64)
    || !isHex(metadata.readerCommit, 40)
    || !isBuildId(metadata.buildId)
    || metadata.buildId !== diskBuild
  ) {
    throw new Error("Reader production installation identity mismatch");
  }
  return {
    channel,
    schema: 5,
    artifact: metadata.artifact,
    artifactBytes: metadata.artifactBytes,
    version: metadata.version,
    readerCommit: metadata.readerCommit,
    buildId: diskBuild,
    artifactSha256: metadata.artifactSha256,
    lockfileSha256: metadata.lockfileSha256,
    installationPath: target,
  };
}

/** An ordinary install, without the maintainer's managed release root, has no build identity to report. */
async function hasManagedInstallRoot(): Promise<boolean> {
  return stat(installRoot()).then((value) => value.isDirectory(), () => false);
}

export async function GET(): Promise<Response> {
  const channel = getReaderRuntimeChannel();
  if (!channel || !await hasManagedInstallRoot()) {
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }
  try {
    return Response.json(await readReaderBuildIdentity(channel), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Reader production installation unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
