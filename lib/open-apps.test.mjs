import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { explicitlySupports, fileViewerCommandFor, listOpenApps, matchesDocumentExt, mutateOpenApps, openCommandFor, parseDefaultFileViewerBundleId, parseDocumentExtensions } from "./open-apps.ts";

// 平台相关路径用注入式平台测试成本高；这里只测平台无关的契约：
// default 分支命令构造 + 未知应用拒绝 + linux 映射命令。

test("openCommandFor: default app command per platform shape", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  try {
    Object.defineProperty(process, "platform", { value: "darwin" });
    assert.deepEqual(openCommandFor("/tmp/a.md"), ["open", "/tmp/a.md"]);
    Object.defineProperty(process, "platform", { value: "win32" });
    assert.deepEqual(openCommandFor("/tmp/a.md"), ["cmd", "/c", "start", "", "/tmp/a.md"]);
  } finally {
    if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
  }
});

test("fileViewerCommandFor: follows macOS default viewer, with Finder fallback", () => {
  assert.deepEqual(
    fileViewerCommandFor("/tmp/project", "com.jinghaoshe.qspace.pro", "darwin"),
    ["open", "-b", "com.jinghaoshe.qspace.pro", "/tmp/project"],
  );
  assert.deepEqual(fileViewerCommandFor("/tmp/project", null, "darwin"), ["open", "/tmp/project"]);
  assert.deepEqual(fileViewerCommandFor("/tmp/project", "com.example.viewer", "linux"), ["xdg-open", "/tmp/project"]);
});

test("parseDefaultFileViewerBundleId: accepts bundle IDs only", () => {
  assert.equal(parseDefaultFileViewerBundleId(" com.jinghaoshe.qspace.pro\n"), "com.jinghaoshe.qspace.pro");
  assert.equal(parseDefaultFileViewerBundleId(""), null);
  assert.equal(parseDefaultFileViewerBundleId("/Applications/QSpace Pro.app"), null);
});

test("openCommandFor: unknown app is rejected", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const originalDisplay = process.env.DISPLAY;
  try {
    Object.defineProperty(process, "platform", { value: "linux" });
    process.env.DISPLAY = ":0";
    assert.throws(() => openCommandFor("/tmp/a.md", "no-such-app"), /Unknown app/);
  } finally {
    if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
    if (originalDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = originalDisplay;
  }
});

test("openCommandFor: linux app from mapping file", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const originalDisplay = process.env.DISPLAY;
  const originalConfig = process.env.PI_WEB_OPEN_APPS_FILE;
  const configPath = "/tmp/open-apps-test-" + process.pid + ".json";
  try {
    Object.defineProperty(process, "platform", { value: "linux" });
    process.env.DISPLAY = ":0";
    // 无 linux 命令的映射 → 明确报错；带 %f 的映射 → 命令展开。
    writeFileSync(configPath, JSON.stringify({ apps: [{ id: "typora", label: "Typora" }] }));
    process.env.PI_WEB_OPEN_APPS_FILE = configPath;
    assert.throws(() => openCommandFor("/tmp/a.md", "typora"), /no linux command/);
    writeFileSync(configPath, JSON.stringify({ apps: [{ id: "typora", label: "Typora", linux: ["typora", "%f"] }] }));
    assert.deepEqual(openCommandFor("/tmp/a.md", "typora"), ["typora", "/tmp/a.md"]);
  } finally {
    if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
    if (originalDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = originalDisplay;
    if (originalConfig === undefined) delete process.env.PI_WEB_OPEN_APPS_FILE;
    else process.env.PI_WEB_OPEN_APPS_FILE = originalConfig;
    rmSync(configPath, { force: true });
  }
});

