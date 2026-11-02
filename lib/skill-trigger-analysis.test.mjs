import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  SKILL_TRIGGER_ANALYSIS_PROMPT_VERSION,
  SKILL_TRIGGER_ANALYSIS_SYSTEM_PROMPT,
  annotateSkillsWithTriggerMetadata,
  declaresManualInvocation,
  getSkillTriggerMetadata,
  parseAiResult,
  refreshSkillTriggerMetadata,
  refreshUpdatedSkillTriggerMetadata,
  skillTriggerMetadataKey,
  skillTriggerMetadataPath,
} = await jiti.import("./skill-trigger-analysis.ts");

function writeSkill(root, dir, name, extra = "") {
  const filePath = join(root, dir, "SKILL.md");
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(filePath, `---\nname: ${name}\ndescription: ${name}\n${extra}---\n`);
  return { filePath, name };
}

function skillInfo(filePath, name, overrides = {}) {
  return {
    name,
    description: name,
    filePath,
    baseDir: join(filePath, ".."),
    disableModelInvocation: false,
    sourceInfo: {},
    resourceEnabled: true,
    ...overrides,
  };
}

function fakeRuntime(responses) {
  let index = 0;
  return {
    calls: [],
    async completeSimple(_model, context) {
      this.calls.push(context.messages[0].content);
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (next instanceof Error) throw next;
      return { stopReason: "end", content: [{ type: "text", text: next }] };
    },
  };
}

test("keeps global cache path under agentDir for transparent deployment links", () => {
  const agentDir = "/tmp/pi-agent";
  assert.equal(skillTriggerMetadataPath(agentDir), join(agentDir, "skill-trigger-modes.json"));
});

test("keeps atomic analysis writes on the real target of a shared metadata symlink", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-trigger-mode-symlink-"));
  const agentDir = join(root, ".agent");
  const sharedDir = join(root, "shared");
  const sharedStore = join(sharedDir, "skill-trigger-modes.json");
  const localStore = join(agentDir, "skill-trigger-modes.json");
  const { filePath } = writeSkill(root, "demo", "demo");
  mkdirSync(agentDir);
  mkdirSync(sharedDir);
  writeFileSync(sharedStore, JSON.stringify({ version: 2, skills: {} }));
  symlinkSync(sharedStore, localStore);
  try {
    const skill = skillInfo(filePath, "demo");
    const stats = await refreshUpdatedSkillTriggerMetadata([skill], {
      cwd: root,
      agentDir,
      resolveModel: async () => ({
        model: {},
        runtime: fakeRuntime(['{"mode":"automatic","reason":"适合按任务自动选择"}']),
      }),
    });
    assert.deepEqual(stats, { analyzed: 1, skipped: 0, failed: 0 });
    assert.equal(lstatSync(localStore).isSymbolicLink(), true);
    assert.equal(readlinkSync(localStore), sharedStore);
    assert.equal(getSkillTriggerMetadata(skill, agentDir)?.source, "ai");
    const saved = JSON.parse(readFileSync(sharedStore, "utf8"));
    assert.equal(saved.skills[skillTriggerMetadataKey(skill)].mode, "automatic");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uses stable package identity instead of device absolute paths", () => {
  const mac = skillInfo("/Users/alice/.pi/agent/skills/demo/SKILL.md", "demo", {
    sourceInfo: { origin: "package", scope: "user", source: "npm:demo", baseDir: "/Users/alice/.pi/agent/pkg" },
    pluginResourceKey: "skills/demo/SKILL.md",
  });
  const debian = skillInfo("/home/alice/.pi/agent/skills/demo/SKILL.md", "demo", {
    sourceInfo: { origin: "package", scope: "user", source: "npm:demo", baseDir: "/home/alice/.pi/agent/pkg" },
    pluginResourceKey: "skills/demo/SKILL.md",
  });
  assert.equal(skillTriggerMetadataKey(mac), skillTriggerMetadataKey(debian));
});

test("parses the bounded AI trigger-mode JSON contract", () => {
  assert.deepEqual(parseAiResult('{"mode":"automatic","reason":"Matches the user request."}'), {
    mode: "automatic",
    reason: "Matches the user request.",
  });
  assert.deepEqual(parseAiResult("```json\n{\"mode\":\"manual\",\"reason\":\"Explicit command required.\"}\n```"), {
    mode: "manual",
    reason: "Explicit command required.",
  });
  assert.equal(parseAiResult('{"mode":"unknown"}'), undefined);
  assert.equal(parseAiResult('{"mode":"explicit-only"}'), undefined);
});

