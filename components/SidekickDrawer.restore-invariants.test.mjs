import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadSidekickHelpers } from "../test-support/sidekick-client-fixture.mjs";
import { testTranslator } from "./test-locale.mjs";

const source = readFileSync(new URL("./SidekickDrawer.tsx", import.meta.url), "utf8");
const helpers = {};
loadSidekickHelpers(source, helpers);
const restore = helpers.restoreSidekickDraft;
const t = testTranslator("en");
const key = "view";
const original = { runId: "R", question: "original question", images: ["original-image"] };

/** Every combination of what the input box holds, what is still being processed, which reply is shown and why it is restored. */
function* situations() {
  for (const text of ["", "   ", "typed"]) for (const images of [[], ["new-image"]]) for (const processing of [false, true])
    for (const reason of [undefined, "refused"]) for (const shown of ["none", "other run", "this run"]) {
      const reply = shown === "none" ? undefined : { runId: shown === "this run" ? "R" : "R2", question: original.question, images: original.images,
        answer: "text", thinking: "", running: false };
      const previous = { drafts: { [key]: { question: text, images, error: null }, other: { question: "keep", images: [], error: null } },
        replies: { ...(reply ? { [key]: reply } : {}), other: { runId: "X", question: "keep", images: [], answer: "", thinking: "", running: true } } };
      yield { previous, text, images, processing, reason, shown, conflict: Boolean(text.trim() || images.length || processing) };
    }
}

test("restoring never loses what the user typed or what was asked, whatever the input box holds", () => {
  let checked = 0;
  for (const s of situations()) {
    const label = JSON.stringify({ text: s.text, images: s.images.length, processing: s.processing, reason: s.reason, shown: s.shown });
    const next = restore(s.previous, key, original, s.processing, t, s.reason);
    checked++;
    assert.equal(next.drafts.other, s.previous.drafts.other, `other views stay untouched ${label}`);
    assert.equal(next.replies.other, s.previous.replies.other, `other views stay untouched ${label}`);
    if (s.shown !== "this run") { assert.equal(next, s.previous, `a reply that is not the source changes nothing ${label}`); continue; }
    if (s.conflict) {
      assert.equal(next.drafts[key].question, s.text, label);
      assert.deepEqual(next.drafts[key].images, s.images, label);
      assert.equal(next.replies[key].question, original.question, `the unsent question stays on screen ${label}`);
      assert.deepEqual(next.replies[key].images, original.images, label);
      if (s.reason === undefined) assert.equal(next.drafts[key].error, t("sidekick.restoreDraftBusy"), label);
      else assert.equal(next.replies[key].answer, `[${t("sidekick.notSent", { reason: "refused" })}]`, label);
      assert.equal(next.replies[key].running, false, label);
    } else {
      assert.equal(next.replies[key], undefined, `the source is released only once its content moved ${label}`);
      assert.equal(next.drafts[key].question, original.question, label);
      assert.deepEqual(next.drafts[key].images, original.images, label);
      assert.equal(next.drafts[key].error, s.reason === undefined ? null : t("sidekick.notSent", { reason: "refused" }), label);
    }
  }
  assert.equal(checked, 3 * 2 * 2 * 2 * 3);
});

test("a source with only images, or only text, is restorable and a missing draft counts as empty", () => {
  for (const sent of [{ runId: "R", question: "", images: ["only-image"] }, { runId: "R", question: "only text", images: [] }]) {
    const next = restore({ drafts: {}, replies: { [key]: { ...sent, answer: "", thinking: "", running: false } } }, key, sent, false, t);
    assert.equal(next.replies[key], undefined);
    assert.equal(next.drafts[key].question, sent.question);
    assert.deepEqual(next.drafts[key].images, sent.images);
  }
});