test("openCommandFor: headless linux rejects both default and mapped app", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const originalDisplay = process.env.DISPLAY;
  const originalWayland = process.env.WAYLAND_DISPLAY;
  try {
    Object.defineProperty(process, "platform", { value: "linux" });
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    assert.throws(() => openCommandFor("/tmp/a.md"), /headless/);
    assert.throws(() => openCommandFor("/tmp/a.md", "default"), /headless/);
  } finally {
    if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
    if (originalDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = originalDisplay;
    if (originalWayland === undefined) delete process.env.WAYLAND_DISPLAY;
    else process.env.WAYLAND_DISPLAY = originalWayland;
  }
});

test("parseDocumentExtensions extracts extensions and wildcard", () => {
  const exts = parseDocumentExtensions(JSON.stringify({
    CFBundleDocumentTypes: [
      { CFBundleTypeExtensions: ["md", ".markdown", "*"] },
      { CFBundleTypeExtensions: ["txt"] },
      {},
    ],
  }));
  assert.ok(exts.has("md"));
  assert.ok(exts.has("markdown")); // 去点
  assert.ok(exts.has("*"));
  assert.ok(exts.has("txt"));
});

test("explicitlySupports ignores wildcard (filter strictness)", () => {
  assert.equal(explicitlySupports(new Set(["*"]), "md"), false);
  assert.equal(explicitlySupports(new Set(["md"]), ".MD"), true);
  assert.equal(explicitlySupports(new Set(["md", "txt"]), "xls"), false);
});

test("matchesDocumentExt handles wildcard and normalization", () => {
  assert.equal(matchesDocumentExt(new Set(["md"]), "MD"), true);
  assert.equal(matchesDocumentExt(new Set(["md"]), ".md"), true);
  assert.equal(matchesDocumentExt(new Set(["md"]), "txt"), false);
  assert.equal(matchesDocumentExt(new Set(["*"]), "anything"), true);
});

test("listOpenApps with ext keeps mapping entries on linux (no type filter)", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const originalConfig = process.env.PI_WEB_OPEN_APPS_FILE;
  const configPath = "/tmp/open-apps-test-" + process.pid + "-ext.json";
  try {
    Object.defineProperty(process, "platform", { value: "linux" });
    writeFileSync(configPath, JSON.stringify({ apps: [{ id: "code", label: "VS Code", linux: ["code", "%f"] }] }));
    process.env.PI_WEB_OPEN_APPS_FILE = configPath;
    const apps = listOpenApps("md");
    assert.equal(apps.length, 1);
    assert.equal(apps[0].id, "code");
  } finally {
    if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
    if (originalConfig === undefined) delete process.env.PI_WEB_OPEN_APPS_FILE;
    else process.env.PI_WEB_OPEN_APPS_FILE = originalConfig;
    rmSync(configPath, { force: true });
  }
});

test("mutateOpenApps add/remove round-trip on injected config", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const originalConfig = process.env.PI_WEB_OPEN_APPS_FILE;
  const configPath = "/tmp/open-apps-test-" + process.pid + "-mutate.json";
  try {
    Object.defineProperty(process, "platform", { value: "darwin" });
    process.env.PI_WEB_OPEN_APPS_FILE = configPath;
    writeFileSync(configPath, JSON.stringify({ apps: [{ id: "Typora", label: "Typora", linux: ["typora", "%f"] }] }));
    mutateOpenApps("remove", "Typora"); // 显式条目 → 从 apps 删除
    assert.equal(listOpenApps().find((app) => app.id === "Typora"), undefined);
    mutateOpenApps("remove", "SomeApp"); // 枚举条目 → excludes
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")).excludes, ["SomeApp"]);
    assert.throws(() => mutateOpenApps("add", "SomeApp"), /Unknown app/); // 非枚举 app 拒绝
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(config.excludes, ["SomeApp"]);
  } finally {
    if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
    if (originalConfig === undefined) delete process.env.PI_WEB_OPEN_APPS_FILE;
    else process.env.PI_WEB_OPEN_APPS_FILE = originalConfig;
    rmSync(configPath, { force: true });
  }
});
