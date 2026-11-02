import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Script } from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
const tree = ts.createSourceFile("ChatInput.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = tree.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "resizeChatInput");
assert.ok(declaration, "the composer must share one resize function");
const resizeChatInput = new Script(ts.transpileModule(`${declaration.getText(tree)}\nresizeChatInput;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText).runInNewContext({ CHAT_INPUT_MAX_HEIGHT: 200 });

function harness({ height = 132, contentHeight = height, minHeight = "", mounted = true } = {}) {
  const transcript = { scrollHeight: 2400, clientHeight: 0, scrollTop: 0 };
  const textareaHeight = () => Math.max(24, Number.parseFloat(textarea.style.height) || 24);
  const composer = {
    style: { minHeight },
    get offsetHeight() { return Math.max(Number.parseFloat(this.style.minHeight) || 0, 80 + textareaHeight()); },
  };
  const layout = () => {
    transcript.clientHeight = 640 - composer.offsetHeight;
    transcript.scrollTop = Math.max(0, Math.min(transcript.scrollTop, transcript.scrollHeight - transcript.clientHeight));
  };
  const textarea = {
    style: { height: `${height}px` },
    value: "multiline draft",
    selectionStart: "multiline draft".length,
    scrollTop: 0,
    closest: (selector) => mounted && selector === ".chat-input-shell" ? composer : null,
    // A scrollHeight read flushes layout; the browser clamps ancestor scrolling immediately.
    get scrollHeight() { layout(); return Math.max(contentHeight, textareaHeight()); },
  };
  layout();
  transcript.scrollTop = transcript.scrollHeight - transcript.clientHeight;
  return { textarea, transcript, composer, layout };
}

test("the layout fixture reproduces native scroll clamping during an unprotected measurement", () => {
  const h = harness();
  const top = h.transcript.scrollTop;
  h.textarea.style.height = "auto";
  const height = h.textarea.scrollHeight;
  h.textarea.style.height = `${height}px`;
  h.layout();
  assert.ok(h.transcript.scrollTop < top, "restoring the same final height does not undo native clamping");
});

test("typing and the controlled-value resize preserve the tail when final height is unchanged", () => {
  const h = harness();
  const top = h.transcript.scrollTop;
  for (let i = 0; i < 4; i += 1) {
    resizeChatInput(h.textarea, true);
    h.layout();
    assert.equal(h.transcript.scrollTop, top);
    assert.equal(h.textarea.style.height, "132px");
    assert.equal(h.composer.style.minHeight, "");
  }
});

test("measurement preserves a detached reading position near the tail without forcing follow", () => {
  const h = harness();
  h.transcript.scrollTop -= 40;
  const top = h.transcript.scrollTop;
  resizeChatInput(h.textarea);
  h.layout();
  assert.equal(h.transcript.scrollTop, top);
});

test("a shortened draft releases the measuring constraint and clamps only to its final scroll range", () => {
  const h = harness({ contentHeight: 44 });
  resizeChatInput(h.textarea);
  h.layout();
  assert.equal(h.textarea.style.height, "44px");
  assert.equal(h.composer.style.minHeight, "");
  assert.equal(h.transcript.scrollTop, h.transcript.scrollHeight - h.transcript.clientHeight);
});

test("max-height drafts retain the 200px cap and keep the final caret line visible", () => {
  const h = harness({ height: 200, contentHeight: 440 });
  const top = h.transcript.scrollTop;
  resizeChatInput(h.textarea, true);
  h.layout();
  assert.equal(h.textarea.style.height, "200px");
  assert.equal(h.textarea.scrollTop, 440);
  assert.equal(h.transcript.scrollTop, top);
});

test("measurement restores existing composer constraints and does not move a middle caret", () => {
  const h = harness({ minHeight: "320px" });
  h.textarea.selectionStart = 3;
  h.textarea.scrollTop = 12;
  resizeChatInput(h.textarea, true);
  assert.equal(h.composer.style.minHeight, "320px");
  assert.equal(h.textarea.scrollTop, 12);
});

test("a detached textarea still resizes without a composer ancestor", () => {
  const h = harness({ contentHeight: 44, mounted: false });
  resizeChatInput(h.textarea);
  assert.equal(h.textarea.style.height, "44px");
});

test("restores, rewrites and completions use the shared measurement instead of collapsing independently", () => {
  const measurements = source.match(/\.style\.height = `\$\{Math\.min\(\w+\.scrollHeight/g) ?? [];
  assert.equal(measurements.length, 1, "only resizeChatInput may measure a collapsed textarea");
});