test("only attaches metadata when the stored content hash still matches", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-trigger-mode-"));
  const filePath = join(root, "SKILL.md");
  const content = "---\nname: demo\ndescription: demo\n---\n";
  const contentHash = createHash("sha256").update(content).digest("hex");
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(filePath, content);
    writeFileSync(join(root, "skill-trigger-modes.json"), JSON.stringify({
      version: 2,
      skills: {
        [skillTriggerMetadataKey(skillInfo(filePath, "demo"))]: {
          contentHash,
          mode: "automatic",
          source: "ai",
          analysisVersion: SKILL_TRIGGER_ANALYSIS_PROMPT_VERSION,
          analyzedAt: "2026-01-01T00:00:00.000Z",
          reason: "可按任务自动选择",
        },
      },
    }));
    const [skill] = annotateSkillsWithTriggerMetadata([skillInfo(filePath, "demo")], root);
    assert.equal(skill.triggerMode, "automatic");
    assert.equal(skill.triggerModeSource, "ai");
    assert.equal(skill.triggerModeReason, "可按任务自动选择");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reads manual invocation from frontmatter, not the effective runtime flag", () => {
  assert.equal(declaresManualInvocation("---\nname: a\ndescription: a\n---\n"), false);
  assert.equal(declaresManualInvocation("---\nname: a\ndescription: a\ndisable-model-invocation: true\n---\n"), true);
  assert.equal(declaresManualInvocation("---\nname: a\ndescription: a\ndisable-model-invocation: false\n---\n"), false);
  assert.equal(declaresManualInvocation("---\nname: a\ndescription: a\n\"disable-model-invocation\": true\n---\n"), true);
});

