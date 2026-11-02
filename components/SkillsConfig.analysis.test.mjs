import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { SkillAnalysisStatus } = await jiti.import("./SkillsConfig.tsx");
const t = (key, params) => `${key} ${JSON.stringify(params ?? {})}`;
const failures = [{ filePath: "/skills/cua-driver/SKILL.md", name: "cua-driver", reason: "model resolution timeout" }, { filePath: "/skills/grilling/SKILL.md", name: "grilling", reason: "model offline" }];
const job = { status: "completed", completed: 33, total: 33, failed: 2, failures };
function render(props) { return renderToStaticMarkup(createElement(SkillAnalysisStatus, { job, canRetry: true, onRetry() {}, t, ...props })); }

test("partial failure shows all completed progress, skill names and causes without clipping", () => {
  const html = render();
  assert.match(html, /&quot;completed&quot;:33/);
  assert.match(html, /&quot;succeeded&quot;:31/);
  assert.match(html, /&quot;failed&quot;:2/);
  assert.match(html, /cua-driver/);
  assert.match(html, /grilling/);
  assert.match(html, /model resolution timeout/);
  assert.match(html, /model offline/);
  assert.match(html, /<details/);
  assert.match(html, /skillAnalysisRetryFailed/);
  assert.doesNotMatch(html, /text-overflow:ellipsis|max-width:240px/);
});

test("legacy job failure counts are honest about unavailable per-skill details", () => {
  const html = render({ job: { ...job, failures: undefined } });
  assert.match(html, /skillAnalysisLegacyFailures/);
  assert.doesNotMatch(html, /cua-driver|grilling|skillAnalysisRetryFailed/);
});

test("request errors retain the last real progress, and a missing job creates no fake result", () => {
  assert.match(render({ requestError: "network unavailable" }), /succeeded/);
  const html = render({ job: null, requestError: "network unavailable" });
  assert.match(html, /network unavailable/);
  assert.doesNotMatch(html, /skillAnalysisResult/);
});

test("retry is disabled while the same job is still running", () => {
  assert.match(render({ job: { ...job, status: "running" } }), /<button[^>]*disabled=""/);
});

test("failure note is an icon-only floating annotation tooltip and not displayed inline", () => {
  const html = render({ job: { ...job, error: "model unavailable" } });
  assert.match(html, /title="i18n\.skillAnalysisFailed/);
  assert.match(html, /aria-label="i18n\.skillAnalysisFailed/);
  assert.match(html, /<span aria-hidden="true">⚠️<\/span><\/span>/);
  assert.doesNotMatch(html, />i18n\.skillAnalysisFailed/);
});
