import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { tmpdir } from "node:os";

const source = fs.readFileSync(new URL("./skill-analysis-jobs.ts", import.meta.url), "utf8");
const code = stripTypeScriptTypes(source).replace(/^import[\s\S]*?;\n/gm, "").replace(/^export /gm, "");
function fixture(t, analyzeRequestedSkill) {
  const agentDir = fs.mkdtempSync(path.join(tmpdir(), "reader-analysis-job-"));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  const context = { ...fs, ...path, ...crypto, process, Error, analyzeRequestedSkill, getAgentDir: () => agentDir, validateSkillAnalysisTargets: async (_cwd, _scope, targets) => targets };
  const api = vm.runInNewContext(`${code}\n({ readJob, writeJob, runWorker, startSkillAnalysisJob, getSkillAnalysisJob })`, context);
  const initial = { id: "job-a", cwd: "/repo", scope: "project", targets: ["/skills/alpha/SKILL.md", "/skills/beta/SKILL.md", "/skills/gamma/SKILL.md"], total: 3, completed: 0, failed: 0, nextIndex: 0, status: "running", startedAt: "start", updatedAt: "start" };
  api.writeJob(agentDir, initial);
  return { ...api, agentDir, initial, read: () => api.readJob(agentDir, initial.cwd, initial.scope) };
}

test("persists partial success, named model failures and thrown failures in the original job", async (t) => {
  const calls = [];
  const f = fixture(t, async (cwd, scope, filePath) => {
    calls.push({ cwd, scope, filePath });
    if (filePath.includes("gamma")) throw new Error("permission denied");
    if (filePath.includes("beta")) return { triggerModes: { failed: 1, failures: [{ filePath, name: "Beta skill", reason: "model offline" }] } };
    return { triggerModes: { failed: 0 } };
  });
  await f.runWorker(f.initial, f.agentDir);
  const restored = f.read();
  assert.equal(restored.status, "completed");
  assert.equal(restored.completed, 3);
  assert.equal(restored.failed, 2);
  assert.equal(restored.nextIndex, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(restored.failures)), [
    { filePath: f.initial.targets[1], name: "Beta skill", reason: "model offline" },
    { filePath: f.initial.targets[2], name: "gamma", reason: "permission denied" },
  ]);
  assert.equal(restored.error, undefined, "partial failure must not hide the completed count behind a batch error");
  assert.deepEqual(calls.map((call) => call.filePath), f.initial.targets);
  assert.ok(calls.every((call) => call.cwd === "/repo" && call.scope === "project"));
});

test("resumes at the saved index and retains earlier failure details", async (t) => {
  const seen = [];
  const f = fixture(t, async (_cwd, _scope, filePath) => { seen.push(filePath); return { triggerModes: { failed: 0 } }; });
  const failure = { filePath: f.initial.targets[0], name: "Alpha", reason: "timeout" };
  const saved = { ...f.initial, nextIndex: 1, completed: 1, failed: 1, failures: [failure] };
  f.writeJob(f.agentDir, saved);
  await f.runWorker(f.read(), f.agentDir);
  assert.deepEqual(seen, f.initial.targets.slice(1));
  assert.equal(f.read().completed, 3);
  assert.equal(f.read().failed, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(f.read().failures)), [failure]);
});

test("an in-flight old worker cannot overwrite a replacement job", async (t) => {
  let release;
  const f = fixture(t, () => new Promise((resolve) => { release = resolve; }));
  const pending = f.runWorker(f.initial, f.agentDir);
  const replacement = { ...f.initial, id: "job-b" };
  f.writeJob(f.agentDir, replacement);
  release({ triggerModes: { failed: 0 } });
  await pending;
  assert.deepEqual(JSON.parse(JSON.stringify(f.read())), replacement);
});

test("reads legacy jobs without fabricated details and rejects details outside the target list", (t) => {
  const f = fixture(t, async () => ({}));
  assert.equal(f.read().failures, undefined);
  f.writeJob(f.agentDir, { ...f.initial, failures: [{ filePath: "/other/SKILL.md", name: "other", reason: "unknown" }] });
  assert.equal(f.read(), null);
});

