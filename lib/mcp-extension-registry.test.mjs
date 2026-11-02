import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  clearMcpExtensionServers,
  forgetMcpExtensionServers,
  readMcpExtensionServers,
  recordMcpExtensionServers,
} = await jiti.import("./mcp-extension-registry.ts");

test.afterEach(() => clearMcpExtensionServers());

function entry(name = "notion", source = "/packages/pi-notion/extensions/index.ts") {
  return {
    name,
    source,
    scope: "extension",
    config: {
      url: "https://mcp.notion.com/mcp",
      exposure: "deferred",
      description: "Notion workspace",
    },
  };
}

test("records extension MCP servers without creating file-backed entries", () => {
  recordMcpExtensionServers("session-a", "/repo", [entry()]);
  assert.deepEqual(readMcpExtensionServers().map(({ name, sourcePath, cwd }) => ({ name, sourcePath, cwd })), [
    { name: "notion", sourcePath: "/packages/pi-notion/extensions/index.ts", cwd: "/repo" },
  ]);
});

test("keeps a shared registration while another session still owns it", () => {
  recordMcpExtensionServers("session-a", "/repo-a", [entry()]);
  recordMcpExtensionServers("session-b", "/repo-b", [entry()]);
  forgetMcpExtensionServers("session-a", "/repo-a");
  assert.equal(readMcpExtensionServers().length, 1);
  assert.equal(readMcpExtensionServers()[0].cwd, "/repo-b");
  forgetMcpExtensionServers("session-b", "/repo-b");
  assert.equal(readMcpExtensionServers().length, 0);
});