test("uses disable-model-invocation as the authoritative manual rule", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-trigger-mode-frontmatter-"));
  const agentDir = join(root, ".agent");
  const { filePath } = writeSkill(root, "explicit", "explicit", "disable-model-invocation: true\n");
  const skill = skillInfo(filePath, "explicit", { disableModelInvocation: true });
  try {
    const stats = await refreshSkillTriggerMetadata([skill], { cwd: root, agentDir, force: true });
    const metadata = getSkillTriggerMetadata(skill, agentDir);
    assert.deepEqual(stats, { analyzed: 1, skipped: 0, failed: 0 });
    const cachedStats = await refreshSkillTriggerMetadata([skill], { cwd: root, agentDir });
    assert.deepEqual(cachedStats, { analyzed: 0, skipped: 1, failed: 0 });
    assert.equal(metadata?.mode, "manual");
    assert.equal(metadata?.source, "frontmatter");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("frontmatter stays authoritative even when a runtime override enabled the skill", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-trigger-mode-override-"));
  const agentDir = join(root, ".agent");
  const { filePath } = writeSkill(root, "explicit", "explicit", "disable-model-invocation: true\n");
  try {
    // applySkillInvocationOverrides clears this flag once the user enables the
    // skill; classification must still read the declared frontmatter as manual.
    const stats = await refreshSkillTriggerMetadata([skillInfo(filePath, "explicit")], {
      cwd: root, agentDir, force: true,
    });
    const metadata = getSkillTriggerMetadata({ filePath }, agentDir);
    assert.deepEqual(stats, { analyzed: 1, skipped: 0, failed: 0 });
    assert.equal(metadata?.mode, "manual");
    assert.equal(metadata?.source, "frontmatter");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("interleaved AI refreshes both survive instead of overwriting one snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-trigger-mode-merge-"));
  const agentDir = join(root, ".agent");
  const first = writeSkill(root, "first", "first");
  const second = writeSkill(root, "second", "second");
  try {
    // Both refreshes must have taken their store snapshot and be awaiting the
    // model before either persists; that overlap is what a snapshot-replacing
    // write loses. The barrier makes the interleaving deterministic.
    let started = 0;
    let release;
    const bothStarted = new Promise((resolve) => { release = resolve; });
    const runtimeFor = (mode, reason) => ({
      async completeSimple() {
        started += 1;
        if (started === 2) release();
        await bothStarted;
        return { stopReason: "end", content: [{ type: "text", text: `{"mode":"${mode}","reason":"${reason}"}` }] };
      },
    });
    await Promise.all([
      refreshSkillTriggerMetadata([skillInfo(first.filePath, "first")], {
        cwd: root, agentDir, force: true,
        resolveModel: async () => ({ runtime: runtimeFor("automatic", "通用能力适合自动选择"), model: {} }),
      }),
      refreshSkillTriggerMetadata([skillInfo(second.filePath, "second")], {
        cwd: root, agentDir, force: true,
        resolveModel: async () => ({ runtime: runtimeFor("manual", "需要用户明确指定"), model: {} }),
      }),
    ]);
    assert.equal(started, 2, "both refreshes must have been in flight together");
    const store = JSON.parse(readFileSync(join(agentDir, "skill-trigger-modes.json"), "utf8"));
    assert.equal(store.skills[skillTriggerMetadataKey(skillInfo(first.filePath, "first"))]?.mode, "automatic");
    assert.equal(store.skills[skillTriggerMetadataKey(skillInfo(second.filePath, "second"))]?.mode, "manual");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a refresh waits for another process holding the store lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-trigger-mode-xproc-"));
  const agentDir = join(root, ".agent");
  const { filePath } = writeSkill(root, "auto", "auto");
  const lockPath = join(agentDir, "skill-trigger-modes.json.lock");
  mkdirSync(agentDir, { recursive: true });
  // A separate process owns the lock for a while; the refresh must not clobber
  // the store, and must still persist once the peer releases it.
  const holder = spawn(process.execPath, ["-e", `
    const fs = require("node:fs");
    const lock = ${JSON.stringify(lockPath)};
    fs.writeFileSync(lock, "");
    setTimeout(() => { fs.unlinkSync(lock); }, 600);
  `], { stdio: "ignore" });
  try {
    const stats = await refreshSkillTriggerMetadata([skillInfo(filePath, "auto")], {
      cwd: root, agentDir, force: true,
      resolveModel: async () => ({
        runtime: { async completeSimple() { return { stopReason: "end", content: [{ type: "text", text: '{"mode":"automatic","reason":"适合按任务选择"}' }] }; } },
        model: {},
      }),
    });
    assert.deepEqual(stats, { analyzed: 1, skipped: 0, failed: 0 });
    const store = JSON.parse(readFileSync(join(agentDir, "skill-trigger-modes.json"), "utf8"));
    assert.equal(store.skills[skillTriggerMetadataKey(skillInfo(filePath, "auto"))]?.mode, "automatic");
    assert.equal(existsSync(lockPath), false, "lock must be released after the merge");
  } finally {
    holder.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a busy store degrades gracefully instead of failing the batch", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-trigger-mode-busy-"));
  const agentDir = join(root, ".agent");
  const { filePath } = writeSkill(root, "explicit", "explicit", "disable-model-invocation: true\n");
  const lockPath = join(agentDir, "skill-trigger-modes.json.lock");
  mkdirSync(agentDir, { recursive: true });
  try {
    // A fresh lock is never treated as stale, so the merge gives up and the
    // caller still returns a usable stat instead of throwing.
    writeFileSync(lockPath, "");
    const stats = await refreshSkillTriggerMetadata([skillInfo(filePath, "explicit")], {
      cwd: root, agentDir, force: true, storeLockTimeoutMs: 100,
    });
    assert.deepEqual(stats, { analyzed: 1, skipped: 0, failed: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("AI classification is persisted with the ai source for a normal skill", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-trigger-mode-ai-"));
  const agentDir = join(root, ".agent");
  const { filePath } = writeSkill(root, "auto", "auto");
  const runtime = fakeRuntime(['{"mode":"automatic","reason":"通用能力适合自动选择"}']);
  try {
    const stats = await refreshSkillTriggerMetadata([skillInfo(filePath, "auto")], {
      cwd: root, agentDir, force: true, resolveModel: async () => ({ runtime, model: {} }),
    });
    const metadata = getSkillTriggerMetadata({ filePath }, agentDir);
    assert.deepEqual(stats, { analyzed: 1, skipped: 0, failed: 0 });
    assert.equal(metadata?.mode, "automatic");
    assert.equal(metadata?.source, "ai");
    assert.equal(runtime.calls.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed analysis is retried on a later refresh with unchanged content", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-trigger-mode-retry-"));
  const agentDir = join(root, ".agent");
  const { filePath } = writeSkill(root, "auto", "auto");
  try {
    const failed = await refreshSkillTriggerMetadata([skillInfo(filePath, "auto")], {
      cwd: root, agentDir, force: true,
      resolveModel: async () => ({ runtime: fakeRuntime([new Error("model offline")]), model: {} }),
    });
    assert.deepEqual(failed, { analyzed: 0, skipped: 0, failed: 1, failures: [{ filePath, name: "auto", reason: "model offline" }] });
    assert.equal(getSkillTriggerMetadata({ filePath }, agentDir)?.source, "fallback");
    // Unchanged content and no force: the degraded entry must not be a cache hit.
    const retried = await refreshSkillTriggerMetadata([skillInfo(filePath, "auto")], {
      cwd: root, agentDir,
      resolveModel: async () => ({ runtime: fakeRuntime(['{"mode":"manual","reason":"需要明确触发"}']), model: {} }),
    });
    const metadata = getSkillTriggerMetadata({ filePath }, agentDir);
    assert.deepEqual(retried, { analyzed: 1, skipped: 0, failed: 0 });
    assert.equal(metadata?.mode, "manual");
    assert.equal(metadata?.source, "ai");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failing model falls back to a runtime label without failing the batch", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-trigger-mode-fallback-"));
  const agentDir = join(root, ".agent");
  const { filePath } = writeSkill(root, "auto", "auto");
  try {
    const stats = await refreshSkillTriggerMetadata([skillInfo(filePath, "auto")], {
      cwd: root, agentDir, force: true,
      resolveModel: async () => ({ runtime: fakeRuntime([new Error("model offline")]), model: {} }),
    });
    const metadata = getSkillTriggerMetadata({ filePath }, agentDir);
    assert.deepEqual(stats, { analyzed: 0, skipped: 0, failed: 1, failures: [{ filePath, name: "auto", reason: "model offline" }] });
    assert.equal(metadata?.source, "fallback");
    assert.equal(metadata?.mode, "automatic");
    assert.equal(metadata?.reason, "model offline");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stalled model resolution cannot hold the refresh past its budget", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-trigger-mode-stall-"));
  const agentDir = join(root, ".agent");
  const { filePath } = writeSkill(root, "auto", "auto");
  let resolveModelCalled = false;
  try {
    const started = Date.now();
    const stats = await refreshSkillTriggerMetadata([skillInfo(filePath, "auto")], {
      cwd: root, agentDir, force: true, budgetMs: 300,
      resolveModel: () => {
        resolveModelCalled = true;
        return new Promise(() => {});
      },
    });
    const elapsed = Date.now() - started;
    assert.ok(resolveModelCalled);
    // Analysis is awaited per skill; a never-settling resolver must not inflate
    // the batch beyond its own explicit budget plus scheduling slack.
    assert.ok(elapsed < 3000, `refresh took ${elapsed}ms`);
    const metadata = getSkillTriggerMetadata({ filePath }, agentDir);
    assert.equal(metadata?.source, "fallback");
    assert.equal(stats.failed, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("includes parent plugin metadata in the AI analysis prompt", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-trigger-mode-plugin-context-"));
  const agentDir = join(root, ".agent");
  const pluginDir = join(root, "plugin");
  const skill = writeSkill(root, "plugin/skills/demo", "demo");
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, "package.json"), JSON.stringify({
    name: "demo-plugin",
    version: "1.2.3",
    description: "Provides deployment skills with approval-sensitive actions.",
  }));
  const runtime = fakeRuntime(['{"mode":"manual","reason":"涉及审批操作，适合明确触发"}']);
  try {
    const stats = await refreshSkillTriggerMetadata([
      skillInfo(skill.filePath, "demo", {
        sourceInfo: {
          origin: "package",
          scope: "user",
          source: "npm:demo-plugin",
          baseDir: pluginDir,
        },
      }),
    ], {
      cwd: root,
      agentDir,
      force: true,
      resolveModel: async () => ({ runtime, model: {} }),
    });
    assert.deepEqual(stats, { analyzed: 1, skipped: 0, failed: 0 });
    assert.match(runtime.calls[0], /demo-plugin/);
    assert.match(runtime.calls[0], /approval-sensitive actions/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("multiple skills each get their own classification", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-trigger-mode-multi-"));
  const agentDir = join(root, ".agent");
  const manual = writeSkill(root, "manual", "manual", "disable-model-invocation: true\n");
  const first = writeSkill(root, "first", "first");
  const second = writeSkill(root, "second", "second");
  const runtime = fakeRuntime([
    '{"mode":"automatic","reason":"通用能力适合自动选择"}',
    '{"mode":"manual","reason":"需要用户明确指定"}',
  ]);
  try {
    const stats = await refreshSkillTriggerMetadata([
      skillInfo(manual.filePath, "manual"),
      skillInfo(first.filePath, "first"),
      skillInfo(second.filePath, "second"),
    ], { cwd: root, agentDir, force: true, resolveModel: async () => ({ runtime, model: {} }) });
    assert.deepEqual(stats, { analyzed: 3, skipped: 0, failed: 0 });
    assert.equal(runtime.calls.length, 2, "manual skill must not consume a model call");
    assert.equal(getSkillTriggerMetadata({ filePath: manual.filePath }, agentDir)?.source, "frontmatter");
    assert.equal(getSkillTriggerMetadata({ filePath: first.filePath }, agentDir)?.mode, "automatic");
    assert.equal(getSkillTriggerMetadata({ filePath: second.filePath }, agentDir)?.mode, "manual");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no model is resolved at all when every skill is manual", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-trigger-mode-nomodel-"));
  const agentDir = join(root, ".agent");
  const first = writeSkill(root, "a", "a", "disable-model-invocation: true\n");
  const second = writeSkill(root, "b", "b", "disable-model-invocation: true\n");
  try {
    let resolved = false;
    const stats = await refreshSkillTriggerMetadata([
      skillInfo(first.filePath, "a"),
      skillInfo(second.filePath, "b"),
    ], {
      cwd: root, agentDir, force: true,
      resolveModel: async () => { resolved = true; return { runtime: fakeRuntime([]), model: {} }; },
    });
    assert.deepEqual(stats, { analyzed: 2, skipped: 0, failed: 0 });
    assert.equal(resolved, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("frontmatter decides manual labeling even with no cached metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-trigger-mode-uncached-"));
  const { filePath } = writeSkill(root, "explicit", "explicit", "disable-model-invocation: true\n");
  try {
    // The reviewer's exact regression: the runtime flag was cleared by an
    // enable override and no metadata exists yet, so the label must still be
    // manual because the skill declares it.
    const [skill] = annotateSkillsWithTriggerMetadata([
      skillInfo(filePath, "explicit", { disableModelInvocation: false }),
    ], root);
    assert.equal(skill.declaresManualInvocation, true);
    assert.equal(skill.triggerMode, "manual");
    assert.equal(skill.triggerModeSource, "frontmatter");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("frontmatter still wins when the cached metadata is stale", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-trigger-mode-stale-"));
  const { filePath } = writeSkill(root, "explicit", "explicit", "disable-model-invocation: true\n");
  try {
    writeFileSync(join(root, "skill-trigger-modes.json"), JSON.stringify({
      version: 2,
      skills: { [skillTriggerMetadataKey(skillInfo(filePath, "explicit"))]: { contentHash: "stale", mode: "automatic", source: "ai", analyzedAt: "2026-01-01T00:00:00.000Z" } },
    }));
    const [skill] = annotateSkillsWithTriggerMetadata([
      skillInfo(filePath, "explicit", { disableModelInvocation: false }),
    ], root);
    assert.equal(skill.triggerMode, "manual");
    assert.equal(skill.triggerModeSource, "frontmatter");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a normal skill without metadata is not labeled manual", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-trigger-mode-plain-"));
  const { filePath } = writeSkill(root, "plain", "plain");
  try {
    const [skill] = annotateSkillsWithTriggerMetadata([skillInfo(filePath, "plain")], root);
    assert.equal(skill.declaresManualInvocation, false);
    assert.equal(skill.triggerMode, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fully reanalyzes every updated skill beyond the interactive refresh budget", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-trigger-mode-updated-all-"));
  const agentDir = join(root, ".agent");
  const first = writeSkill(root, "first", "first");
  const second = writeSkill(root, "second", "second");
  const runtime = fakeRuntime([
    "{\"mode\":\"automatic\",\"reason\":\"更新后适合自动选择\"}",
    "{\"mode\":\"manual\",\"reason\":\"更新后需要明确触发\"}",
  ]);
  try {
    const stats = await refreshUpdatedSkillTriggerMetadata([
      skillInfo(first.filePath, "first"),
      skillInfo(second.filePath, "second"),
    ], {
      cwd: root,
      agentDir,
      budgetMs: 0,
      resolveModel: async () => ({ runtime, model: {} }),
    });
    assert.deepEqual(stats, { analyzed: 2, skipped: 0, failed: 0 });
    assert.equal(runtime.calls.length, 2);
    assert.equal(getSkillTriggerMetadata({ filePath: first.filePath }, agentDir)?.source, "ai");
    assert.equal(getSkillTriggerMetadata({ filePath: second.filePath }, agentDir)?.source, "ai");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("records fallback metadata for every updated skill when model resolution fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-trigger-mode-updated-fallback-"));
  const agentDir = join(root, ".agent");
  const first = writeSkill(root, "first", "first");
  const second = writeSkill(root, "second", "second");
  let resolveCalls = 0;
  try {
    const stats = await refreshUpdatedSkillTriggerMetadata([
      skillInfo(first.filePath, "first"),
      skillInfo(second.filePath, "second"),
    ], {
      cwd: root,
      agentDir,
      resolveModel: async () => {
        resolveCalls += 1;
        throw new Error("model offline");
      },
    });
    assert.deepEqual(stats, { analyzed: 0, skipped: 0, failed: 2, failures: [
      { filePath: first.filePath, name: "first", reason: "model offline" },
      { filePath: second.filePath, name: "second", reason: "model offline" },
    ] });
    assert.equal(resolveCalls, 1);
    assert.equal(getSkillTriggerMetadata({ filePath: first.filePath }, agentDir)?.source, "fallback");
    assert.equal(getSkillTriggerMetadata({ filePath: second.filePath }, agentDir)?.source, "fallback");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("complete analysis reports a busy metadata store as a retryable failure, then persists after release", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-trigger-complete-busy-"));
  const agentDir = join(root, ".agent");
  const { filePath } = writeSkill(root, "explicit", "explicit", "disable-model-invocation: true\n");
  const lockPath = join(agentDir, "skill-trigger-modes.json.lock");
  mkdirSync(agentDir, { recursive: true });
  try {
    writeFileSync(lockPath, "");
    const failed = await refreshUpdatedSkillTriggerMetadata([skillInfo(filePath, "explicit")], { cwd: root, agentDir, storeLockTimeoutMs: 50 });
    assert.equal(failed.analyzed, 0);
    assert.equal(failed.failed, 1);
    assert.equal(failed.failures[0].filePath, filePath);
    assert.match(failed.failures[0].reason, /could not be saved.*store is busy/);
    assert.equal(existsSync(join(agentDir, "skill-trigger-modes.json")), false);
    rmSync(lockPath);
    const retried = await refreshUpdatedSkillTriggerMetadata([skillInfo(filePath, "explicit")], { cwd: root, agentDir });
    assert.deepEqual(retried, { analyzed: 1, skipped: 0, failed: 0 });
    assert.equal(getSkillTriggerMetadata({ filePath }, agentDir)?.source, "frontmatter");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("Chinese recommendation contract invalidates old AI cache without deleting its evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "reader-analysis-contract-"));
  const agentDir = join(root, "agent");
  const { filePath } = writeSkill(root, "demo", "demo");
  const skill = skillInfo(filePath, "demo");
  try {
    mkdirSync(agentDir);
    const storePath = skillTriggerMetadataPath(agentDir);
    const old = { version: 2, skills: { [skillTriggerMetadataKey(skill)]: {
      contentHash: createHash("sha256").update(readFileSync(filePath)).digest("hex"),
      mode: "manual", source: "ai", reason: "Old advice", analyzedAt: "2026-01-01T00:00:00Z",
    } } };
    writeFileSync(storePath, JSON.stringify(old));
    assert.equal(getSkillTriggerMetadata(skill, agentDir), undefined);
    assert.deepEqual(JSON.parse(readFileSync(storePath, "utf8")), old);
    let context;
    const stats = await refreshUpdatedSkillTriggerMetadata([skill], { cwd: root, agentDir, resolveModel: async () => ({ model: {}, runtime: { async completeSimple(_model, input) { context = input; return { content: [{ type: "text", text: JSON.stringify({ mode: "automatic", reason: "适合按任务自动选择" }) }] }; } } }) });
    assert.equal(stats.analyzed, 1);
    assert.equal(context.systemPrompt, SKILL_TRIGGER_ANALYSIS_SYSTEM_PROMPT);
    assert.match(context.systemPrompt, /简体中文/);
    assert.match(context.messages[0].content, /技能/);
    assert.equal(getSkillTriggerMetadata(skill, agentDir).reason, "适合按任务自动选择");
    assert.equal(getSkillTriggerMetadata(skill, agentDir).analysisVersion, SKILL_TRIGGER_ANALYSIS_PROMPT_VERSION);
    const failed = await refreshUpdatedSkillTriggerMetadata([skill], { cwd: root, agentDir, force: true, resolveModel: async () => ({ model: {}, runtime: fakeRuntime(['{"mode":"manual","reason":"English only"}']) }) });
    assert.equal(failed.failed, 1);
    assert.match(failed.failures[0].reason, /中文理由/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
