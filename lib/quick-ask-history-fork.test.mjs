import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { quickAskFixture, log, storage } from "../test-support/quick-ask-fixture.mjs";

async function answer(h, question) {
  const run = await h.start({ question });
  h.runs.at(-1).complete(`answer ${question}`);
  return (await h.waitTerminal(run.id)).entry;
}

for (const cold of [false, true]) {
  test(`${cold ? "cold" : "live"} historical fork retains its own checkpoint and system after repeated topic rebases`, async () => {
    const h = await quickAskFixture();
    try {
      const first = await answer(h, "first");
      const scope = { threadId: "a", branchId: "main" };
      const initialBranch = log.findQuickAskBranch(h.manager.getEntries(), scope);
      const firstSystem = structuredClone(initialBranch.sourceSystem);
      h.manager.appendMessage({ role: "user", content: "future detail one", timestamp: Date.now() });
      h.manager.appendMessage({ ...h.system, content: "system at checkpoint one", timestamp: Date.now() });
      h.manager.appendCompaction("checkpoint one", null, 5000);
      const second = await answer(h, "second");
      h.manager.appendMessage({ role: "user", content: "future detail two", timestamp: Date.now() });
      h.manager.appendMessage({ ...h.system, content: "system at checkpoint two", timestamp: Date.now() });
      h.manager.appendCompaction("checkpoint two", null, 5000);
      const third = await answer(h, "third");
      const sourceBytes = await readFile(h.file, "utf8");
      const latestAnchor = log.findQuickAskBranch(h.manager.getEntries(), scope).contextAnchorId;
      h.state.visible = !cold;
      const created = [];
      for (const target of [first, second, third]) {
        const response = await h.post({ action: "fork", targetId: target.id });
        const result = await response.json();
        assert.equal(response.status, 200, JSON.stringify(result));
        const opened = SessionManager.open(result.newSessionPath);
        created.push(opened);
        const copied = opened.getEntries().find(entry => entry.message?.usageEvent?.id === target.usageEvent.id);
        assert.equal(copied.message.usageEvent.relation, "copy");
      }
      const contexts = created.map(manager => JSON.stringify(manager.buildSessionContext()));
      assert.match(contexts[0], /ancestor question|answer first/);
      assert.doesNotMatch(contexts[0], /checkpoint one|checkpoint two|future detail|answer second|answer third/);
      assert.deepEqual(created[0].buildSessionContext().messages[0], firstSystem);
      assert.match(contexts[1], /checkpoint one/);
      assert.match(contexts[1], /system at checkpoint one/);
      assert.doesNotMatch(contexts[1], /checkpoint two|future detail two|answer third/);
      assert.match(contexts[2], /checkpoint two/);
      assert.match(contexts[2], /answer third/);
      assert.equal(await readFile(h.file, "utf8"), sourceBytes, "individual forks never rewrite source records");
      assert.equal(log.findQuickAskBranch(h.manager.getEntries(), scope).contextAnchorId, latestAnchor);
      assert.equal(h.runs.length, 3, "forks never invoke a model");
      // Whole-topic transfer still uses the latest source and all completed answers.
      const transfer = await h.post({ action: "fork", threadId: "a" });
      assert.equal(transfer.status, 200);
      const transferred = SessionManager.open((await transfer.json()).newSessionPath);
      const text = JSON.stringify(transferred.buildSessionContext());
      assert.match(text, /checkpoint two/);
      assert.match(text, /answer first/);
      assert.match(text, /answer third/);
    } finally { await h.cleanup(); }
  });

  test(`${cold ? "cold" : "live"} historical fork preserves flat-record origins and rejects deleted or foreign targets`, async () => {
    const h = await quickAskFixture();
    try {
      const old = h.host.append("quick_ask", { threadId: "a", question: "flat question", answer: "flat answer", createdAt: 1 });
      h.manager.appendCompaction("later checkpoint", null, 5000);
      await answer(h, "native follow-up");
      h.state.visible = !cold;
      const response = await h.post({ action: "fork", targetId: old.id });
      assert.equal(response.status, 200);
      const opened = SessionManager.open((await response.json()).newSessionPath);
      const text = JSON.stringify(opened.buildSessionContext());
      assert.match(text, /ancestor question/);
      assert.match(text, /flat answer/);
      assert.doesNotMatch(text, /later checkpoint|native follow-up/);
      assert.equal((await h.post({ action: "fork", targetId: old.id, branchId: "foreign" })).status, 404);
      h.host.append("quick_ask_delete", { targetId: old.id });
      assert.equal((await h.post({ action: "fork", targetId: old.id })).status, 404);
      assert.equal((await storage.readSessionQuickAsks(h.file)).some(item => item.id === old.id), false);
    } finally { await h.cleanup(); }
  });
}
