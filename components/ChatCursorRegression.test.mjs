import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [chatWindow, messageView, globalsCss] = await Promise.all([
  readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8"),
  readFile(new URL("./MessageView.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
]);

test("chat transcript keeps passive cursor stable and hover actions CSS-driven", () => {
  assert.match(chatWindow, /className="chat-transcript min-w-0 flex-1/);
  assert.match(messageView, /className=\{forking \? "chat-message chat-message-user is-forking"/);
  assert.match(messageView, /className="chat-message chat-message-assistant"/);
  assert.match(messageView, /className="chat-message-actions"/);
  assert.match(messageView, /className="chat-message-action"/);
  assert.doesNotMatch(messageView, /const \[hovered, setHovered\]/);
  assert.doesNotMatch(messageView, /pointerEvents: hovered/);

  assert.match(globalsCss, /\.chat-transcript[\s\S]*?cursor: default;/);
  assert.match(globalsCss, /\.chat-transcript \.markdown-body a,[\s\S]*?cursor: pointer;/);
  assert.match(globalsCss, /\.chat-transcript input,[\s\S]*?cursor: text;/);
  assert.match(globalsCss, /\.chat-message-actions,[\s\S]*?pointer-events: none;/);
  assert.match(globalsCss, /\.chat-message:hover \.chat-message-actions,[\s\S]*?\.chat-message:focus-within \.chat-message-actions/);
});
