import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// 打开文件时可选的本地应用清单 + 打开命令构造。
// darwin：自动枚举 /Applications + ~/Applications，读各 app Info.plist 的
// CFBundleDocumentTypes 得到支持的扩展名（open-apps?ext=md 只列能打开 md 的）；
// 图标经 sips 转 32px PNG（磁盘缓存 /tmp/pi-web-open-icons/）。
// 映射文件 ~/.config/pi-web-reader/open-apps.json（env PI_WEB_OPEN_APPS_FILE 可覆盖）
// 可补充 linux 命令（headless 设备也能用 CLI 应用打开）或覆盖 darwin 条目，
// 映射条目不受扩展名过滤（无类型概念，总是展示）：
//   { "apps": [ { "id": "code", "label": "VS Code", "linux": ["code", "%f"] } ] }
// 清单每次请求实时枚举（装/卸/新装立即反映，无需同步）；缓存仅防高频重复扫描。

export interface OpenApp {
  id: string;
  label: string;
  linux?: string[];
}

const OPEN_APPS_CONFIG_FILE = process.env.PI_WEB_OPEN_APPS_FILE
  ?? path.join(process.env.HOME ?? ".", ".config", "pi-web-reader", "open-apps.json");
const ICON_CACHE_DIR = "/tmp/pi-web-open-icons";
const ENUM_CACHE_TTL_MS = 60_000;
// macOS 应用目录：用户级 + 系统级（TextEdit/Calculator 等在 /System/Applications）。
const APP_DIRS = ["/Applications", "/System/Applications", path.join(homedir(), "Applications")];

function openAppsConfigPath(): string {
  return process.env.PI_WEB_OPEN_APPS_FILE ?? OPEN_APPS_CONFIG_FILE;
}

function readOpenAppsConfig(): { apps?: Array<{ id?: unknown; label?: unknown; linux?: unknown }>; excludes?: unknown } {
  try {
    const configPath = openAppsConfigPath();
    if (!existsSync(configPath)) return {};
    return JSON.parse(readFileSync(configPath, "utf8")) as { apps?: Array<{ id?: unknown; label?: unknown; linux?: unknown }>; excludes?: unknown };
  } catch {
    return {};
  }
}

function writeOpenAppsConfig(config: { apps?: Array<{ id: string; label: string; linux?: string[] }>; excludes?: string[] }): void {
  const configPath = openAppsConfigPath();
  mkdirSync(path.dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, configPath);
}

/**
 * 增删显示清单：add = 显式加入 apps（不受类型过滤/枚举影响）；
 * remove = 枚举结果排除（excludes）或从显式 apps 删除。
 * add 的 appId 必须来自当前枚举全集（linux 无枚举源 → 无法添加）。
 */
export function mutateOpenApps(action: "add" | "remove", appId: string): void {
  if (!appId) throw new Error("appId is required");
  const config = readOpenAppsConfig();
  const apps = (config.apps ?? []).map((entry) => ({
    id: String(entry?.id ?? ""),
    label: String(entry?.label ?? ""),
    linux: Array.isArray(entry?.linux) ? entry.linux.map(String) : undefined,
  })).filter((entry) => entry.id && entry.label);
  const excludes = new Set(Array.isArray(config.excludes) ? config.excludes.map(String) : []);

  if (action === "add") {
    // add 目标必须存在于枚举全集（linux 无枚举源 → 无法添加）。
    if (process.platform !== "darwin") {
      throw new Error("adding apps is only supported on macOS");
    }
    const known = listOpenApps().find((app) => app.id === appId);
    if (!known) throw new Error(`Unknown app: ${appId}`);
    if (!apps.some((entry) => entry.id === appId)) {
      apps.push({ id: known.id, label: known.label, linux: undefined });
    }
    excludes.delete(appId);
  } else {
    const explicitIndex = apps.findIndex((entry) => entry.id === appId);
    if (explicitIndex >= 0) {
      apps.splice(explicitIndex, 1);
    } else if (!excludes.has(appId)) {
      excludes.add(appId);
    }
  }

  writeOpenAppsConfig({ apps, excludes: [...excludes].sort() });
  enumCache.clear(); // 立即反映，不等 60s TTL
}

