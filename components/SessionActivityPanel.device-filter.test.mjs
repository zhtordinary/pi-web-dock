import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const panelPath = fileURLToPath(new URL("./SessionActivityPanel.tsx", import.meta.url));
const source = readFileSync(panelPath, "utf8");
const panel = source.slice(source.indexOf("export function SessionActivityPanel"), source.indexOf("export function SessionActivitySidebar"));
const row = source.slice(source.indexOf("function SessionActivityRow"), source.indexOf("function SessionActivitySidebarRow"));

test("activity panel header keeps sidebar filter order", () => {
  const device = panel.indexOf('activityScope !== "local"');
  const archive = panel.indexOf('ariaLabel={t("sessionActivity.archiveView")}', device);
  const newProject = panel.indexOf("<NewProjectButton onRefresh={activity.refresh}", archive);
  assert.ok(device >= 0 && device < archive && archive < newProject);
});

test("expanded recap renders body without repeating title", () => {
  assert.match(row, /const recapDisplay = sessionRecapDisplay\(item\.lastRecap\)/);
  assert.match(row, /recapDisplay\.body \|\| t\("sessionActivity\.noRecap"\)/);
  assert.doesNotMatch(row, /item\.lastRecap\?\.title|recapDisplay\.title/);
});

test("compact filters preserve content-sized menu widths", () => {
  const filter = source.slice(source.indexOf("function FilterSelect("), source.indexOf("type ActivityProjectInfo"));
  assert.doesNotMatch(filter, /menuMinWidth=/);
  const floatingSource = readFileSync(new URL("./ReaderFloatingSelect.tsx", import.meta.url), "utf8");
  assert.match(floatingSource, /menuMinWidth = "max-content"/);
  assert.match(floatingSource, /width: "max-content"/);
});

test("floating menus use the viewport height rather than clipping a short option list", () => {
  const floatingSource = readFileSync(new URL("./ReaderFloatingSelect.tsx", import.meta.url), "utf8");
  assert.match(floatingSource, /maxHeight: "calc\(100dvh - 16px\)"/);
  assert.match(floatingSource, /overflowY: "auto"/);
});

test("keeps panel and activity-sidebar empty states behind data loading", () => {
  assert.equal(
    (source.match(/!activity\.loading && activity\.data && activity\.groups\.length === 0/g) ?? []).length,
    2,
  );
});
