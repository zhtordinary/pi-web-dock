import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
const syntax = ts.createSourceFile("ChatInput.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let resizeSource;
let effect;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "resizeChatInput") resizeSource = node.getText(syntax);
  if (ts.isCallExpression(node) && ["useEffect", "useLayoutEffect"].includes(node.expression.getText(syntax))
    && node.arguments[0]?.getText(syntax).includes("resizeChatInput(ta, ta.selectionStart === ta.value.length)")) effect = node;
  ts.forEachChild(node, visit);
}
visit(syntax);
function compile(code) {
  return ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

test("empty placeholder is resized after a width change without observing its own height writes", () => {
  let observer;
  const textarea = {
    value: "", selectionStart: 0, scrollHeight: 56, scrollTop: 0, style: {},
    closest: () => null,
    getBoundingClientRect: () => ({ width: 180 }),
  };
  const context = {
    CHAT_INPUT_MAX_HEIGHT: 200, textareaRef: { current: textarea },
    ResizeObserver: class {
      // eslint-disable-next-line @typescript-eslint/no-this-alias -- the test captures the observer the component constructs
      constructor(callback) { this.callback = callback; observer = this; }
      observe(target) { assert.equal(target, textarea); }
      disconnect() { this.disconnected = true; }
    },
  };
  vm.runInNewContext(compile(`${resizeSource}\nglobalThis.cleanup = (${effect.arguments[0].getText(syntax)})();`), context);
  assert.equal(textarea.style.height, "56px");
  assert.ok(observer, "width changes must trigger a new textarea measurement");
  textarea.scrollHeight = 30;
  observer.callback([{ contentRect: { width: 260 } }]);
  assert.equal(textarea.style.height, "30px", "a now single-line placeholder shrinks to the text row");
  textarea.scrollHeight = 90;
  observer.callback([{ contentRect: { width: 260 } }]);
  assert.equal(textarea.style.height, "30px", "height-only observer notifications do not create a resize loop");
  context.cleanup();
  assert.equal(observer.disconnected, true);
});

test("new-session bottom alignment follows keyboard visibility rather than retained focus", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /html\[data-keyboard-open\] \.new-session-container \{\s*justify-content: flex-end/);
  assert.doesNotMatch(css, /\.new-session-container:focus-within/);
});

test("placeholder geometry updates before paint when mobile metrics or placeholder content changes", () => {
  assert.equal(effect.expression.getText(syntax), "useLayoutEffect");
  const dependencies = effect.arguments[1].elements.map((node) => node.getText(syntax));
  for (const name of ["value", "draftKey", "isMobile", "inputPlaceholder"]) {
    assert.ok(dependencies.includes(name), `${name} affects textarea content or geometry`);
  }
});
