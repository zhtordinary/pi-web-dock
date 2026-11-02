import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { ConfigSwitch } = await jiti.import("./SettingsUi.tsx");

test("the shared switch preserves state, action, loading and accessible labels", () => {
  const changes = [];
  const control = ConfigSwitch({ checked: false, label: "Enable profile", onChange: (checked) => changes.push(checked) });
  control.props.onClick();
  assert.deepEqual(changes, [true]);
  assert.equal(control.props["aria-checked"], false);
  assert.equal(control.props["aria-label"], "Enable profile");
  const busy = renderToStaticMarkup(React.createElement(ConfigSwitch, {
    checked: true, loading: true, label: "Enable profile", describedBy: "switch-note", onChange() {},
  }));
  assert.match(busy, /role="switch" aria-checked="true" aria-busy="true"/);
  assert.match(busy, /aria-describedby="switch-note"/);
  assert.match(busy, /disabled=""/);
  assert.match(busy, /class="config-switch is-loading"/);
});
