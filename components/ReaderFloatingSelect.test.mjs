import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { ReaderFloatingSelect } = await jiti.import("./ReaderFloatingSelect.tsx");
const source = await readFile(new URL("./ReaderFloatingSelect.tsx", import.meta.url), "utf8");

function trigger(props = {}) {
  return renderToStaticMarkup(React.createElement(ReaderFloatingSelect, {
    value: "direct", options: [{ value: "direct", label: "Direct tools" }],
    ariaLabel: "Tools", onChange() {}, ...props,
  }));
}

test("field selectors share the floating menu while preserving labels, validation and disabled state", () => {
  const html = trigger({ appearance: "field", describedBy: "reason", ariaInvalid: true, disabled: true });
  assert.match(html, /aria-label="Tools" aria-describedby="reason" aria-invalid="true" aria-haspopup="listbox" aria-expanded="false" disabled=""/);
  assert.match(html, /height:32px/);
  assert.match(html, /background:var\(--bg-panel\)/);
  assert.match(html, /Direct tools/);
  assert.doesNotMatch(html, /<select\b/);
  const compact = trigger({ appearance: "field", triggerStyle: { height: 22 } });
  assert.match(compact, /height:22px/);
  assert.doesNotMatch(trigger(), /background:var\(--bg-panel\)/, "existing toolbar controls retain their appearance");
});

test("floating options retain disabled guards and return focus before saving", () => {
  assert.match(source, /if \(disabled \|\| option.disabled \|\| option.kind === "group"\) return;/);
  assert.match(source, /close\(\);\s*triggerRef.current\?\.focus\(\);\s*props.onChange\(option.value\)/);
  assert.match(source, /disabled=\{option.disabled\}/);
});

test("all Reader dropdown definitions reuse the shared menu instead of OS-native popups", async () => {
  for (const name of await readdir(new URL("./", import.meta.url))) {
    if (!name.endsWith(".tsx")) continue;
    const text = await readFile(new URL(name, import.meta.url), "utf8");
    assert.doesNotMatch(text, /<select\b/, `${name} must reuse ReaderFloatingSelect`);
  }
});
