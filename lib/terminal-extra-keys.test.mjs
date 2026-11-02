import assert from "node:assert/strict";
import test from "node:test";
import { applyTerminalModifiers, createTerminalExtraKeyInput, terminalExtraKeySequence } from "./terminal-extra-keys.ts";

test("extra keys honor application cursor mode and ANSI modifiers", () => {
  assert.equal(terminalExtraKeySequence("ArrowUp", { ctrl: false, alt: false }, true), "\x1bOA");
  assert.equal(terminalExtraKeySequence("ArrowLeft", { ctrl: true, alt: true }, true), "\x1b[1;7D");
  assert.equal(terminalExtraKeySequence("PageDown", { ctrl: true, alt: false }, false), "\x1b[6;5~");
  assert.equal(terminalExtraKeySequence("Home", { ctrl: false, alt: false }, true), "\x1b[H");
  assert.equal(terminalExtraKeySequence("Tab", { ctrl: false, alt: true }, false), "\x1b\t");
  assert.equal(terminalExtraKeySequence("/", { ctrl: true, alt: false }, false), "\x1f");
});

test("IME, paste, existing escape sequences and controls are not rewritten", () => {
  for (const data of ["\x1b[200~hello\x1b[201~", "中文", "中", "é", "😀", "\x1b[A", "\x03", "\x7f"]) {
    assert.equal(applyTerminalModifiers(data, { ctrl: true, alt: true }), data);
  }
  assert.equal(applyTerminalModifiers("c", { ctrl: true, alt: false }), "\x03");
});

function fixture() {
  let scope = 1;
  let enabled = true;
  let selected;
  const output = [];
  const input = createTerminalExtraKeyInput({ scope: () => scope, enabled: () => enabled, write: (data) => output.push(data), changed: (value) => { selected = value; } });
  return { input, output, setScope: (value) => { scope = value; }, setEnabled: (value) => { enabled = value; }, selected: () => selected };
}

test("modifier is consumed once, including unmodified pasted input", () => {
  const { input, output, selected } = fixture();
  input.toggle("ctrl"); input.data("c"); input.data("c");
  input.toggle("alt"); input.data("two letters"); input.data("x");
  assert.deepEqual(output, ["\x03", "c", "two letters", "x"]);
  assert.deepEqual(selected(), { ctrl: false, alt: false });
});

test("scope changes, disconnect and disposed callbacks cannot carry modifiers", () => {
  const f = fixture();
  f.input.toggle("ctrl"); f.setScope(2); f.input.data("c");
  f.input.toggle("alt"); f.setEnabled(false); f.input.data("x");
  f.setEnabled(true); f.input.data("x");
  f.input.toggle("ctrl"); f.input.dispose(); f.input.data("c"); f.input.key("ArrowUp", false); f.input.toggle("alt");
  assert.deepEqual(f.output, ["c", "x"]);
});

test("writer bindings stay separate even with the same terminal ID on another peer", () => {
  const old = fixture(); const next = fixture();
  old.input.toggle("ctrl"); old.setEnabled(false);
  next.input.data("c"); old.input.data("c");
  assert.deepEqual(next.output, ["c"]);
  assert.deepEqual(old.output, []);
});

test("DOM paste clear consumes modifiers before an unbracketed single character", () => {
  const { input, output } = fixture();
  input.toggle("alt"); input.clear(); input.data("x");
  input.toggle("ctrl"); input.clear(); input.data("c");
  assert.deepEqual(output, ["x", "c"]);
});

test("plain terminal typing does not schedule React modifier updates", () => {
  let updates = 0;
  const output = [];
  const input = createTerminalExtraKeyInput({ scope: () => 1, enabled: () => true, write: (s) => output.push(s), changed: () => { updates++; } });
  input.data("a"); input.data("b"); input.key("ArrowUp", false);
  assert.equal(updates, 0);
  input.toggle("ctrl"); input.data("c");
  assert.equal(updates, 2);
  input.data("d");
  assert.equal(updates, 2);
  assert.deepEqual(output, ["a", "b", "\x1b[A", "\x03", "d"]);
});
