import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The verifier isolates HOME; use only the installed browser binary, never a user profile.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(userInfo().homedir,
  process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
const { chromium } = await import("playwright");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = await mkdtemp(join(process.env.HOME || tmpdir(), ".reader-git-peer-e2e-"));
const fixture = join(home, "fixture");
console.log(JSON.stringify({ resource: home, purpose: "isolated synthetic two-peer Git confirmation browser fixture", cleanup: "finally after browser/server exit" }));
let browser, server, serverExited, serverLog = "", releaseWrite;
try {
  await mkdir(join(fixture, "app"), { recursive: true });
  await symlink(join(root, "node_modules"), join(fixture, "node_modules"), "dir");
  await writeFile(join(fixture, "package.json"), JSON.stringify({ private: true }));
  await writeFile(join(fixture, "next.config.mjs"), `export default { experimental: { externalDir: true }, webpack(config) { config.resolve.alias['@'] = ${JSON.stringify(root)}; return config; } };\n`);
  await writeFile(join(fixture, "app/layout.tsx"), "export default function Layout({children}: {children: React.ReactNode}) { return <html><body>{children}</body></html>; }\n");
  await writeFile(join(fixture, "app/page.tsx"), `"use client";
import { useState } from "react";
import { FileExplorer } from ${JSON.stringify(join(root, "components/FileExplorer"))};
import { I18nProvider } from ${JSON.stringify(join(root, "hooks/useI18n"))};
export default function Page() {
  const [peer, setPeer] = useState("owner-a");
  return <I18nProvider><button data-peer="owner-a" onClick={() => setPeer("owner-a")}>A</button><button data-peer="owner-b" onClick={() => setPeer("owner-b")}>B</button><output data-testid="peer">{peer}</output><FileExplorer cwd="/same-repository" remotePeer={peer} onOpenFile={() => {}} changesCollapsed={false} /></I18nProvider>;
}\n`);
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "dev", "--webpack", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: fixture,
    env: { PATH: process.env.PATH, HOME: home, PI_OFFLINE: "1", NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverExited = once(server, "exit");
  console.log(JSON.stringify({ ownedServerPid: server.pid, cwd: fixture, port }));
  for (const stream of [server.stdout, server.stderr]) stream.on("data", chunk => { serverLog = (serverLog + chunk).slice(-12000); });
  const deadline = Date.now() + 90000;
  while (!(await fetch(base, { signal: AbortSignal.timeout(10000) }).catch(() => null))?.ok) {
    if (server.exitCode !== null || Date.now() > deadline) throw new Error(`Fixture server unavailable: ${serverLog}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: "en-US", viewport: { width: 1200, height: 900 } });
  const page = await context.newPage(); page.setDefaultTimeout(30000);
  const writes = [], failures = [];
  let holdWrite = false, failNextWrite = false, writeStarted;
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    const peer = url.searchParams.get("peer");
    if (url.pathname.endsWith("/git/status")) {
      return route.fulfill({ json: { isGitRepository: true, repositoryRoot: "/same-repository", branch: `branch-${peer}`, upstream: "origin/main", ahead: 1, behind: 0,
        files: [{ filePath: "/same-repository/shared.txt", status: "modified", code: "M", indexStatus: " ", worktreeStatus: "M" }], additions: 1, deletions: 1 } });
    }
    if (url.pathname.endsWith("/git/write") && request.method() === "POST") {
      writes.push({ peer, body: request.postDataJSON() });
      const fail = failNextWrite;
      failNextWrite = false;
      if (holdWrite) {
        holdWrite = false;
        await new Promise(resolve => { releaseWrite = resolve; writeStarted?.(); });
      }
      return route.fulfill(fail ? { status: 500, json: { error: "synthetic failure" } } : { json: { ok: true } });
    }
    if (url.pathname.includes("/files/")) return route.fulfill({ json: { entries: [] } });
    return route.fulfill({ json: {} });
  });
  const ready = async peer => {
    await page.locator(`[aria-label="Branch: branch-${peer}"]`).waitFor();
    await page.locator('button[title="Stage listed changes"]').first().waitFor();
  };
  const switchPeer = async peer => {
    await page.locator(`[data-peer="${peer}"]`).evaluate(element => element.click());
    await page.waitForFunction(expected => document.querySelector('[data-testid="peer"]')?.textContent === expected, peer);
    await ready(peer);
  };
  const beginStage = async () => {
    await page.locator('button[title="Stage listed changes"]').first().click();
    await page.getByRole("dialog").waitFor();
  };
  const confirm = () => page.getByRole("dialog").getByRole("button", { name: "Confirm and run" }).click();
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await ready("owner-a");
  await beginStage();
  await switchPeer("owner-b");
  if (await page.getByRole("dialog").count()) await confirm();
  if (writes.length) failures.push(`old owner-a confirmation wrote to ${writes[0].peer}`);
  assert.deepEqual(failures, []);

  for (const { fail, returnToA } of [{ fail: false, returnToA: false }, { fail: true, returnToA: false }, { fail: true, returnToA: true }]) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await ready("owner-a");
    await beginStage();
    holdWrite = true;
    failNextWrite = fail;
    const started = new Promise(resolve => { writeStarted = resolve; });
    await confirm();
    await started;
    assert.equal(writes.at(-1).peer, "owner-a");
    assert.equal(writes.at(-1).body.cwd, "/same-repository");
    assert.deepEqual(writes.at(-1).body.paths, ["shared.txt"]);
    await switchPeer("owner-b");
    if (returnToA) await switchPeer("owner-a");
    await beginStage();
    const settled = page.waitForResponse(response => response.url().includes("/git/write") && response.request().method() === "POST");
    releaseWrite(); releaseWrite = undefined;
    await settled;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const nextPeer = returnToA ? "owner-a" : "owner-b";
    if (!(await page.getByRole("dialog").count())) failures.push(`late ${fail ? "failure" : "success"} closed ${nextPeer} confirmation`);
    else if (!(await page.getByRole("dialog").getByRole("button", { name: "Confirm and run" }).isEnabled())) failures.push(`late result left ${nextPeer} confirmation busy`);
    assert.deepEqual(failures, []);
    await confirm();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    assert.equal(writes.at(-1).peer, nextPeer);
  }
  console.log(JSON.stringify({ writes, result: "peer confirmation and late success/failure isolated, including A→B→A" }));
  await context.close();
} finally {
  releaseWrite?.();
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    const timeout = setTimeout(() => server.kill("SIGKILL"), 10000); timeout.unref();
    try { await serverExited; } finally { clearTimeout(timeout); }
  }
  await rm(home, { recursive: true });
  console.log(JSON.stringify({ cleanedFixtureHome: home, serverExited: !server || server.exitCode !== null || server.signalCode !== null }));
}
