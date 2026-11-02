import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";

const workflows = fileURLToPath(new URL("../../.github/workflows/", import.meta.url));

function checkPullRequestWorkflow(workflow) {
  const events = typeof workflow.on === "string" ? [workflow.on]
    : Array.isArray(workflow.on) ? workflow.on : Object.keys(workflow.on ?? {});
  assert.ok(!events.includes("pull_request_target"), "untrusted PRs cannot use pull_request_target");
  assert.ok(!events.includes("workflow_run"), "workflow_run requires a separate trusted-artifact design");
  if (!events.includes("pull_request")) return false;

  assert.deepEqual(workflow.permissions, { contents: "read" }, "PR workflow permissions must be read-only");
  let checkouts = 0;
  for (const job of Object.values(workflow.jobs ?? {})) {
    assert.match(job["runs-on"], /^(ubuntu|macos|windows)-(latest|[0-9][0-9.]*)$/, "PR jobs must use a GitHub-hosted runner");
    assert.equal(job.permissions, undefined, "PR jobs cannot override workflow permissions");
    assert.equal(job.environment, undefined, "PR jobs cannot use a privileged deployment environment");
    assert.ok(!/\$\{\{[^}]*\bsecrets\b/i.test(JSON.stringify(job)), "PR jobs cannot receive secrets");
    assert.ok(Array.isArray(job.steps), "reusable jobs require a separate trust review");
    for (const step of job.steps) {
      const action = step.uses ?? "";
      if (action) assert.match(action, /^[^@\s]+@[0-9a-f]{40}$/, "PR actions must use immutable commits");
      if (action.startsWith("actions/checkout@")) {
        checkouts += 1;
        assert.equal(step.with?.["persist-credentials"], false, "checkout must not persist credentials");
        assert.ok(!Object.hasOwn(step.with ?? {}, "token"), "checkout must not receive an explicit token");
      }
      assert.ok(!action.startsWith("actions/cache"), "PR jobs cannot share dependency caches");
      if (action.startsWith("actions/setup-node@")) {
        assert.equal(step.with?.cache, undefined, "PR jobs cannot enable setup-node caching");
      }
    }
  }
  assert.ok(checkouts > 0, "PR workflow must contain an inspected checkout");
  return true;
}

test("every PR workflow uses hosted runners without persistent credentials or shared caches", () => {
  const files = readdirSync(workflows).filter((name) => /\.ya?ml$/.test(name));
  assert.ok(files.length > 0, "no workflows found");
  const checked = files.filter((file) => checkPullRequestWorkflow(load(readFileSync(join(workflows, file), "utf8"))));
  assert.ok(checked.length > 0, "no PR workflow found");
});

test("the guard rejects privileged triggers, persistent credentials and shared caches", () => {
  const current = load(readFileSync(join(workflows, "ci.yml"), "utf8"));
  const cases = [
    (workflow) => { workflow.on.pull_request_target = {}; },
    (workflow) => { workflow.jobs.checks["runs-on"] = "self-hosted"; },
    (workflow) => { workflow.jobs.checks.steps[0].with["persist-credentials"] = true; },
    (workflow) => { workflow.jobs.checks.steps[0].uses = "actions/checkout@v4"; },
    (workflow) => { workflow.jobs.checks.steps[1].with.cache = "npm"; },
    (workflow) => { workflow.jobs.checks.permissions = { contents: "write" }; },
    (workflow) => { workflow.jobs.checks.steps[0].with.token = "${{ secrets.FAKE }}"; },
  ];
  for (const mutate of cases) {
    const candidate = structuredClone(current);
    mutate(candidate);
    assert.throws(() => checkPullRequestWorkflow(candidate));
  }
});
