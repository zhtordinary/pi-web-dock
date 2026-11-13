import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("right-panel tabs use a separate order and prune closed tabs", () => {
  assert.match(source, /import \{ movePanelTab, orderPanelTabs \} from "@\/lib\/panel-tab-order"/);
  assert.match(source, /const \[panelTabOrder, setPanelTabOrder\] = useState<string\[\]>\(\[\]\)/);
  assert.match(source, /const panelTabs = orderPanelTabs\(rawPanelTabs, panelTabOrder\)/);
  assert.match(source, /const next = current\.filter\(\(id\) => openIds\.has\(id\)\)/);
  assert.match(source, /onReorderTab=\{\(source, target, after\) => setPanelTabOrder/);
});
