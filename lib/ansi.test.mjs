import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./ansi.ts");
}

test("strips ANSI escape sequences", async () => {
  const { stripAnsi } = await loadSubject();

  assert.equal(stripAnsi("\x1b[31mred\x1b[0m plain"), "red plain");
  assert.equal(stripAnsi("answer\x1b_pi:c\x07"), "answer");
});

test("normalizes boxed custom panel lines while preserving ANSI codes", async () => {
  const { normalizeCustomPanelLines, stripAnsi } = await loadSubject();
  const lines = [
    "┌──────┐",
    "│ \x1b[32mOK\x1b[0m   │",
    "└──────┘",
  ];

  const normalized = normalizeCustomPanelLines(lines);

  assert.equal(normalized.length, 1);
  assert.equal(stripAnsi(normalized[0]), "OK");
  assert.match(normalized[0], /\x1b\[32m/);
});

test("keeps pi-tui cursor markers at normalized cursor position", async () => {
  const { normalizeCustomPanelLines, stripAnsi } = await loadSubject();

  const [line] = normalizeCustomPanelLines(["> value\x1b_pi:c\x07"]);
  assert.equal(stripAnsi(line), "> value");
  assert.match(line, /value\x1b_pi:c\x07$/);

  const [boxedLine] = normalizeCustomPanelLines(["│ value\x1b_pi:c\x07 │"]);
  assert.equal(stripAnsi(boxedLine), "value");
  assert.match(boxedLine, /value\x1b_pi:c\x07$/);
});