test("explicit skill analysis uses the complete analysis helper in the original scope", async () => {
  const service = fs.readFileSync(new URL("./skill-analysis-service.ts", import.meta.url), "utf8");
  const analyze = stripTypeScriptTypes(service.slice(service.indexOf("export async function analyzeRequestedSkill"))).replace(/^export /, "");
  const calls = [];
  const skill = { filePath: "/skills/beta/SKILL.md", name: "Beta" };
  const context = {
    loadRequestedSkill: async (...args) => { calls.push(["load", ...args]); return { cwd: "/repo", agentDir: "/agent", skill }; },
    refreshUpdatedSkillTriggerMetadata: async (...args) => { calls.push(["complete", ...args]); return { analyzed: 1, failed: 0, skipped: 0 }; },
    loadSkillsWithInstallInfo: async (...args) => { calls.push(["reload", ...args]); return { skills: [skill] }; },
  };
  const fn = vm.runInNewContext(`${analyze}\nanalyzeRequestedSkill`, context);
  const result = await fn("/repo", "project", skill.filePath);
  assert.equal(result.skill, skill);
  assert.deepEqual(calls[0], ["load", "/repo", "project", skill.filePath]);
  assert.equal(calls[1][0], "complete");
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1].slice(1))), [[skill], { cwd: "/repo", agentDir: "/agent" }]);
  assert.deepEqual(calls[2], ["reload", "/repo", "project"]);
});


test("a new explicit request for the same targets after a completed job actually analyzes again", async (t) => {
  let calls = 0;
  const f = fixture(t, async () => { calls += 1; return { triggerModes: { failed: 0 } }; });
  f.writeJob(f.agentDir, { ...f.initial, status: "completed", completed: 3, nextIndex: 3 });
  const next = await f.startSkillAnalysisJob(f.initial.cwd, f.initial.scope, f.initial.targets);
  assert.notEqual(next.id, f.initial.id);
  assert.equal(next.status, "running");
  for (let attempt = 0; attempt < 20 && f.read().status === "running"; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.read().status, "completed");
  assert.equal(calls, 3);
});

test("complete refresh reports unsaved results as failed without changing interactive degradation", async () => {
  const producer = fs.readFileSync(new URL("./skill-trigger-analysis.ts", import.meta.url), "utf8");
  const refresh = stripTypeScriptTypes(producer.slice(producer.indexOf("export async function refreshSkillTriggerMetadata"), producer.indexOf("export function skillTriggerMetadataPath"))).replace(/^export /gm, "");
  const context = {
    metadataIsCurrent: () => false, MANUAL_DECLARATION_REASON: "技能声明仅手动调用", SkillTriggerMetadata: {}, getAgentDir: () => "/agent", skillTriggerMetadataKey: (skill) => skill.filePath,
    readSkillContent: () => ({ content: "manual", contentHash: "new" }), isProjectSkill: () => false,
    readStore: () => ({ skills: {} }), declaresManualInvocation: () => true,
    metadataFor: (...args) => args, mergeStore: () => false,
    STORE_LOCK_TIMEOUT_MS: 1, MAX_REASON_CHARS: 240, REFRESH_BUDGET_MS: 8000,
    console: { warn() {} }, Date, Map,
  };
  const api = vm.runInNewContext(`${refresh}\n({ refreshSkillTriggerMetadata, refreshUpdatedSkillTriggerMetadata })`, context);
  const skill = { filePath: "/skills/alpha/SKILL.md", name: "alpha" };
  const complete = await api.refreshUpdatedSkillTriggerMetadata([skill], { cwd: "/repo" });
  assert.equal(complete.analyzed, 0);
  assert.equal(complete.failed, 1);
  assert.match(complete.failures[0].reason, /could not be saved/);
  const interactive = await api.refreshSkillTriggerMetadata([skill], { cwd: "/repo" });
  assert.equal(interactive.analyzed, 1);
  assert.equal(interactive.failed, 0);
});
