import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { installEnglishTestLocale } from "./test-locale.mjs";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
await installEnglishTestLocale(jiti);
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { TurnWrittenFiles } = await jiti.import("./TurnWrittenFiles.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

function render(props) {
  return renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(TurnWrittenFiles, props)),
  );
}

test("renders a button per file showing the basename and full path", () => {
  const html = render({
    files: [{ filePath: "/abs/out/report.html" }, { filePath: "/abs/out/data.json" }],
    onOpenFile() {},
  });
  assert.match(html, /<button/);
  assert.match(html, /report\.html/);
  assert.match(html, /data\.json/);
  assert.match(html, /title="\/abs\/out\/report\.html"/);
  assert.match(html, /title="\/abs\/out\/data\.json"/);
});

test("renders nothing when no files were written", () => {
  assert.equal(render({ files: [], onOpenFile() {} }), "");
});

test("chip row is a contiguous interactive hit area (no dead-zone cursor flicker)", () => {
  const html = render({ files: [{ filePath: "/a/x.ts" }], onOpenFile() {} });
  // 容器 inline-flex 收缩到 chips，并带 cursor:pointer，chips 间的 gap 不再回退 default 箭头。
  assert.match(html, /style="display:inline-flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:6px;cursor:pointer"/);
});
