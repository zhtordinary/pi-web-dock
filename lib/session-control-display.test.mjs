import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { firstSessionControlDisplayText, sessionControlDisplayText } = await createJiti(import.meta.url).import("./session-control-display.ts");

test("uses the first visible session-control message as the title fallback", () => {
  const entries = [
    { type: "custom", customType: "pi-web:session-control-create", data: {} },
    { type: "custom_message", customType: "extension", display: true, content: "extension noise" },
    { type: "custom_message", customType: "pi-web:session-control-initial-message", display: true, content: "continue the interrupted task" },
    { type: "custom_message", customType: "pi-web:session-peer", display: true, content: "later peer message" },
  ];
  assert.equal(firstSessionControlDisplayText(entries), "continue the interrupted task");
});

test("hidden or empty session-control messages are not displayed", () => {
  assert.equal(sessionControlDisplayText({ type: "custom_message", customType: "pi-web:session-peer", display: false, content: "hidden" }), undefined);
  assert.equal(sessionControlDisplayText({ type: "custom_message", customType: "pi-web:session-peer", display: true, content: "  " }), undefined);
  assert.equal(sessionControlDisplayText({ type: "custom", customType: "pi-web:session-peer", display: true, content: "not a native message" }), undefined);
});
