import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(new URL("./route.ts", import.meta.url), "utf8");

test("custom prompts API routes support GET, POST, and DELETE", () => {
  assert.match(route, /export async function GET/);
  assert.match(route, /export async function POST/);
  assert.match(route, /export async function DELETE/);
  assert.match(route, /readCustomPrompts/);
  assert.match(route, /getCustomPromptsFilePath/);
  assert.doesNotMatch(route, /allowFileRoot/);
  assert.match(route, /fileExists: existsSync\(filePath\)/);
  assert.match(route, /saveCustomPrompt/);
  assert.match(route, /deleteCustomPrompt/);
  assert.match(route, /reorderCustomPrompts/);
  assert.match(route, /Title or content is required/);
  assert.match(route, /Prompt id is required/);
});
