import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false, tsconfigPaths: true });
const { createLoginOptions } = await jiti.import("./model-runtime.ts");

test("OAuth login options persist one isolated Pi installation device ID", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-web-oauth-device-"));
  try {
    const first = createLoginOptions(agentDir);
    const deviceId = first.options.getDeviceId();
    assert.match(deviceId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.equal(first.options.getDeviceId(), deviceId);
    await first.flush();

    const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
    assert.equal(settings.deviceId, deviceId);
    assert.equal(createLoginOptions(agentDir).options.getDeviceId(), deviceId);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
