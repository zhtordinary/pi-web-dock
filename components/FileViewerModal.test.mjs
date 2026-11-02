import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const agents = await readFile(new URL("./AgentsConfig.tsx", import.meta.url), "utf8");
const models = await readFile(new URL("./ModelsConfig.tsx", import.meta.url), "utf8");
const plugins = await readFile(new URL("./PluginsConfig.tsx", import.meta.url), "utf8");
const skills = await readFile(new URL("./SkillsConfig.tsx", import.meta.url), "utf8");
const fileViewer = await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8");

test("settings open-in-reader buttons are compact icon-only (22x22) with tooltip", () => {
  for (const [name, src] of [["agents", agents], ["models", models], ["plugins", plugins], ["skills", skills]]) {
    const openButtons = src.match(/width: 22,\s*height: 22,/g) ?? [];
    assert.ok(openButtons.length >= 1, `${name} has a compact open button`);
    const blocks = src.split("onOpenFile &&");
    for (let i = 1; i < blocks.length; i++) {
      const block = blocks[i].slice(0, blocks[i].indexOf("</button>") + 9);
      assert.ok(!/width: 24,\s*height: 24/.test(block), `${name} onOpenFile block no oversized button`);
    }
    assert.match(src, /title=\{t\("settings\.openInReaderTitle/);
  }
});

test("settings paths keep open buttons after short paths and shrink before them when long", () => {
  for (const [name, src] of [["models", models], ["plugins", plugins], ["skills", skills]]) {
    assert.match(src, /flex: "1 1 auto",[\s\S]{0,180}justifyContent: "flex-end"/, `${name} path row can use remaining width`);
    assert.match(src, /flex: "0 1 auto",[\s\S]{0,120}minWidth: 0,[\s\S]{0,120}overflow: "hidden"/, `${name} path shrinks before fixed controls`);
  }

  const skillDetail = skills.slice(skills.indexOf("function SkillDetail"), skills.indexOf("function AddSkillPanel"));
  assert.match(skillDetail, /displayPath\(skill\.filePath\)[\s\S]{0,120}<\/span>\s*\{onOpenFile &&/, "skill open button follows path in same flex row");
  assert.ok(!skillDetail.includes('flex: 1,\n            overflow: "hidden"'), "skill path no longer reserves button width in text span");
});

test("TextFileViewer open-in-reader is icon-only (no visible long label)", () => {
  const viewerBlock = fileViewer.slice(fileViewer.indexOf("function TextFileViewer("));
  assert.match(viewerBlock, /title=\{t\("files\.openInReaderView/);
  assert.ok(!/<span>在阅读视图里打开<\/span>/.test(viewerBlock), "no visible label pill in text viewer");
  assert.match(viewerBlock, /className="file-viewer-icon-button"/);
});
