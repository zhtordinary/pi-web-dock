import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { readAsyncModelMetadata } = await jiti.import("./subagent-async-metadata.ts");
const { asyncMetadataKey } = await jiti.import("./async-metadata-key.ts");

test("projects producer-shaped root and step metadata with qualified identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-reader-async-metadata-"));
  const previous = process.env.PI_SUBAGENTS_TEMP_ROOT;
  process.env.PI_SUBAGENTS_TEMP_ROOT = root;
  try {
    const runDir = join(root, "async-subagent-runs", "run-1");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "status.json"), JSON.stringify({
      sessionId: "parent-session",
      runId: "run-1",
      steps: [
        { workflowKey: "step-1", runId: "child-1", agent: "custom-explorer", requestedModel: "provider/child-model", thinking: "max" },
      ],
    }));

    assert.deepEqual(
      readAsyncModelMetadata("parent-session", [
        asyncMetadataKey("run-1"),
        asyncMetadataKey("run-1", ["step-1"]),
      ]),
      {
        [asyncMetadataKey("run-1")]: { agent: "custom-explorer", model: "provider/child-model", thinking: "max" },
        [asyncMetadataKey("run-1", ["step-1"])] : { agent: "custom-explorer", model: "provider/child-model", thinking: "max" },
      },
    );
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT;
    else process.env.PI_SUBAGENTS_TEMP_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("matches session file paths against UUID query and propagates agent with child model", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-reader-async-metadata-path-"));
  const previous = process.env.PI_SUBAGENTS_TEMP_ROOT;
  process.env.PI_SUBAGENTS_TEMP_ROOT = root;
  try {
    const parentDir = join(root, "async-subagent-runs", "workflow-run");
    const childDir = join(root, "async-subagent-runs", "child-run-1");
    await mkdir(parentDir, { recursive: true });
    await mkdir(childDir, { recursive: true });
    const fullSessionPath = "/Users/test/.pi/agent/sessions/test/2026-10-04_session-uuid-1234.jsonl";

    await writeFile(join(parentDir, "status.json"), JSON.stringify({
      sessionId: fullSessionPath,
      runId: "workflow-run",
      steps: [
        { workflowKey: "task-1", runId: "child-run-1", agent: "custom-explorer", label: "Inspect baseline" },
      ],
    }));

    await writeFile(join(childDir, "status.json"), JSON.stringify({
      sessionId: fullSessionPath,
      runId: "child-run-1",
      parentWorkflowRunId: "workflow-run",
      workflowKey: "task-1",
      steps: [
        { model: "CPA GPT/gpt-5.6-luna:max", thinking: "max", requestedModel: "CPA GPT/gpt-5.6-luna" },
      ],
    }));

    const result = readAsyncModelMetadata("session-uuid-1234", [
      asyncMetadataKey("workflow-run", ["task-1"]),
    ]);
    assert.deepEqual(result, {
      [asyncMetadataKey("workflow-run", ["task-1"])]: {
        agent: "custom-explorer",
        model: "CPA GPT/gpt-5.6-luna:max",
        thinking: "max",
      },
    });
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT;
    else process.env.PI_SUBAGENTS_TEMP_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("reprojects a reused child model onto the current workflow key", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-reader-async-metadata-reused-"));
  const previous = process.env.PI_SUBAGENTS_TEMP_ROOT;
  process.env.PI_SUBAGENTS_TEMP_ROOT = root;
  try {
    const workflowId = "current-workflow";
    const childId = "reused-child";
    const workflowDir = join(root, "async-subagent-runs", workflowId);
    const childDir = join(root, "async-subagent-runs", childId);
    await mkdir(workflowDir, { recursive: true });
    await mkdir(childDir, { recursive: true });
    const fullSessionPath = "/Users/test/.pi/agent/sessions/test/reused-session.jsonl";

    await writeFile(join(workflowDir, "status.json"), JSON.stringify({
      sessionId: fullSessionPath,
      runId: workflowId,
      steps: [
        { workflowKey: "A1", runId: childId, agent: "custom-executor", reused: true },
      ],
    }));
    await writeFile(join(childDir, "status.json"), JSON.stringify({
      sessionId: fullSessionPath,
      runId: childId,
      parentWorkflowRunId: "old-workflow",
      workflowKey: "A1",
      steps: [
        { model: "CPA GPT/gpt-5.6-luna:max", thinking: "max", requestedModel: "CPA GPT/gpt-5.6-luna" },
      ],
    }));

    const key = asyncMetadataKey(workflowId, ["A1"]);
    assert.deepEqual(readAsyncModelMetadata("reused-session", [key]), {
      [key]: {
        agent: "custom-executor",
        model: "CPA GPT/gpt-5.6-luna:max",
        thinking: "max",
      },
    });
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT;
    else process.env.PI_SUBAGENTS_TEMP_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps duplicate step and workflow keys isolated across concurrent roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-reader-async-metadata-parallel-"));
  const previous = process.env.PI_SUBAGENTS_TEMP_ROOT;
  process.env.PI_SUBAGENTS_TEMP_ROOT = root;
  try {
    for (const [runId, model] of [["run-a", "provider/a"], ["run-b", "provider/b"]]) {
      const runDir = join(root, "async-subagent-runs", runId);
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, "status.json"), JSON.stringify({ sessionId: "parent-session", runId, steps: [{ workflowKey: "shared", model }] }));
    }
    const ids = [asyncMetadataKey("run-a", ["shared"]), asyncMetadataKey("run-b", ["shared"])];
    assert.deepEqual(readAsyncModelMetadata("parent-session", ids), {
      [ids[0]]: { model: "provider/a" },
      [ids[1]]: { model: "provider/b" },
    });
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT;
    else process.env.PI_SUBAGENTS_TEMP_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed for mismatched run identities and symlinked status paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-reader-async-metadata-safe-"));
  const previous = process.env.PI_SUBAGENTS_TEMP_ROOT;
  process.env.PI_SUBAGENTS_TEMP_ROOT = root;
  try {
    const runsRoot = join(root, "async-subagent-runs");
    const validDir = join(runsRoot, "run-valid");
    const mismatchedDir = join(runsRoot, "run-mismatch");
    const outside = await mkdtemp(join(tmpdir(), "pi-reader-async-metadata-outside-"));
    await mkdir(validDir, { recursive: true });
    await mkdir(mismatchedDir, { recursive: true });
    await writeFile(join(validDir, "status.json"), JSON.stringify({ sessionId: "parent-session", runId: "run-valid", steps: [{ workflowKey: "safe", model: "provider/safe" }] }));
    await writeFile(join(mismatchedDir, "status.json"), JSON.stringify({ sessionId: "parent-session", runId: "other-run", steps: [{ workflowKey: "wrong", model: "provider/wrong" }] }));
    await writeFile(join(outside, "status.json"), JSON.stringify({ sessionId: "parent-session", runId: "run-escape", steps: [{ workflowKey: "escape", model: "provider/escape" }] }));
    const symlinkDir = join(runsRoot, "run-escape");
    const symlinkStatus = join(runsRoot, "run-status-link");
    const { symlink } = await import("node:fs/promises");
    await symlink(outside, symlinkDir, "dir");
    const regularDir = join(runsRoot, "run-status-link");
    await mkdir(regularDir, { recursive: true });
    await symlink(join(outside, "status.json"), join(regularDir, "status.json"));

    const safeKey = asyncMetadataKey("run-valid", ["safe"]);
    const wrongKey = asyncMetadataKey("run-mismatch", ["wrong"]);
    const escapeKey = asyncMetadataKey("run-escape", ["escape"]);
    assert.deepEqual(readAsyncModelMetadata("parent-session", [safeKey, wrongKey, escapeKey]), { [safeKey]: { model: "provider/safe" } });
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT;
    else process.env.PI_SUBAGENTS_TEMP_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});