/** plutil 输出 JSON → 支持的扩展名集合（含 "*" 通配）。纯函数，可测。 */
export function parseDocumentExtensions(plistJson: string): Set<string> {
  const exts = new Set<string>();
  try {
    const info = JSON.parse(plistJson) as { CFBundleDocumentTypes?: Array<{ CFBundleTypeExtensions?: unknown }> };
    for (const doc of Array.isArray(info.CFBundleDocumentTypes) ? info.CFBundleDocumentTypes : []) {
      const list = doc?.CFBundleTypeExtensions;
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        if (typeof entry !== "string") continue;
        exts.add(entry.toLowerCase().replace(/^\./, ""));
      }
    }
  } catch { /* 坏 plist 视作无类型声明 */ }
  return exts;
}

/** 扩展名匹配（"*" 通配 = 支持一切）。纯函数，可测。 */
export function matchesDocumentExt(supported: ReadonlySet<string>, ext: string): boolean {
  const normalized = ext.toLowerCase().replace(/^\./, "");
  return supported.has("*") || supported.has(normalized);
}

/** 过滤用：只认显式声明的扩展名（"*" 通配不算——多媒体等 app 常声明通配，列入会让列表充满无关项）。 */
export function explicitlySupports(supported: ReadonlySet<string>, ext: string): boolean {
  const normalized = ext.toLowerCase().replace(/^\./, "");
  return supported.has(normalized);
}

