import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { NoticeShelf } = await jiti.import("./NoticeShelf.tsx");

function renderNotice(message) {
  return renderToStaticMarkup(
    React.createElement(NoticeShelf, {
      notices: [{ id: "notice-1", message, type: "info" }],
    }),
  );
}

test("renders multiline notifications as a scrollable preformatted panel", () => {
  const html = renderNotice("line one\nline two");

  assert.match(html, /white-space:pre-wrap/);
  assert.match(html, /max-height:360px/);
  assert.match(html, /overflow-y:auto/);
  assert.match(html, /line one\nline two/);
  assert.doesNotMatch(html, /text-overflow:ellipsis/);
});

test("keeps single-line notifications compact and ellipsized", () => {
  const html = renderNotice("one line");

  assert.match(html, /white-space:nowrap/);
  assert.match(html, /text-overflow:ellipsis/);
  assert.doesNotMatch(html, /white-space:pre-wrap/);
  assert.doesNotMatch(html, /max-height:360px/);
});

test("floating shelf enables text selection and hover pause wiring", () => {
  const html = renderToStaticMarkup(
    React.createElement(NoticeShelf, {
      notices: [{ id: "notice-1", message: "hello", type: "info" }],
      floating: true,
      onHoverChange: () => {},
      onDismissOutside: () => {},
    }),
  );

  assert.match(html, /pointer-events:auto/);
  assert.match(html, /user-select:text/);
  assert.match(html, /width:fit-content/);
});
