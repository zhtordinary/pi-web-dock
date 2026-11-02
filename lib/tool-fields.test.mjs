import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { toolFieldsOfInput } = await jiti.import("./tool-fields.ts");

test("flat scalar arguments become one row each, in input order", () => {
  assert.deepEqual(toolFieldsOfInput({ path: "/a/b.txt", offset: 10, limit: 20 }), [
    { key: "path", value: "/a/b.txt", multiline: false },
    { key: "offset", value: "10", multiline: false },
    { key: "limit", value: "20", multiline: false },
  ]);
});

test("null and booleans keep their JSON spelling", () => {
  assert.deepEqual(toolFieldsOfInput({ pattern: "a", replaceAll: false, before: null }), [
    { key: "pattern", value: "a", multiline: false },
    { key: "replaceAll", value: "false", multiline: false },
    { key: "before", value: "null", multiline: false },
  ]);
});

test("an empty string stays a visible empty value, not a dropped row", () => {
  assert.deepEqual(toolFieldsOfInput({ query: "" }), [{ key: "query", value: "", multiline: false }]);
});

test("a multi-line value keeps its line breaks", () => {
  assert.deepEqual(toolFieldsOfInput({ prompt: "line one\nline two" }), [
    { key: "prompt", value: "line one\nline two", multiline: true },
  ]);
});

test("nested objects and arrays fall back to JSON instead of dropping the subtree", () => {
  assert.equal(toolFieldsOfInput({ edits: [{ oldText: "a", newText: "b" }] }), null);
  assert.equal(toolFieldsOfInput({ options: { depth: 2 }, name: "x" }), null);
  assert.equal(toolFieldsOfInput({ calls: [] }), null);
});

test("non-object input has no field view", () => {
  assert.equal(toolFieldsOfInput(undefined), null);
  assert.equal(toolFieldsOfInput("text"), null);
  assert.equal(toolFieldsOfInput([]), null);
  assert.equal(toolFieldsOfInput({}), null);
});