function readAppDocumentExtensions(appPath: string): Set<string> {
  const plistPath = path.join(appPath, "Contents", "Info.plist");
  if (!existsSync(plistPath)) return new Set();
  const out = spawnSync("plutil", ["-convert", "json", "-o", "-", plistPath], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (out.status !== 0) return new Set();
  return parseDocumentExtensions(out.stdout);
}

function findAppPath(appId: string): string | null {
  for (const dir of APP_DIRS) {
    const candidate = path.join(dir, `${appId}.app`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// 枚举 + plist 解析结果缓存（TTL 60s：装/卸/新装最多 1 分钟反映，防高频扫描）。
const enumCache = new Map<string, { ts: number; apps: OpenApp[] }>();

export function listOpenApps(ext?: string): OpenApp[] {
  const configPath = openAppsConfigPath();
  const now = Date.now();
  // 缓存仅 darwin（枚举 + 逐 app 读 plist 贵）；linux 映射文件小，每次实时读。
  let apps: OpenApp[] | null = null;
  if (process.platform === "darwin") {
    const cached = enumCache.get(configPath);
    if (cached && now - cached.ts < ENUM_CACHE_TTL_MS) apps = cached.apps;
  }
  if (!apps) {
    const byId = new Map<string, OpenApp>();
    if (process.platform === "darwin") {
      for (const dir of APP_DIRS) {
        let entries: string[];
        try {
          entries = readdirSync(dir);
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!entry.endsWith(".app")) continue;
          const id = entry.slice(0, -".app".length);
          if (!byId.has(id)) byId.set(id, { id, label: id });
        }
      }
    }
    // 映射文件补充（linux 必需）或覆盖（darwin 同名 id 覆盖枚举 label/linux）。
    for (const entry of readOpenAppsConfig().apps ?? []) {
      if (typeof entry?.id !== "string" || !entry.id || typeof entry.label !== "string" || !entry.label) continue;
      byId.set(entry.id, {
        id: entry.id,
        label: entry.label,
        linux: Array.isArray(entry.linux) ? entry.linux.map(String) : undefined,
      });
    }
    // excludes（「减去应用」）：从清单删除。
    const configExcludes = readOpenAppsConfig().excludes;
    if (Array.isArray(configExcludes)) {
      for (const id of configExcludes) byId.delete(String(id));
    }
    apps = [...byId.values()].sort((a, b) => a.label.localeCompare(b.label));
    if (process.platform === "darwin") enumCache.set(configPath, { ts: now, apps });
  }

  if (ext && process.platform === "darwin") {
    // 映射条目总是展示（无类型概念）；darwin 枚举条目按文档类型过滤。
    const mappedIds = new Set(readOpenAppsConfig().apps?.map((entry) => String(entry?.id)) ?? []);
    return apps.filter((app) => {
      if (mappedIds.has(app.id)) return true;
      const appPath = findAppPath(app.id);
      if (!appPath) return true;
      return explicitlySupports(readAppDocumentExtensions(appPath), ext);
    });
  }
  return apps;
}

function assertHeadlessNotDesktop(): void {
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error("headless device: no desktop environment to open files in");
  }
}

const BUNDLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

/** Read macOS global file-viewer preference without invoking a shell. */
export function parseDefaultFileViewerBundleId(value: string): string | null {
  const bundleId = value.trim();
  return BUNDLE_ID_RE.test(bundleId) ? bundleId : null;
}

export function getDefaultFileViewerBundleId(): string | null {
  if (process.platform !== "darwin") return null;
  try {
    const result = spawnSync("defaults", ["read", "-g", "NSFileViewer"], {
      encoding: "utf8",
      timeout: 2_000,
    });
    if (result.error || result.status !== 0) return null;
    return parseDefaultFileViewerBundleId(typeof result.stdout === "string" ? result.stdout : "");
  } catch {
    return null;
  }
}

export function fileViewerCommandFor(
  target: string,
  defaultBundleId: string | null,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === "darwin") {
    const bundleId = defaultBundleId ? parseDefaultFileViewerBundleId(defaultBundleId) : null;
    return bundleId ? ["open", "-b", bundleId, target] : ["open", target];
  }
  if (platform === "win32") return ["explorer.exe", target];
  return ["xdg-open", target];
}

/**
 * 构造打开命令的 spawn 参数。appId 省略或 "default" = 系统默认应用；
 * 否则必须在 listOpenApps() 清单中（防任意命令注入）。
 */
export function openCommandFor(target: string, appId?: string): string[] {
  if (!appId || appId === "default") {
    assertHeadlessNotDesktop();
    if (process.platform === "darwin") return ["open", target];
    if (process.platform === "win32") return ["cmd", "/c", "start", "", target];
    return ["xdg-open", target];
  }
  const app = listOpenApps().find((candidate) => candidate.id === appId);
  if (!app) throw new Error(`Unknown app: ${appId}`);
  if (process.platform === "darwin") {
    return ["open", "-a", app.label, target];
  }
  if (process.platform === "win32") {
    return ["cmd", "/c", "start", "", app.label, target];
  }
  if (!app.linux?.length) {
    throw new Error(`App "${app.label}" has no linux command configured (add open-apps.json mapping)`);
  }
  assertHeadlessNotDesktop();
  return app.linux.map((part) => (part === "%f" ? target : part));
}

/** 应用图标 → 32px PNG Buffer（sips 转换，磁盘缓存）。非 darwin / 无图标返回 null。 */
export function getAppIconPng(appId: string): Buffer | null {
  if (process.platform !== "darwin") return null;
  const appPath = findAppPath(appId);
  if (!appPath) return null;
  try {
    mkdirSync(ICON_CACHE_DIR, { recursive: true });
    const cacheFile = path.join(ICON_CACHE_DIR, `${appId}.png`);
    if (existsSync(cacheFile)) return readFileSync(cacheFile);
    const resources = path.join(appPath, "Contents", "Resources");
    let iconSource: string | null = null;
    try {
      const iconCandidates = readdirSync(resources);
      const appIcon = iconCandidates.find((entry) => entry === "AppIcon.icns");
      const icns = iconCandidates.find((entry) => entry.endsWith(".icns"));
      const iconPng = iconCandidates.find((entry) => /^icon.*\.png$/i.test(entry));
      iconSource = appIcon ?? icns ?? iconPng ?? null;
      if (iconSource) iconSource = path.join(resources, iconSource);
    } catch { /* Resources 不可读 → 无图标 */ }
    if (!iconSource) return null;
    const out = spawnSync("sips", ["-s", "format", "png", "-z", "32", "32", iconSource, "--out", cacheFile], {
      timeout: 10_000,
    });
    if (out.status !== 0) return null;
    return readFileSync(cacheFile);
  } catch {
    return null;
  }
}
