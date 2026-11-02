import assert from "node:assert/strict";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";

const SERVER = path.resolve(import.meta.dirname, "..", "server.mjs");

test("read-only Reader MCP speaks stdio and reports bounded local inventory", async (t) => {
  const fixture = await createFixture();
  t.after(() => removeTree(fixture.root));

  const before = await snapshotTree(fixture.root);
  const client = startClient(fixture.root);
  t.after(() => client.close());

  const initialized = await client.call("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "fixture-client", version: "1.0.0" },
  });
  assert.equal(initialized.protocolVersion, "2025-11-25");
  assert.equal(initialized.capabilities.tools.listChanged, false);
  assert.equal(initialized.capabilities.experimental["reader.snapshot"].bounded, true);
  assert.equal(initialized.capabilities.experimental["reader.liveEvents"].gapRecovery, "reader-required");
  assert.equal(initialized.capabilities.experimental["reader.control"].dryRunDefault, true);
  assert.equal(initialized.capabilities.experimental["reader.controlPlane"].transport, "GET-only");
  assert.equal(initialized.capabilities.experimental["reader.controlPlane"].remote, "unsupported until Reader exposes a registered remote control-plane route");
  assert.equal(initialized.capabilities.experimental["reader.writeControlPlane"].dryRunDefault, true);
  assert.equal(initialized.capabilities.experimental["reader.writeControlPlane"].receiptTool, "reader_get_control_plane_receipt");
  await client.notify("notifications/initialized", {});

  const listedTools = await client.call("tools/list", {});
  assert.deepEqual(
    listedTools.tools.map((tool) => tool.name),
    ["reader_list_sessions", "reader_get_session_metadata", "reader_read_tail", "reader_read_live_events", "reader_session_control", "reader_read_control_plane", "reader_write_control_plane", "reader_get_control_plane_receipt", "reader_get_session_control_receipt"],
  );

  const inventory = await client.tool("reader_list_sessions", { scope: "both", limit: 500 });
  assert.equal(inventory.schemaVersion, 1);
  assert.equal(inventory.result.sessions.length, inventory.sessions.length);
  assert.equal(inventory.device, "fixture-mac-mini");
  assert.equal(inventory.coverage.localOnly, true);
  assert.equal(inventory.coverage.readerUiEquivalent, false);
  assert.equal(inventory.coverage.hiddenStateApplied, false);
  assert.equal(inventory.coverage.runtimeSessionsIncluded, false);
  assert.equal(inventory.coverage.scanTruncated, false);
  assert.equal(inventory.coverage.directories.reduce((sum, scope) => sum + scope.sessionRowsProduced, 0), 6);
  assert.equal(inventory.coverage.directories.reduce((sum, scope) => sum + scope.filesRejected, 0), 1);
  assert.deepEqual(
    inventory.sessions.map((session) => session.id).sort(),
    ["active-001", "archived-001", "duplicate-001", "duplicate-001", "long-001", "named-debian-empty"].sort(),
  );
  assert.ok(inventory.sessions.every((session) => session.runtimeStatus === "unknown"));
  assert.ok(inventory.sessions.every((session) => session.lastActivitySource === "filesystem mtime only"));
  const empty = inventory.sessions.find((session) => session.id === "named-debian-empty");
  assert.equal(empty.project, "project");
  assert.equal(empty.observedMessageCount, 0);
  assert.equal(empty.lastProgress, null);
  assert.equal(empty.observationTruncated, false);

  const projectFiltered = await client.tool("reader_list_sessions", { scope: "active", project: "demo", limit: 10 });
  assert.deepEqual(projectFiltered.sessions.map((session) => session.id).sort(), ["active-001", "duplicate-001"]);
  const unsupportedLocalFilter = await client.tool("reader_list_sessions", { scope: "active", device: "another-device" });
  assert.equal(unsupportedLocalFilter.__toolError, true);
  assert.match(unsupportedLocalFilter.error, /require PI_WEB_READER_URL/);

  const metadata = await client.tool("reader_get_session_metadata", { sessionId: "active-001", scope: "active" });
  assert.equal(metadata.session.runtimeStatus, "unknown");
  assert.equal(metadata.fileObservation.exists, true);
  assert.equal(metadata.fileObservation.lastActivitySource, "filesystem mtime only");
  assert.equal(metadata.runtimeStatusSemantics.runtimeChecked, false);
  assert.equal(metadata.runtimeStatusSemantics.idleDoesNotMeanComplete, true);

  const tail = await client.tool("reader_read_tail", { sessionId: "active-001", scope: "active", maxEntries: 10, maxBytes: 16 * 1024 });
  assert.equal(tail.session.id, "active-001");
  assert.equal(tail.entries.length, 2);
  assert.match(tail.entries.at(-1).text, /Progress/);

  const longTail = await client.tool("reader_read_tail", { sessionId: "long-001", scope: "active", maxEntries: 1, maxBytes: 16 * 1024 });
  assert.equal(longTail.entries.length, 1);
  assert.ok(longTail.entries[0].text.length <= 600);
  assert.match(longTail.entries[0].text, /…$/);
  const byteLimitedTail = await client.tool("reader_read_tail", { sessionId: "long-001", scope: "active", maxEntries: 1, maxBytes: 4096 });
  assert.ok(byteLimitedTail.bytesRead <= 4096);
  assert.equal(byteLimitedTail.truncatedByBytes, true);

  await client.close();
  const after = await snapshotTree(fixture.root);
  assert.deepEqual(after, before, "MCP inventory calls must not mutate the fixture tree");
  assert.equal(client.stderr.trim(), "");
});

test("control-plane reads use allowlisted GET routes with exact device/cwd/scope boundaries", async (t) => {
  const reader = await createMockReaderServer({ onlineRemote: true });
  t.after(() => reader.close());
  const client = startClient(undefined, { url: reader.url });
  t.after(() => client.close());
  await client.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "control-plane-test", version: "1" } });

  const models = await client.tool("reader_read_control_plane", {
    area: "models",
    deviceId: "dev-a",
    cwd: "/tmp/project",
  });
  assert.equal(models.outcome, "observed");
  assert.equal(models.binding.deviceId, "dev-a");
  assert.equal(models.binding.cwd, undefined);
  assert.equal(models.binding.cwdRef, createHash("sha256").update(JSON.stringify("/tmp/project")).digest("hex"));
  assert.equal(models.binding.sessionId, null);
  assert.equal(models.binding.route, "/api/models");
  assert.equal(models.request.method, "GET");
  assert.deepEqual(models.data.models[0], { provider: "fixture", id: "model-a", name: "Fixture model" });

  const enabledModels = await client.tool("reader_read_control_plane", {
    area: "models_enabled",
    deviceId: "dev-a",
    cwd: "/tmp/project",
  });
  assert.equal(enabledModels.outcome, "observed");
  assert.deepEqual(enabledModels.data.patterns, ["fixture/*"]);

  const modelConfig = await client.tool("reader_read_control_plane", {
    area: "models_config",
    deviceId: "dev-a",
  });
  assert.equal(modelConfig.outcome, "observed");
  assert.equal(modelConfig.data.providers[0].apiKey, undefined);

  const skills = await client.tool("reader_read_control_plane", {
    area: "skills",
    deviceId: "dev-a",
    cwd: "/tmp/project",
    scope: "global",
  });
  assert.equal(skills.outcome, "observed");
  assert.equal(skills.binding.scope, "global");
  assert.equal(skills.request.query.scope, "global");

  const plugins = await client.tool("reader_read_control_plane", {
    area: "plugins",
    deviceId: "dev-a",
    cwd: "/tmp/project",
    scope: "project",
  });
  assert.equal(plugins.outcome, "observed");
  assert.equal(plugins.request.query.scope, "project");

  const settings = await client.tool("reader_read_control_plane", {
    area: "tools_settings",
    deviceId: "dev-a",
  });
  assert.equal(settings.outcome, "observed");
  assert.equal(settings.binding.cwd, null);
  assert.equal(settings.data.codemode, true);

  const catalog = await client.tool("reader_read_control_plane", {
    area: "models_catalog",
    deviceId: "dev-a",
    provider: "fixture",
    q: "model",
    limit: 10,
  });
  assert.equal(catalog.outcome, "observed");
  assert.equal(catalog.request.query.provider, "fixture");
  assert.equal(catalog.request.query.q, "model");
  assert.equal(catalog.request.query.limit, "10");

  const subagents = await client.tool("reader_read_control_plane", {
    area: "subagents",
    deviceId: "dev-a",
  });
  assert.equal(subagents.outcome, "observed");
  assert.deepEqual(subagents.data.runningSessionIds, ["active-001"]);

  const mcp = await client.tool("reader_read_control_plane", {
    area: "mcp",
    deviceId: "dev-a",
    cwd: "/tmp/project",
  });
  assert.equal(mcp.outcome, "observed");
  assert.equal(mcp.request.query.cwd, undefined);
  assert.match(mcp.request.query.cwdRef, /^[a-f0-9]{64}$/);

  const beforeInvalid = reader.requests.length;
  const missingCwd = await client.tool("reader_read_control_plane", { area: "models", deviceId: "dev-a" });
  assert.equal(missingCwd.__toolError, true);
  assert.match(missingCwd.error, /requires an explicit cwd/);
  const wrongType = await client.tool("reader_read_control_plane", { area: "skills", deviceId: "dev-a", cwd: "/tmp/project", scope: 1 });
  assert.equal(wrongType.__toolError, true);
  assert.match(wrongType.error, /scope must be a string/);
  const badLimit = await client.tool("reader_read_control_plane", { area: "models_catalog", deviceId: "dev-a", limit: 101 });
  assert.equal(badLimit.__toolError, true);
  assert.match(badLimit.error, /above the maximum/);
  const unknown = await client.tool("reader_read_control_plane", { area: "models", deviceId: "dev-a", cwd: "/tmp/project", nope: true });
  assert.equal(unknown.__toolError, true);
  assert.match(unknown.error, /does not accept argument/);
  assert.equal(reader.requests.length, beforeInvalid);

  const remote = await client.tool("reader_read_control_plane", { area: "tools_settings", deviceId: "dev-b" });
  assert.equal(remote.outcome, "unsupported");
  assert.equal(remote.code, "remote_control_plane_route_unavailable");
  assert.equal(reader.requests.some((request) => request.path === "/api/tools/settings" && request.query.peer), false);

  const controlPlaneRequests = reader.requests.filter((request) => request.path !== "/api/reader/session-catalog");
  assert.ok(controlPlaneRequests.length >= 6);
  assert.ok(controlPlaneRequests.every((request) => request.method === "GET"));
  assert.equal(controlPlaneRequests.some((request) => request.path === "/api/agent/new" || request.method === "POST"), false);

  await client.close();
});


test("models_config stdio read omits model authentication headers beyond the public depth boundary", async (t) => {
  const modelsConfigBody = {
    providers: {
      fixture: {
        name: "Ordinary provider",
        apiKey: "SYNTHETIC_PROVIDER_KEY",
        models: [{
          id: "fixture-model",
          name: "Ordinary model",
          contextWindow: 12345,
          headers: {
            Authorization: "Bearer SYNTHETIC_MODEL_AUTH",
            "x-api-key": "SYNTHETIC_MODEL_KEY",
            "x-client-version": "ordinary-version",
            note: '{"password":"SYNTHETIC_MODEL_TEXT","status":"ok"}',
            extra: { nested: { authorization: "SYNTHETIC_DEEP_OBJECT" } },
            items: [{ token: "SYNTHETIC_DEEP_ARRAY" }],
          },
        }],
      },
    },
    ordinary: { enabled: true, count: 3, label: "unchanged", nullable: null },
  };
  const reader = await createMockReaderServer({ modelsConfigBody });
  t.after(() => reader.close());
  const client = await managedClient(t, reader);
  const wire = await client.call("tools/call", { name: "reader_read_control_plane", arguments: { area: "models_config", deviceId: "dev-a" } });
  assert.equal(wire.isError, false);
  assert.doesNotMatch(JSON.stringify(wire), /SYNTHETIC_/);
  const config = JSON.parse(wire.content[0].text);
  assert.equal(config.outcome, "observed");
  const provider = config.data.providers.fixture;
  assert.equal(Object.hasOwn(provider, "apiKey"), false);
  assert.equal(provider.name, "Ordinary provider");
  const model = provider.models[0];
  assert.equal(model.id, "fixture-model");
  assert.equal(model.name, "Ordinary model");
  assert.equal(model.contextWindow, 12345);
  assert.deepEqual(model.headers, {
    "x-client-version": "ordinary-version",
    note: '{"password":"[REDACTED]","status":"ok"}',
    extra: "[TRUNCATED]",
    items: "[TRUNCATED]",
  });
  assert.deepEqual(config.data.ordinary, modelsConfigBody.ordinary);
  assert.equal(reader.requests.filter((request) => request.path === "/api/models-config").length, 1);
  assert.ok(reader.requests.every((request) => request.method === "GET"));
});

test("public projection keeps depth limits fail-closed for objects arrays and strings through stdio", async (t) => {
  let modelsConfigBody;
  const reader = await createMockReaderServer({ modelsConfigBody: () => modelsConfigBody });
  t.after(() => reader.close());
  const client = await managedClient(t, reader);
  const wrap = (value, depth) => {
    for (let index = 0; index < depth; index += 1) value = { child: value };
    return value;
  };
  const unwrap = (value, depth) => {
    for (let index = 0; index < depth; index += 1) value = value.child;
    return value;
  };
  const samples = [
    { input: { authorization: "SYNTHETIC_OBJECT", filePath: "SYNTHETIC_PATH", safe: "ordinary leaf" }, expected: { safe: "ordinary leaf" }, collection: true },
    { input: ["ordinary element", "password=SYNTHETIC_ARRAY_TEXT"], expected: ["ordinary element", "password=[REDACTED]"], collection: true },
    { input: '{"token":"SYNTHETIC_STRING","safe":"ordinary text"}', expected: '{"token":"[REDACTED]","safe":"ordinary text"}' },
    { input: "normal ".repeat(200), expected: `${"normal ".repeat(200).trim().slice(0, 599)}…` },
    { input: true, expected: true },
    { input: 42, expected: 42 },
    { input: null, expected: null },
  ];
  for (const depth of [4, 5, 6, 7, 10]) {
    for (const sample of samples) {
      modelsConfigBody = wrap(sample.input, depth);
      const result = await client.tool("reader_read_control_plane", { area: "models_config", deviceId: "dev-a" });
      assert.equal(result.outcome, "observed");
      assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_/, `depth ${depth} must not return an unprocessed leaf or subtree`);
      if (depth > 6 || (depth === 6 && sample.collection)) {
        assert.equal(unwrap(result.data, 6), "[TRUNCATED]");
      } else {
        assert.deepEqual(unwrap(result.data, depth), sample.expected, `depth ${depth} must retain safe scalar content and redact recognized fields`);
      }
    }
  }
  assert.equal(reader.requests.filter((request) => request.path === "/api/models-config").length, 35);
  assert.ok(reader.requests.every((request) => request.method === "GET"));
});

test("managed control-plane dry-run validates through Reader without mutation or receipt", async (t) => {
  const reader = await createMockReaderServer({ onlineRemote: true });
  t.after(() => reader.close());
  const client = await managedClient(t, reader);
  const snapshot = await client.tool("reader_read_control_plane", { area: "tools_settings", managed: true, deviceId: "dev-a", scope: "global" });
  assert.equal(snapshot.outcome, "observed");
  assert.equal(snapshot.revision, "config-revision-1");
  assert.equal(snapshot.bootId, "config-boot-1");
  assert.equal(snapshot.binding.scope, "global");
  assert.equal(snapshot.data.apiKey, undefined);
  const dry = await client.tool("reader_write_control_plane", managedWrite({ dryRun: true }));
  assert.equal(dry.outcome, "dry_run");
  assert.equal(dry.validated, true);
  assert.equal(dry.sideEffect, "none");
  assert.equal(dry.readerReceipt, undefined);
  assert.equal(dry.request.route, "/api/reader/control-plane");
  assert.equal(reader.requests.filter((request) => request.method === "POST").length, 1);
  assert.equal(reader.requests.find((request) => request.method === "POST").body.dryRun, true);
  const alias = await client.tool("reader_read_control_plane", { area: "models_default", deviceId: "dev-a", scope: "global", cwd: "/tmp/project" });
  assert.equal(alias.managed, true);
  const remote = await client.tool("reader_write_control_plane", managedWrite({ deviceId: "dev-b" }));
  assert.equal(remote.code, "remote_control_plane_route_unavailable");
  assert.equal(reader.requests.filter((request) => request.method === "POST").length, 1);
  const receipt = await client.tool("reader_get_control_plane_receipt", { area: "tools_settings", scope: "global", deviceId: "dev-a", operation: "set_codemode", idempotencyKey: "managed-config-001" });
  assert.equal(receipt.code, "receipt_not_found");
  assert.equal(receipt.outcome, "unknown");
  const unchanged = await client.tool("reader_read_control_plane", { area: "tools_settings", managed: true, scope: "global", deviceId: "dev-a" });
  assert.equal(unchanged.revision, snapshot.revision);
});

test("managed dry-run reports Reader validation rejection without claiming preparation success", async (t) => {
  const reader = await createMockReaderServer({ managedDryRunRejected: true });
  t.after(() => reader.close());
  const client = await managedClient(t, reader);
  const result = await client.tool("reader_write_control_plane", managedWrite({ dryRun: true }));
  assert.equal(result.outcome, "blocked");
  assert.equal(result.code, "invalid_config_change");
  assert.equal(result.validated, undefined);
  assert.equal(result.readerReceipt, undefined);
  const receipt = await client.tool("reader_get_control_plane_receipt", { area: "tools_settings", scope: "global", deviceId: "dev-a", operation: "set_codemode", idempotencyKey: "managed-config-001" });
  assert.equal(receipt.code, "receipt_not_found");
  assert.equal(receipt.outcome, "unknown");
});

test("managed writes enforce confirmation revision boot and bounded fields before routing", async (t) => {
  const reader = await createMockReaderServer();
  t.after(() => reader.close());
  const client = await managedClient(t, reader);
  for (const field of ["scope", "confirm", "confirmationReason", "idempotencyKey", "expectedRevision", "expectedBootId"]) {
    const args = managedWrite(); delete args[field];
    const result = await client.tool("reader_write_control_plane", args);
    assert.equal(result.__toolError, true, field);
  }
  for (const patch of [{ confirm: "true" }, { confirmationReason: "  " }, { credentials: "rejected" }, { operation: "install" }, { expectedQueueRevision: "x" }]) {
    assert.equal((await client.tool("reader_write_control_plane", managedWrite(patch))).__toolError, true);
  }
  const nested = await client.tool("reader_write_control_plane", managedWrite({ area: "model_routing", operation: "replace", enabled: true, routes: [{ id: "r1", provider: "fixture", model: "m", thinkingLevel: "high", apiKey: "not-allowed" }], codemode: undefined }));
  assert.equal(nested.__toolError, true);
  assert.equal(reader.requests.length, 0);
});

test("managed POST uses only the unified route and Reader durable replay survives adapter restart", async (t) => {
  const reader = await createMockReaderServer();
  t.after(() => reader.close());
  const first = await managedClient(t, reader);
  const written = await first.tool("reader_write_control_plane", managedWrite());
  assert.equal(written.outcome, "completed");
  assert.equal(written.readerReceipt.receiptId, "config-receipt-1");
  const post = reader.requests.find((request) => request.method === "POST");
  assert.equal(post.path, "/api/reader/control-plane");
  assert.equal(post.headers["x-pi-reader-control-caller"], "reader-mcp");
  assert.deepEqual(post.body.changes, { codemode: "always" });
  assert.equal(post.body.expectedRevision, "config-revision-1");
  assert.equal(post.body.expectedBootId, "config-boot-1");
  assert.equal(post.body.confirm, true);
  assert.match(post.body.requestFingerprint, /^[0-9a-f]{64}$/);
  await first.close();
  const second = await managedClient(t, reader);
  const replay = await second.tool("reader_write_control_plane", managedWrite());
  assert.equal(replay.replayed, true);
  assert.equal(replay.readerReceipt.receiptId, written.readerReceipt.receiptId);
  const conflict = await second.tool("reader_write_control_plane", managedWrite({ codemode: "automatic" }));
  assert.equal(conflict.code, "idempotency_conflict");
  assert.equal(conflict.outcome, "conflict");
  assert.equal(conflict.sideEffect, "none");
  const receipt = await second.tool("reader_get_control_plane_receipt", { area: "tools_settings", deviceId: "dev-a", scope: "global", operation: "set_codemode", idempotencyKey: "managed-config-001" });
  assert.equal(receipt.outcome, "completed");
  assert.equal(receipt.readerReceipt.receiptId, written.readerReceipt.receiptId);
  const byId = await second.tool("reader_get_control_plane_receipt", { area: "tools_settings", deviceId: "dev-a", scope: "global", receiptId: written.readerReceipt.receiptId });
  assert.equal(byId.outcome, "completed");
  assert.equal(reader.requests.filter((request) => request.method === "POST").every((request) => request.path === "/api/reader/control-plane"), true);
});

test("managed Reader rejection and unknown transport outcomes remain explicit and never auto-retry", async (t) => {
  const reader = await createMockReaderServer({ managedDisconnect: true });
  t.after(() => reader.close());
  const client = await managedClient(t, reader);
  const stale = await client.tool("reader_write_control_plane", managedWrite({ expectedRevision: "stale", idempotencyKey: "managed-config-stale" }));
  assert.equal(stale.code, "revision_conflict");
  const boot = await client.tool("reader_write_control_plane", managedWrite({ expectedBootId: "stale", idempotencyKey: "managed-config-boot" }));
  assert.equal(boot.code, "boot_changed");
  const denied = await client.tool("reader_write_control_plane", managedWrite({ idempotencyKey: "managed-config-denied", cwd: "/forbidden" }));
  assert.equal(denied.code, "access_denied");
  const unknown = await client.tool("reader_write_control_plane", managedWrite());
  assert.equal(unknown.outcome, "unknown");
  assert.equal(unknown.retryPolicy, "never-auto-retry-unknown");
  assert.equal(reader.requests.filter((request) => request.method === "POST" && request.body.idempotencyKey === "managed-config-001").length, 1);
  const receipt = await client.tool(unknown.receiptLookup.tool, unknown.receiptLookup.arguments);
  assert.equal(receipt.outcome, "completed");
});

test("managed missing route malformed binding and unsupported operations fail closed", async (t) => {
  for (const options of [{ managedUnavailable: true }, { managedWrongBinding: true }]) {
    const reader = await createMockReaderServer(options);
    t.after(() => reader.close());
    const client = await managedClient(t, reader);
    const result = await client.tool("reader_write_control_plane", managedWrite({ dryRun: true }));
    assert.equal(result.code, options.managedUnavailable ? "reader_route_unavailable" : "reader_contract_mismatch");
    assert.equal(reader.requests.some((request) => request.method === "POST"), false);
  }
  const reader = await createMockReaderServer();
  t.after(() => reader.close());
  const client = await managedClient(t, reader);
  const result = await client.tool("reader_write_control_plane", managedWrite({ area: "models_config", operation: "set_model_metadata", provider: "fixture", modelId: "model-1", name: "Fixture", dryRun: true }));
  assert.equal(result.code, "unsupported_operation");
  const remote = await client.tool("reader_get_control_plane_receipt", { area: "tools_settings", deviceId: "dev-a", scope: "global" });
  assert.equal(remote.__toolError, true);
  const legacyReader = await createMockReaderServer({ managedReceiptMissing404: true });
  t.after(() => legacyReader.close());
  const legacy = await managedClient(t, legacyReader);
  const missing = await legacy.tool("reader_get_control_plane_receipt", { area: "tools_settings", deviceId: "dev-a", scope: "global", receiptId: "absent" });
  assert.equal(missing.outcome, "unknown");
  assert.equal(missing.code, "receipt_not_found");
});

test("a missing managed receipt stays unknown for current and legacy Reader responses without writing", async (t) => {
  for (const options of [{}, { managedReceiptLegacyOutcome: true }, { managedReceiptMissing404: true }]) {
    const reader = await createMockReaderServer(options); t.after(() => reader.close());
    const client = await managedClient(t, reader);
    const missing = await client.tool("reader_get_control_plane_receipt", { area: "tools_settings", deviceId: "dev-a", scope: "global", receiptId: "absent" });
    assert.equal(missing.outcome, "unknown"); assert.equal(missing.code, "receipt_not_found");
    assert.equal(missing.nextAction, "verify_original_target_and_key_before_retry");
    assert.equal(reader.requests.some(request => request.method !== "GET"), false);
  }
});

test("managed fixed configuration fields reach Reader without raw payload or credential access", async (t) => {
  const reader = await createMockReaderServer();
  t.after(() => reader.close());
  const client = await managedClient(t, reader);
  const cases = [
    { area: "models_default", operation: "set_default", cwd: "/tmp/project", provider: "fixture", modelId: "m" },
    { area: "models_enabled", operation: "set_models", cwd: "/tmp/project", refs: ["fixture/m"], enabled: true },
    { area: "skills_policy", operation: "set_skill_invocation_mode", cwd: "/tmp/project", policyKey: "fixture", mode: "explicit-only" },
    { area: "skills_policy", operation: "set_global_skill_resource", cwd: "/tmp/project", resourceId: "resource_" + "a".repeat(64), enabled: false },
    { area: "skills_policy", operation: "set_plugin_skill", cwd: "/tmp/project", resourceId: "resource_" + "b".repeat(64), enabled: false },
    { area: "plugins", operation: "disable", cwd: "/tmp/project", resourceId: "resource_" + "c".repeat(64) },
    { area: "plugins", operation: "disable", cwd: "/tmp/project", source: "fixture" },
    { area: "mcp", operation: "set_exposure", name: "fixture", exposure: "codemode" },
    { area: "subagents_settings", operation: "set_profile_override", name: "worker", model: null, thinking: null },
    { area: "custom_prompts", operation: "upsert", title: "fixture", content: "Only isolated fixture" },
    { area: "model_routing", operation: "replace", enabled: false, routes: [] },
    { area: "tools_settings", operation: "set_codemode_inline_budget", inlineBudget: null },
    { area: "compaction", operation: "set_enabled", enabled: false },
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const args = managedWrite({ ...cases[index], expectedRevision: `config-revision-${index + 1}`, idempotencyKey: `managed-area-${index}` });
    delete args.codemode;
    const result = await client.tool("reader_write_control_plane", args);
    assert.equal(result.outcome, "completed", JSON.stringify(result));
    const post = reader.requests.filter((request) => request.method === "POST").at(-1);
    assert.equal(post.body.area, cases[index].area);
    assert.equal(post.body.operation, cases[index].operation);
    if (cases[index].resourceId) assert.equal(post.body.changes.resourceId, cases[index].resourceId);
  }
});

function managedWrite(overrides = {}) {
  return { area: "tools_settings", operation: "set_codemode", deviceId: "dev-a", scope: "global", codemode: "always", dryRun: false, confirm: true, confirmationReason: "isolated fixture", idempotencyKey: "managed-config-001", expectedRevision: "config-revision-1", expectedBootId: "config-boot-1", ...overrides };
}

async function managedClient(t, reader) {
  const client = startClient(undefined, { url: reader.url });
  t.after(() => client.close());
  await client.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "managed-config-test", version: "1" } });
  return client;
}


test("storage tail explicit both matches omitted scope and keeps duplicate IDs ambiguous", async (t) => {
  const fixture = await createFixture();
  t.after(() => removeTree(fixture.root));
  const before = await snapshotTree(fixture.root);
  const client = startClient(fixture.root);
  t.after(() => client.close());
  await client.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "storage-both-test", version: "1" } });
  const tools = await client.call("tools/list", {});
  const tailTool = tools.tools.find((tool) => tool.name === "reader_read_tail");
  assert.deepEqual(tailTool.inputSchema.properties.scope.enum, ["active", "archived", "both"]);
  for (const [sessionId, storageScope] of [["active-001", "active"], ["archived-001", "archived"]]) {
    const omitted = await client.tool("reader_read_tail", { sessionId });
    const both = await client.tool("reader_read_tail", { sessionId, scope: "both" });
    const explicit = await client.tool("reader_read_tail", { sessionId, scope: storageScope });
    assert.equal(both.__toolError, undefined);
    assert.equal(both.session.storageScope, storageScope);
    for (const key of ["session", "entries", "returnedCount", "sessionFilePath", "bytesRead"]) {
      assert.deepEqual(both[key], omitted[key]);
      assert.deepEqual(both[key], explicit[key]);
    }
  }
  for (const scope of [undefined, "both"]) {
    const duplicate = await client.tool("reader_read_tail", { sessionId: "duplicate-001", ...(scope ? { scope } : {}) });
    assert.equal(duplicate.__toolError, true);
    assert.match(duplicate.error, /more than one storage scope/);
    const missing = await client.tool("reader_read_tail", { sessionId: "not-present", ...(scope ? { scope } : {}) });
    assert.equal(missing.__toolError, true);
    assert.match(missing.error, /Session not found/);
  }
  for (const scope of ["active", "archived"]) {
    const disambiguated = await client.tool("reader_read_tail", { sessionId: "duplicate-001", scope });
    assert.equal(disambiguated.__toolError, undefined);
    assert.equal(disambiguated.session.storageScope, scope);
  }
  const invalid = await client.tool("reader_read_tail", { sessionId: "active-001", scope: "unknown" });
  assert.equal(invalid.__toolError, true);
  await client.close();
  assert.deepEqual(await snapshotTree(fixture.root), before, "tail scope selection must remain read-only");
});

test("path boundary rejects traversal and ignores non-Reader nested files", async (t) => {
  const fixture = await createFixture();
  t.after(() => removeTree(fixture.root));
  const client = startClient(fixture.root);
  t.after(() => client.close());
  await client.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "path-boundary-test", version: "1" } });
  const inventory = await client.tool("reader_list_sessions", { scope: "both", limit: 500 });
  assert.equal(inventory.sessions.some((session) => session.id === "outside-secret"), false);
  assert.equal(inventory.sessions.some((session) => session.id === "nested-should-not-list"), false);
  assert.equal(inventory.sessions.some((session) => session.id === "root-level-ignored"), false);
  assert.equal(inventory.sessions.some((session) => session.id === "artifact-should-not-list"), false);
  assert.ok(inventory.coverage.directories.every((scope) => scope.scanRule.includes("nested files are ignored")));
  assert.ok(inventory.coverage.directories.some((scope) => scope.nestedDirectoriesIgnored > 0));

  const traversal = await client.tool("reader_read_tail", { sessionId: "../outside" });
  assert.equal(traversal.__toolError, true);
  assert.match(traversal.error, /bounded identifier/);
  await assert.rejects(client.tool("reader_not_a_tool", {}), error => error.code === -32602 && /Unknown tool/.test(error.message));
  const extra = await client.tool("reader_list_sessions", { unexpected: true });
  assert.equal(extra.__toolError, true);
  assert.match(extra.error, /does not accept argument/);
  await client.close();
});

test("redacts secret-shaped message content before bounded output", async (t) => {
  const fixture = await createFixture();
  t.after(() => removeTree(fixture.root));
  const client = startClient(fixture.root);
  t.after(() => client.close());
  await client.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "redaction-test", version: "1" } });
  const tail = await client.tool("reader_read_tail", { sessionId: "active-001", scope: "active", maxEntries: 10, maxBytes: 16 * 1024 });
  assert.doesNotMatch(tail.entries.at(-1).text, /super-secret-value|api-secret-value/);
  assert.match(tail.entries.at(-1).text, /REDACTED/);
  await client.close();
});

test("storage tail redacts quoted secret fields, nested JSON and escaped values without altering ordinary text", async (t) => {
  const fixture = await createFixture();
  t.after(() => removeTree(fixture.root));
  const cases = [
    ['{"password":"SYNTHETIC_QUOTED","safe":"quoted-ok"}', 'quoted-ok'],
    ['{ "api_key" \t : \n "SYNTHETIC_WHITESPACE with spaces", "safe":"space-ok" }', 'space-ok'],
    ['prefix {"outer":{"refresh_token":"SYNTHETIC_NESTED","safe":"nested-ok"}} suffix', 'nested-ok'],
    [String.raw`{"pass\u0077ord":"SYNTHETIC_ESCAPED_KEY","safe":"key-ok"}`, 'key-ok'],
    [String.raw`{"password":"SYNTHETIC_ESCAPE_START \"quoted secret\" end SYNTHETIC_ESCAPE_END","safe":"escape-ok"}`, 'escape-ok'],
    ["{'apiKey' : 'SYNTHETIC_SINGLE with spaces', 'safe': 'single-ok'}", 'single-ok'],
    [JSON.stringify({ payload: JSON.stringify({ authorization: 'SYNTHETIC_ENCODED', safe: 'encoded-ok' }) }), 'encoded-ok'],
    [String.raw`{\"password\":\"SYNTHETIC_ESCAPED_JSON\",\"safe\":\"escaped-json-ok\"}`, 'escaped-json-ok'],
    ['{"credential":{"name":"SYNTHETIC_OBJECT","nested":["SYNTHETIC_OBJECT_NESTED"]},"safe":"object-ok"}', 'object-ok'],
    ['{"access_tokens":["SYNTHETIC_ARRAY_1", "SYNTHETIC_ARRAY_2"],"safe":"array-ok"}', 'array-ok'],
    ['{"private_key":"SYNTHETIC_PRIVATE_KEY","safe":"private-ok"}', 'private-ok'],
    ['password="SYNTHETIC_UNQUOTED_KEY with spaces" safe=unquoted-ok', 'unquoted-ok'],
    ['prefix "password":"SYNTHETIC_UNTERMINATED with spaces', 'prefix'],
    ['{"password":"SYNTHETIC_FIRST","token":"SYNTHETIC_SECOND","safe":"multiple-ok"}', 'multiple-ok'],
  ];
  const ordinary = [
    '{"status":"ready","count":3,"nested":{"message":"keep spaces and punctuation, too"}}',
    String.raw`{"message":"the password should remain private","path":"C:\\project\\notes","quote":"say \"hello\""}`,
    JSON.stringify({ payload: JSON.stringify({ message: 'ordinary nested text', count: 2 }) }),
    "A password without a field assignment is prose; the tokenizer is ready.",
    String.raw`{\"message\":\"ordinary escaped JSON\",\"safe\":true}`,
  ];
  const folder = path.join(fixture.root, "sessions", "redaction-contract");
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, "quoted-fields.jsonl"), [
    JSON.stringify({ type: "session", id: "quoted-fields", cwd: "/fixture/redaction" }),
    ...[...cases.map(([text]) => text), ...ordinary].map((content) => JSON.stringify({ type: "message", message: { role: "assistant", content } })),
    "",
  ].join("\n"));
  const client = startClient(fixture.root);
  t.after(() => client.close());
  await client.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "quoted-redaction-test", version: "1" } });
  const tail = await client.tool("reader_read_tail", { sessionId: "quoted-fields", maxEntries: 50 });
  assert.equal(tail.entries.length, cases.length + ordinary.length);
  assert.doesNotMatch(JSON.stringify(tail), /SYNTHETIC_/);
  for (const [index, [original, retained]] of cases.entries()) {
    const projected = tail.entries[index].text;
    assert.match(projected, /\[REDACTED\]/, `case ${index} must redact the complete value`);
    assert.ok(projected.includes(retained), `case ${index} must preserve non-secret surroundings`);
    if (original.startsWith('{"')) assert.doesNotThrow(() => JSON.parse(projected), `case ${index} must retain valid JSON`);
  }
  assert.deepEqual(tail.entries.slice(cases.length).map((entry) => entry.text), ordinary);
});

test("live tail applies quoted-field redaction to safe-history response text", async (t) => {
  const reader = await createMockReaderServer({ safeHistoryEntries: [
    { role: "assistant", text: String.raw`{"password":"SYNTHETIC_LIVE \"escaped\" value","safe":"live-ok"}` },
    { role: "user", text: '{"message":"ordinary JSON","safe":true}' },
  ] });
  t.after(() => reader.close());
  const client = await managedClient(t, reader);
  const tail = await client.tool("reader_read_tail", { sessionId: "active-001" });
  assert.equal(tail.found, true);
  assert.doesNotMatch(JSON.stringify(tail), /SYNTHETIC_LIVE/);
  assert.equal(tail.entries[0].text, '{"password":"[REDACTED]","safe":"live-ok"}');
  assert.equal(tail.entries[1].text, '{"message":"ordinary JSON","safe":true}');
});

test("tool results stay within the adapter budget and expose structured truncation", async (t) => {
  const fixture = await createFixture();
  t.after(() => removeTree(fixture.root));
  const bulkDir = path.join(fixture.root, "sessions", "bulk");
  await fs.mkdir(bulkDir, { recursive: true });
  const longTitle = "bulk-session-" + "x".repeat(580);
  const longMessage = "bulk-message-" + "y".repeat(580);
  await Promise.all(Array.from({ length: 500 }, (_, index) => fs.writeFile(
    path.join(bulkDir, `bulk-${String(index).padStart(4, "0")}.jsonl`),
    `${JSON.stringify({ type: "session", id: `bulk-${index}`, cwd: "/tmp/bulk", title: longTitle, timestamp: "2026-10-12T10:00:00.000Z" })}\n${JSON.stringify({ type: "message", message: { role: "user", content: longMessage }, timestamp: "2026-10-12T10:01:00.000Z" })}\n`,
  )));
  const client = startClient(fixture.root);
  t.after(() => client.close());
  await client.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "budget-test", version: "1" } });
  const inventory = await client.tool("reader_list_sessions", { scope: "active", limit: 500 });
  assert.equal(inventory.outcome, "truncated");
  assert.equal(inventory.truncated, true);
  assert.equal(inventory.result.outcome, "truncated");
  assert.equal(inventory.result.truncated, true);
  assert.ok(inventory.result.responseBudgetBytes <= 512 * 1024);
  await client.close();
});

test("server refuses an implicit real Reader root", async () => {
  const child = spawn(process.execPath, [SERVER], {
    env: { PATH: process.env.PATH, NODE_NO_WARNINGS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderrPromise = collectStream(child.stderr);
  const [code] = await once(child, "exit");
  const stderr = await stderrPromise;
  assert.equal(code, 64);
  assert.match(stderr, /PI_WEB_READER_DATA_ROOT or PI_WEB_READER_URL is required/);
});

test("initialize negotiates the supported version without claiming unverified older support", async (t) => {
  const fixture = await createFixture();
  t.after(() => removeTree(fixture.root));
  for (const requested of ["2025-11-25", "1999-01-01", "2099-01-01"]) {
    const client = startClient(fixture.root); t.after(() => client.close());
    const initialized = await client.call("initialize", { protocolVersion: requested, capabilities: {}, clientInfo: { name: "version-client", version: "1" } });
    assert.equal(initialized.protocolVersion, "2025-11-25");
    assert.equal(initialized.serverInfo.version, "0.10.1");
    await client.close();
  }
});

test("malformed tool envelopes and unknown tools are protocol errors, business validation remains a tool result", async t => {
  const fixture = await createFixture(); t.after(() => removeTree(fixture.root));
  const client = startClient(fixture.root); t.after(() => client.close());
  for (const params of [[], null, {}, {name: 42}, {name: "not_a_reader_tool"}, {name: "reader_list_sessions", arguments: []}, {name: "reader_list_sessions", arguments: null}]) {
    await assert.rejects(client.call("tools/call", params), error => error.code === -32602);
  }
  await assert.rejects(client.call("tools/list", []), error => error.code === -32602);
  await assert.rejects(client.call("no_such_method", {}), error => error.code === -32601);
  const badValue = await client.call("tools/call", { name: "reader_list_sessions", arguments: { limit: -1 } });
  assert.equal(badValue.isError, true);
  assert.match(badValue.content[0].text, /minimum/);
  assert.equal((await client.call("tools/list", {})).tools.length, 9, "errors do not poison the connection");
});

test("initialize requires the standard client identity and negotiation fields", async t => {
  const fixture = await createFixture(); t.after(() => removeTree(fixture.root));
  const client = startClient(fixture.root); t.after(() => client.close());
  for (const params of [{}, {protocolVersion: 7}, {protocolVersion:"2025-11-25",capabilities:[]}, {protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"client"}}]) {
    await assert.rejects(client.call("initialize", params), error => error.code === -32602);
  }
});

test("invalid JSON-RPC envelopes return protocol errors without echoing invalid IDs", async t => {
  const fixture = await createFixture(); t.after(() => removeTree(fixture.root));
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, PI_WEB_READER_URL: "", PI_WEB_READER_DATA_ROOT: fixture.root }, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());
  let output = ""; child.stdout.on("data", data => { output += data; });
  child.stderr.resume();
  const exited = new Promise(resolve => child.once("close", resolve));
  child.stdin.end([
    "{", JSON.stringify([]),
    ...[null, {}, true, 1.5].map(id => JSON.stringify({jsonrpc:"2.0",id,method:"ping"})),
    JSON.stringify({jsonrpc:"2.0",id:"valid",method:"ping",result:{}}),
  ].join("\n") + "\n");
  assert.equal(await exited, 0);
  const replies = output.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(replies.length, 7);
  assert.equal(replies[0].error.code, -32700);
  for (const reply of replies.slice(1)) assert.equal(reply.error.code, -32600);
  assert.ok(replies.slice(0, 6).every(reply => reply.id === null));
  assert.equal(replies[6].id, "valid");
});

test("server source stays outside Reader runtime and local file-write paths", async () => {
  const source = await fs.readFile(SERVER, "utf8");
  assert.doesNotMatch(source, /@earendil|child_process|writeFile|createWriteStream/);
  assert.match(source, /PI_WEB_READER_URL/);
  assert.match(source, /method: "POST"/);
  assert.match(source, /PI_WEB_READER_DATA_ROOT/);
  assert.match(source, /runtimeStatus: \"unknown\"/);
  assert.match(source, /dryRun/);
  assert.match(source, /never-auto-retry-unknown/);
  assert.match(source, /outcome: \"reset_required\"/);
  assert.match(source, /errorCode === \"boot_changed\"/);
});

test("schema defaults do not inject a create-only tool policy into other control actions", async (t) => {
  const reader = await createMockReaderServer();
  t.after(() => reader.close());
  const client = startClient(undefined, {url:reader.url});
  t.after(() => client.close());
  await client.call('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'schema-defaults-fixture',version:'1'}});
  const listed = await client.call('tools/list',{});
  const schema = listed.tools.find(tool=>tool.name==='reader_session_control').inputSchema;
  const defaults = Object.fromEntries(Object.entries(schema.properties).filter(([,field])=>Object.hasOwn(field,'default')).map(([name,field])=>[name,field.default]));
  for(const action of ['inspect','prompt','steer','follow_up','continue','abort','stop','clear_queue']) {
    const result=await client.tool('reader_session_control',{...defaults,action,deviceId:'dev-a',sessionId:'active-001',...(['prompt','steer','follow_up','continue'].includes(action)?{message:'default-injection fixture'}:{})});
    assert.equal(result.outcome,action==='inspect'?'observed':'dry_run',`${action}: ${result.error??result.outcome}`);
  }
  const create=await client.tool('reader_session_control',{...defaults,action:'create_session',deviceId:'dev-a',cwd:'/tmp',toolNames:[]});
  assert.equal(create.outcome,'dry_run');
  assert.equal(create.payloadSummary.strictToolAllowlist,true);
  assert.equal(reader.requests.some(request=>request.method==='POST'),false);
});

test("Reader API mode reports live coverage and keeps control dry-run/idempotent", async (t) => {
  const reader = await createMockReaderServer();
  t.after(() => reader.close());
  const client = startClient(undefined, { url: reader.url });
  t.after(() => client.close());

  await client.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "api-fixture-test", version: "1" } });
  const inventory = await client.tool("reader_list_sessions", { scope: "both", visibility: "all", limit: 1 });
  assert.equal(inventory.source, "reader-api");
  assert.equal(inventory.totalCount, 4);
  assert.equal(inventory.returnedCount, 1);
  assert.equal(inventory.countExact, false, "an offline peer makes the cross-device total a lower bound");
  assert.equal(inventory.pagination.hasMore, true);
  assert.equal(inventory.pagination.nextOffset, 1);
  assert.equal(inventory.coverage.readerUiEquivalent, true);
  assert.equal(inventory.coverage.runtimeSessionsIncluded, true);
  assert.deepEqual(inventory.coverage.offlineDevices.map((device) => device.id), ["dev-b"]);
  assert.deepEqual(inventory.summary.statusCounts, {
    running: 1,
    retrying: 0,
    waiting_user: 1,
    just_completed: 0,
    idle: 1,
    failed: 0,
    aborted: 0,
    unknown: 1,
  });

  const filtered = await client.tool("reader_list_sessions", {
    scope: "active",
    visibility: "all",
    device: "dev-a",
    project: "demo",
    offset: 1,
    limit: 1,
  });
  assert.deepEqual(filtered.sessions.map((session) => session.id), ["hidden-001"]);
  assert.equal(filtered.sessions[0].visibility, "hidden");
  assert.equal(filtered.sessions[0].status, "waiting_user");

  const dryRun = await client.tool("reader_session_control", {
    action: "prompt",
    deviceId: "dev-a",
    sessionId: "active-001",
    message: "do not send this fixture prompt",
  });
  assert.equal(dryRun.outcome, "dry_run");
  assert.equal(reader.requests.filter((request) => request.path === "/api/agent/active-001" && request.method === "POST").length, 0);

  const inspected = await client.tool("reader_session_control", {
    action: "inspect",
    deviceId: "dev-a",
    sessionId: "active-001",
  });
  assert.equal(inspected.outcome, "observed");
  assert.equal(inspected.running, true);
  assert.equal(inspected.state.isStreaming, true);
  assert.equal("sessionFile" in inspected.state, false);
  assert.equal("cwd" in inspected.state, false);
  assert.equal("token" in inspected.state, false);

  const accepted = await client.tool("reader_session_control", {
    action: "prompt",
    deviceId: "dev-a",
    sessionId: "active-001",
    message: "fixture prompt",
    dryRun: false,
    confirm: true,
    confirmationReason: "fixture",
    idempotencyKey: "fixture-key-001",
  });
  assert.equal(accepted.outcome, "accepted");
  assert.equal(accepted.transportAccepted, true);
  assert.equal(accepted.targetStopped, false);
  assert.equal(accepted.retryPolicy, "never-auto-retry-unknown");
  const sent = reader.requests.filter((request) => request.path === "/api/agent/active-001" && request.method === "POST");
  assert.equal(sent.length, 1);
  assertReaderCommandBody(sent[0].body, { type: "prompt", message: "fixture prompt" }, "fixture-key-001");

  const replay = await client.tool("reader_session_control", {
    action: "prompt",
    deviceId: "dev-a",
    sessionId: "active-001",
    message: "fixture prompt",
    dryRun: false,
    confirm: true,
    confirmationReason: "fixture",
    idempotencyKey: "fixture-key-001",
  });
  assert.equal(replay.replayed, true);
  assert.equal(reader.requests.filter((request) => request.path === "/api/agent/active-001" && request.method === "POST").length, 1);

  const conflict = await client.tool("reader_session_control", {
    action: "prompt",
    deviceId: "dev-a",
    sessionId: "active-001",
    message: "same key, different request",
    dryRun: false,
    confirm: true,
    confirmationReason: "fixture",
    idempotencyKey: "fixture-key-001",
  });
  assert.equal(conflict.outcome, "conflict");
  assert.equal(conflict.code, "idempotency_conflict");
  assert.equal(reader.requests.filter((request) => request.path === "/api/agent/active-001" && request.method === "POST").length, 1);

  const inactive = await client.tool("reader_session_control", {
    action: "prompt",
    deviceId: "dev-a",
    sessionId: "hidden-001",
    message: "must not auto-start",
    dryRun: false,
    confirm: true,
    confirmationReason: "fixture",
    idempotencyKey: "fixture-key-002",
  });
  assert.equal(inactive.outcome, "blocked");
  assert.match(inactive.reason, /not alive|no POST/);
  assert.equal(reader.requests.filter((request) => request.path === "/api/agent/hidden-001" && request.method === "POST").length, 0);

  const created = await client.tool("reader_session_control", {
    action: "create_session",
    deviceId: "dev-a",
    cwd: "/tmp",
    dryRun: false,
    confirm: true,
    confirmationReason: "fixture",
    idempotencyKey: "fixture-key-003",
  });
  assert.equal(created.outcome, "accepted");
  assert.equal(created.createdSessionId, "created-001");
  assert.equal(created.createdSessionBootId, "boot-fixture-session-001");
  const createRequest = reader.requests.find((request) => request.path === "/api/agent/new" && request.method === "POST");
  assertReaderCommandBody(createRequest.body, { cwd: "/tmp", type: "ensure_session" }, "fixture-key-003");

  const offline = await client.tool("reader_session_control", {
    action: "inspect",
    deviceId: "dev-b",
    sessionId: "active-001",
  });
  assert.equal(offline.outcome, "unavailable");
  assert.equal(reader.requests.filter((request) => request.path === "/api/agent/active-001" && request.method === "GET").length, 2);

  await client.close();
});

test("create_session preserves Reader accepted-unknown receipts through stdio", async (t) => {
  const reader = await createMockReaderServer({ createOutcomeUnknown: true });
  t.after(() => reader.close());
  const client = startClient(undefined, { url: reader.url });
  t.after(() => client.close());
  await client.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "create-unknown-test", version: "1" } });

  const result = await client.tool("reader_session_control", {
    action: "create_session",
    deviceId: "dev-a",
    cwd: "/tmp",
    dryRun: false,
    confirm: true,
    confirmationReason: "isolated fixture",
    idempotencyKey: "fixture-create-unknown-001",
  });

  assert.equal(result.outcome, "unknown");
  assert.equal(result.readerOutcome, "unknown");
  assert.equal(result.transportAccepted, true);
  assert.equal(result.httpStatus, 202);
  assert.equal(result.code, "create_runtime_start_failed");
  assert.equal(result.createdSessionId, undefined);
  assert.equal(result.readerReceipt.receiptId, "create-unknown-001");
  assert.equal(reader.requests.filter((request) => request.path === "/api/agent/new" && request.method === "POST").length, 1);
});

test("real control contract validates confirmation before routing and sends JSON fields in the body", async (t) => {
  const reader = await createMockReaderServer();
  t.after(() => reader.close());
  const client = startClient(undefined, { url: reader.url });
  t.after(() => client.close());
  await client.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "control-contract-test", version: "1" } });

  const missingPromptReason = await client.tool("reader_session_control", {
    action: "prompt",
    deviceId: "dev-a",
    sessionId: "active-001",
    message: "must be rejected before routing",
    dryRun: false,
    confirm: true,
    idempotencyKey: "missing-reason-prompt",
  });
  assert.equal(missingPromptReason.__toolError, true);
  assert.match(missingPromptReason.error, /confirmationReason is required/);

  const missingCreateReason = await client.tool("reader_session_control", {
    action: "create_session",
    deviceId: "dev-a",
    cwd: "/tmp",
    dryRun: false,
    confirm: true,
    idempotencyKey: "missing-reason-create",
  });
  assert.equal(missingCreateReason.__toolError, true);
  assert.match(missingCreateReason.error, /confirmationReason is required/);

  const emptyReason = await client.tool("reader_session_control", {
    action: "prompt",
    deviceId: "dev-a",
    sessionId: "active-001",
    message: "empty reason must be rejected",
    dryRun: false,
    confirm: true,
    confirmationReason: "",
    idempotencyKey: "empty-reason-prompt",
  });
  assert.equal(emptyReason.__toolError, true);
  assert.match(emptyReason.error, /confirmationReason must be a non-empty/);

  const stringConfirm = await client.tool("reader_session_control", {
    action: "prompt",
    deviceId: "dev-a",
    sessionId: "active-001",
    message: "string confirm must be rejected",
    dryRun: false,
    confirm: "true",
    confirmationReason: "fixture intent",
    idempotencyKey: "string-confirm-prompt",
  });
  assert.equal(stringConfirm.__toolError, true);
  assert.match(stringConfirm.error, /confirm must be boolean/);
  assert.equal(reader.requests.length, 0, "invalid control contracts must not route a Reader request");

  const accepted = await client.tool("reader_session_control", {
    action: "prompt",
    deviceId: "dev-a",
    sessionId: "active-001",
    message: "valid body contract",
    dryRun: false,
    confirm: true,
    confirmationReason: "explicit fixture intent",
    idempotencyKey: "valid-contract-prompt",
  });
  assert.equal(accepted.outcome, "accepted");
  const post = reader.requests.find((request) => request.path === "/api/agent/active-001" && request.method === "POST");
  assert.ok(post);
  assertReaderCommandBody(post.body, { type: "prompt", message: "valid body contract" }, "valid-contract-prompt", "explicit fixture intent");
  assert.equal(post.query.confirm, undefined, "confirm must not be moved to a query parameter");
  assert.equal(post.query.idempotencyKey, undefined, "idempotencyKey must not be moved to a query parameter");
  assert.equal(post.query.confirmationReason, undefined, "confirmationReason must not be moved to a query parameter");

  await client.close();
});

test("create_session accepts empty or built-in read-only tool allow-lists", async (t) => {
  const reader = await createMockReaderServer();
  t.after(() => reader.close());
  const client = startClient(undefined, { url: reader.url });
  t.after(() => client.close());

  await client.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "tool-isolation-test", version: "1" } });

  const nonEmpty = await client.tool("reader_session_control", {
    action: "create_session",
    deviceId: "dev-a",
    cwd: "/tmp",
    toolNames: ["bash"],
    dryRun: false,
    confirm: true,
    confirmationReason: "fixture",
    idempotencyKey: "tool-isolation-invalid-001",
  });
  assert.equal(nonEmpty.__toolError, true);
  assert.match(nonEmpty.error, /unique subset|safe read-only/);
  assert.equal(reader.requests.filter((request) => request.path === "/api/agent/new" && request.method === "POST").length, 0);

  const promptWithTools = await client.tool("reader_session_control", {
    action: "prompt",
    deviceId: "dev-a",
    sessionId: "active-001",
    message: "must not send this fixture prompt",
    toolNames: [],
  });
  assert.equal(promptWithTools.__toolError, true);
  assert.match(promptWithTools.error, /only for create_session/);
  assert.equal(reader.requests.filter((request) => request.path === "/api/agent/active-001" && request.method === "POST").length, 0);

  const dryRun = await client.tool("reader_session_control", {
    action: "create_session",
    deviceId: "dev-a",
    cwd: "/tmp",
    toolNames: [],
  });
  assert.equal(dryRun.outcome, "dry_run");
  assert.equal(dryRun.payloadSummary.toolsDisabled, true);
  assert.equal(reader.requests.filter((request) => request.path === "/api/agent/new" && request.method === "POST").length, 0);

  const created = await client.tool("reader_session_control", {
    action: "create_session",
    deviceId: "dev-a",
    cwd: "/tmp",
    toolNames: [],
    dryRun: false,
    confirm: true,
    confirmationReason: "fixture",
    idempotencyKey: "tool-isolation-valid-001",
  });
  assert.equal(created.outcome, "accepted");
  const createRequest = reader.requests.find((request) => request.path === "/api/agent/new" && request.method === "POST");
  assertReaderCommandBody(createRequest.body, { cwd: "/tmp", type: "ensure_session", toolNames: [], strictToolAllowlist: true }, "tool-isolation-valid-001");

  const transientInspection = await client.tool("reader_session_control", {
    action: "inspect",
    deviceId: "dev-a",
    sessionId: created.createdSessionId,
  });
  assert.equal(transientInspection.outcome, "observed");
  assert.equal(transientInspection.running, true);

  const firstPrompt = await client.tool("reader_session_control", {
    action: "prompt",
    deviceId: "dev-a",
    sessionId: created.createdSessionId,
    message: "first transient prompt",
    dryRun: false,
    confirm: true,
    confirmationReason: "fixture",
    expectedBootId: created.createdSessionBootId,
    idempotencyKey: "tool-isolation-first-prompt-001",
  });
  assert.equal(firstPrompt.outcome, "accepted");
  const transientPrompt = reader.requests.filter((request) => request.path === "/api/agent/created-001" && request.method === "POST");
  assert.equal(transientPrompt.length, 1);
  assertReaderCommandBody(transientPrompt[0].body, { type: "prompt", message: "first transient prompt", expectedBootId: created.createdSessionBootId }, "tool-isolation-first-prompt-001");

  await client.close();
});

test("transient binding matches a restricted read-only tool allow-list", async (t) => {
  const reader = await createMockReaderServer({ createdRuntimeTools: ["ls"] });
  t.after(() => reader.close());
  const client = startClient(undefined, { url: reader.url });
  t.after(() => client.close());
  await client.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "restricted-tool-binding-test", version: "1" } });

  const created = await client.tool("reader_session_control", {
    action: "create_session",
    deviceId: "dev-a",
    cwd: "/tmp",
    toolNames: ["ls"],
    dryRun: false,
    confirm: true,
    confirmationReason: "fixture",
    idempotencyKey: "restricted-tool-create-001",
  });
  assert.equal(created.outcome, "accepted");
  const prompt = await client.tool("reader_session_control", {
    action: "prompt",
    deviceId: "dev-a",
    sessionId: created.createdSessionId,
    message: "restricted fixture prompt",
    dryRun: false,
    confirm: true,
    confirmationReason: "fixture",
    idempotencyKey: "restricted-tool-prompt-001",
  });
  assert.equal(prompt.outcome, "accepted");
  const restrictedPrompt = reader.requests.filter((request) => request.path === "/api/agent/created-001" && request.method === "POST");
  assert.equal(restrictedPrompt.length, 1);
  assertReaderCommandBody(restrictedPrompt[0].body, { type: "prompt", message: "restricted fixture prompt" }, "restricted-tool-prompt-001");
  await client.close();
});

test("live event polling is bounded, cursor-aware, and never sends a control POST", async (t) => {
  const reader = await createMockReaderServer();
  t.after(() => reader.close());
  const client = startClient(undefined, { url: reader.url });
  t.after(() => client.close());
  await client.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "live-events-test", version: "1" } });

  const first = await client.tool("reader_read_live_events", {
    sessionId: "active-001",
    device: "dev-a",
    maxEvents: 2,
    maxBytes: 4096,
    timeoutMs: 1000,
    cursor: 3,
  });
  assert.equal(first.outcome, "observed");
  assert.equal(first.runtimeStatusSemantics.runtimeStartAttempted, false);
  assert.equal(first.runtimeStatusSemantics.writeSideEffects, false);
  assert.equal(first.bootId, "boot-fixture-001");
  assert.equal(first.events.length, 2);
  assert.equal(first.events[0].cursor, 4);
  assert.match(first.events[0].event.type, /message_update|tool_execution/);
  assert.equal("secret" in first.events[1].event, false);
  assert.equal(first.events[1].event.longText.length <= 8192, true);
  assert.equal(reader.requests.some((request) => request.method === "POST"), false);

  const next = await client.tool("reader_read_live_events", {
    sessionId: "active-001",
    device: "dev-a",
    bootId: first.bootId,
    cursor: first.nextCursor,
  });
  assert.equal(next.outcome, "observed");
  assert.ok(next.events.every((event) => event.cursor > first.nextCursor));

  const stale = await client.tool("reader_read_live_events", {
    sessionId: "active-001",
    device: "dev-a",
    bootId: "old-boot",
    cursor: 0,
  });
  assert.equal(stale.outcome, "reset_required");
  assert.equal(stale.code, "boot_changed");
  assert.equal(stale.bootId, "boot-fixture-002");
  assert.match(stale.reason, /cursor 0/);
  assert.equal(stale.runtimeStatusSemantics.runtimeStartAttempted, false);
  await client.close();
});

test("live event polling reports a retained-window gap instead of inventing continuity", async (t) => {
  const reader = await createMockReaderServer({ liveOldestCursor: 5, liveGapStatus: true });
  t.after(() => reader.close());
  const client = startClient(undefined, { url: reader.url });
  t.after(() => client.close());
  await client.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "live-gap-test", version: "1" } });

  const gap = await client.tool("reader_read_live_events", {
    sessionId: "active-001",
    device: "dev-a",
    cursor: 1,
  });
  assert.equal(gap.outcome, "gap");
  assert.equal(gap.code, "gap");
  assert.equal(gap.oldestCursor, 5);
  assert.equal(gap.recoverFromCursor, 4);
  assert.equal(gap.truncated, true);
  assert.equal(gap.runtimeStatusSemantics.runtimeStartAttempted, false);
  assert.equal(gap.runtimeStatusSemantics.writeSideEffects, false);
  await client.close();
});

test("unsafe legacy catalogs cannot produce a definitive inventory or trigger a fallback GET", async (t) => {
  const reader = await createMockReaderServer({ catalogUnsafe: true });
  t.after(() => reader.close());
  const client = startClient(undefined, { url: reader.url });
  t.after(() => client.close());
  await client.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "catalog-contract", version: "1" } });
  const result = await client.tool("reader_list_sessions", { scope: "active" });
  assert.equal(result.countExact, false);
  assert.equal(result.sessions.length, 0);
  assert.ok(reader.requests.length > 0);
  assert.ok(reader.requests.every((request) => request.method === "GET" && request.path === "/api/reader/session-catalog"));
});

test("stopped durable replay and unavailable continuity retain Reader authority", async (t) => {
  for (const unavailable of [false, true]) {
    const reader = await createMockReaderServer({ durableReplay: true, liveCoverageUnavailable: unavailable });
    t.after(() => reader.close());
    const client = startClient(undefined, { url: reader.url });
    t.after(() => client.close());
    await client.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "durable-replay", version: "1" } });
    const result = await client.tool("reader_read_live_events", { sessionId: "active-001", device: "dev-a" });
    assert.equal(result.outcome, unavailable ? "unknown" : "replayed");
    if (unavailable) assert.equal(result.code, "coverage_incomplete");
    else {
      assert.equal(result.runtimeStatus, "not_live");
      assert.equal(result.source, "reader-durable-live-ledger");
      assert.equal(result.durableLedger.coverageComplete, false);
      assert.equal(result.coverageIncomplete, true);
      assert.equal(result.durableLedger.unpersistedTail, "unknown-without-live-runtime");
      assert.ok(result.events.length > 0);
      assert.equal(result.bootId, result.readerBootId);
      assert.equal(result.bootScope, "reader-process");
      const next = await client.tool("reader_read_live_events", { sessionId: "active-001", device: "dev-a",
        bootId: result.bootId, cursor: result.nextCursor });
      assert.equal(next.outcome, "replayed");
      assert.equal(next.bootId, result.bootId);
    }
    assert.equal(reader.requests.some((request) => request.method === "POST"), false);
    await client.close();
  }
});

test("live reads reject missing no-wake proof and a historical runtime boot used as the stopped cursor fence", async (t) => {
  for (const unsafe of [false, true]) {
    const reader = await createMockReaderServer(unsafe ? { liveUnsafeProof: true } : { durableReplay: true, legacyStoppedBoot: true });
    t.after(() => reader.close());
    const client = startClient(undefined, { url: reader.url }); t.after(() => client.close());
    await client.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "read-proof", version: "1" } });
    const result = await client.tool("reader_read_live_events", { sessionId: "active-001", device: "dev-a" });
    assert.equal(result.outcome, "unknown");
    assert.equal(result.code, unsafe ? "live_read_contract_unavailable" : "replay_boot_contract_unavailable");
    assert.equal(result.events, undefined);
    assert.equal(reader.requests.some(request => request.method === "POST"), false);
    await client.close();
  }
});

test("future cursors and process-level boot changes remain explicit reset outcomes", async (t) => {
  for (const processBoot of [false, true]) {
    const reader = await createMockReaderServer(processBoot ? { processBootChanged: true } : { liveCursorAhead: true });
    t.after(() => reader.close());
    const client = startClient(undefined, { url: reader.url }); t.after(() => client.close());
    await client.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "cursor-reset", version: "1" } });
    const result = await client.tool("reader_read_live_events", { sessionId: "active-001", device: "dev-a",
      ...(processBoot ? { bootId: "old-boot" } : { cursor: 999 }) });
    assert.equal(result.outcome, "reset_required");
    assert.equal(result.code, processBoot ? "boot_changed" : "cursor_ahead");
    if (processBoot) {
      assert.equal(result.readerBootId, "reader-process-2"); assert.equal(result.runtimeStatus, "not_live");
      assert.equal(result.bootScope, "reader-process"); assert.equal(result.bootId, undefined);
    } else assert.equal(result.recoverFromCursor, 6);
    assert.equal(reader.requests.some(request => request.method === "POST"), false);
    await client.close();
  }
});

test("live tail reads assistant and deferred tool output without a control POST", async (t) => {
  const reader = await createMockReaderServer();
  t.after(() => reader.close());
  const client = startClient(undefined, { url: reader.url });
  t.after(() => client.close());
  await client.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "live-tail-test", version: "1" } });

  const created = await client.tool("reader_session_control", {
    action: "create_session",
    deviceId: "dev-a",
    cwd: "/tmp",
    toolNames: [],
    dryRun: false,
    confirm: true,
    confirmationReason: "fixture",
    idempotencyKey: "live-tail-create-001",
  });
  assert.equal(created.outcome, "accepted");

  const tail = await client.tool("reader_read_tail", {
    sessionId: created.createdSessionId,
    device: "dev-a",
    scope: "active",
    visibility: "all",
    maxEntries: 10,
    maxBytes: 16 * 1024,
  });
  assert.equal(tail.source, "reader-safe-history");
  assert.equal(tail.runtimeStartAttempted, false);
  assert.equal(tail.writeSideEffects, false);
  assert.equal(tail.durableOnly, false);
  assert.equal(tail.found, true);
  assert.deepEqual(tail.entries.map((entry) => entry.role), ["user", "assistant", "toolResult"]);
  assert.match(tail.entries.at(-1).text, /fixture deferred tool output/);
  assert.equal(tail.runtimeStatusSemantics.runtimeStartAttempted, false);
  assert.equal(reader.requests.some((request) => request.path === "/api/sessions/created-001/safe-history" && request.method === "GET"), true);
  assert.equal(reader.requests.some((request) => request.path === "/api/sessions/created-001" && request.method === "GET"), false);
  assert.equal(reader.requests.some((request) => request.path === "/api/agent/created-001" && request.method === "POST"), false);
  await client.close();
});

test("transient receipt rejects arbitrary ids, other devices, and cwd mismatches", async (t) => {
  const reader = await createMockReaderServer({ onlineRemote: true });
  t.after(() => reader.close());
  const client = startClient(undefined, { url: reader.url });
  t.after(() => client.close());

  await client.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "transient-ownership-test", version: "1" } });
  const created = await client.tool("reader_session_control", {
    action: "create_session",
    deviceId: "dev-a",
    cwd: "/tmp",
    toolNames: [],
    dryRun: false,
    confirm: true,
    confirmationReason: "fixture",
    idempotencyKey: "transient-ownership-create-001",
  });
  assert.equal(created.outcome, "accepted");

  const unknown = await client.tool("reader_session_control", {
    action: "prompt",
    deviceId: "dev-a",
    sessionId: "unknown-001",
    message: "must not send",
    dryRun: false,
    confirm: true,
    confirmationReason: "fixture",
    idempotencyKey: "transient-ownership-unknown-001",
  });
  assert.equal(unknown.outcome, "blocked");
  assert.match(unknown.reason, /not present on the selected device/);

  const otherDevice = await client.tool("reader_session_control", {
    action: "prompt",
    deviceId: "dev-b",
    sessionId: created.createdSessionId,
    message: "must not send to another device",
    dryRun: false,
    confirm: true,
    confirmationReason: "fixture",
    idempotencyKey: "transient-ownership-device-001",
  });
  assert.equal(otherDevice.outcome, "blocked");
  assert.match(otherDevice.reason, /not present on the selected device/);
  assert.equal(reader.requests.some((request) => request.path.includes("created-001") && request.method === "POST"), false);

  await client.close();

  const cwdReader = await createMockReaderServer({ createdRuntimeCwd: "/other" });
  t.after(() => cwdReader.close());
  const cwdClient = startClient(undefined, { url: cwdReader.url });
  t.after(() => cwdClient.close());
  await cwdClient.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "transient-cwd-test", version: "1" } });
  const cwdCreated = await cwdClient.tool("reader_session_control", {
    action: "create_session",
    deviceId: "dev-a",
    cwd: "/tmp",
    toolNames: [],
    dryRun: false,
    confirm: true,
    confirmationReason: "fixture",
    idempotencyKey: "transient-cwd-create-001",
  });
  assert.equal(cwdCreated.outcome, "accepted");
  const cwdMismatch = await cwdClient.tool("reader_session_control", {
    action: "prompt",
    deviceId: "dev-a",
    sessionId: cwdCreated.createdSessionId,
    message: "must not send with a mismatched cwd",
    dryRun: false,
    confirm: true,
    confirmationReason: "fixture",
    idempotencyKey: "transient-cwd-prompt-001",
  });
  assert.equal(cwdMismatch.outcome, "blocked");
  assert.match(cwdMismatch.reason, /chat-only runtime|cwd/);
  assert.equal(cwdReader.requests.some((request) => request.path === "/api/agent/created-001" && request.method === "POST"), false);

  await cwdClient.close();
});

test("control POST keeps its isolated configurable timeout", async (t) => {
  const reader = await createMockReaderServer({ postDelayMs: 5_200 });
  t.after(() => reader.close());
  const client = startClient(undefined, {
    url: reader.url,
    env: { PI_WEB_READER_CONTROL_POST_TIMEOUT_MS: "30000" },
  });
  t.after(() => client.close());

  await client.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "post-timeout-test", version: "1" } });
  const created = await client.tool("reader_session_control", {
    action: "create_session",
    deviceId: "dev-a",
    cwd: "/tmp",
    toolNames: [],
    dryRun: false,
    confirm: true,
    confirmationReason: "fixture",
    idempotencyKey: "post-timeout-test-001",
  });
  assert.equal(created.outcome, "accepted");
  assert.equal(created.createdSessionId, "created-001");
  assert.equal(reader.requests.filter((request) => request.path === "/api/agent/new" && request.method === "POST").length, 1);

  await client.close();
});

test("cross-device control uses Reader's explicit remote proxy route", async (t) => {
  const reader = await createMockReaderServer({ onlineRemote: true });
  t.after(() => reader.close());
  const client = startClient(undefined, { url: reader.url });
  t.after(() => client.close());
  await client.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "remote-control-test", version: "1" } });

  const mismatch = await client.tool("reader_session_control", {
    action: "inspect",
    deviceId: "dev-b",
    sessionId: "active-001",
  });
  assert.equal(mismatch.outcome, "blocked");
  assert.match(mismatch.reason, /not present on the selected device/);
  assert.equal(reader.requests.some((request) => request.path === "/api/remote/agent/active-001"), false);

  const accepted = await client.tool("reader_session_control", {
    action: "prompt",
    deviceId: "dev-b",
    sessionId: "remote-001",
    message: "remote fixture prompt",
    dryRun: false,
    confirm: true,
    confirmationReason: "fixture",
    idempotencyKey: "remote-key-001",
  });
  assert.equal(accepted.outcome, "accepted");
  const remoteRequests = reader.requests.filter((request) => request.path === "/api/remote/agent/remote-001");
  assert.deepEqual(remoteRequests.map((request) => request.method), ["GET", "POST"]);
  assert.equal(remoteRequests.every((request) => request.query.peer === "dev-b"), true);
  assertReaderCommandBody(remoteRequests[1].body, { type: "prompt", message: "remote fixture prompt" }, "remote-key-001");
  assert.equal(remoteRequests[1].query.confirm, undefined);
  assert.equal(remoteRequests[1].query.idempotencyKey, undefined);
  assert.equal(remoteRequests[1].query.confirmationReason, undefined);
  await client.close();
});

test("session-control receipt lookup uses the read-only stdio route and never retries creation", async (t) => {
  const reader = await createMockReaderServer({ onlineRemote: true });
  t.after(() => reader.close());
  const client = startClient(undefined, { url: reader.url });
  t.after(() => client.close());
  await client.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "session-receipt-test", version: "1" } });

  const byReceiptId = await client.tool("reader_get_session_control_receipt", {
    deviceId: "dev-a",
    receiptId: "create-receipt-001",
  });
  assert.equal(byReceiptId.outcome, "unknown");
  assert.equal(byReceiptId.receipt.receiptId, "create-receipt-001");
  assert.equal(byReceiptId.readOnlyTransport, true);
  assert.equal(byReceiptId.runtimeStartAttempted, false);
  assert.equal(byReceiptId.writeSideEffects, false);
  assert.equal(JSON.stringify(byReceiptId).includes("fixture-create-receipt-key"), false);

  const byKey = await client.tool("reader_get_session_control_receipt", {
    deviceId: "dev-a",
    operation: "create_session",
    idempotencyKey: "fixture-create-receipt-key",
  });
  assert.equal(byKey.outcome, "unknown");
  assert.equal(byKey.receipt.receiptId, "create-receipt-001");
  assert.equal(JSON.stringify(byKey).includes("fixture-create-receipt-key"), false);

  const remote = await client.tool("reader_get_session_control_receipt", {
    deviceId: "dev-b",
    operation: "create_session",
    idempotencyKey: "fixture-create-receipt-key",
  });
  assert.equal(remote.outcome, "blocked");
  assert.equal(remote.code, "remote_receipt_unsupported");

  const receiptRequests = reader.requests.filter((request) => request.path === "/api/agent/new/receipt");
  assert.deepEqual(receiptRequests.map((request) => request.method), ["GET", "GET"]);
  assert.deepEqual(receiptRequests.map((request) => request.query), [
    { receiptId: "create-receipt-001" },
    { idempotencyKey: "fixture-create-receipt-key", operation: "create_session" },
  ]);
  assert.equal(reader.requests.some((request) => request.path === "/api/agent/new" && request.method === "POST"), false);
  await client.close();
});

test("declared control actions map to explicit Reader commands", async (t) => {
  const reader = await createMockReaderServer();
  t.after(() => reader.close());
  const client = startClient(undefined, { url: reader.url });
  t.after(() => client.close());
  await client.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "control-action-test", version: "1" } });

  const actions = [
    ["continue", "continue payload", { type: "prompt", message: "continue payload" }],
    ["steer", "steer payload", { type: "steer", message: "steer payload" }],
    ["follow_up", "follow-up payload", { type: "follow_up", message: "follow-up payload" }],
    ["abort", undefined, { type: "abort" }],
    ["stop", undefined, { type: "abort" }],
    ["clear_queue", undefined, { type: "clear_queue" }],
  ];
  for (const [action, message, expectedBody] of actions) {
    const result = await client.tool("reader_session_control", {
      action,
      deviceId: "dev-a",
      sessionId: "active-001",
      ...(message === undefined ? {} : { message }),
      dryRun: false,
      confirm: true,
      confirmationReason: "fixture",
      idempotencyKey: `control-action-${action}`,
    });
    assert.equal(result.outcome, "accepted");
    const sent = reader.requests.filter((request) => request.path === "/api/agent/active-001" && request.method === "POST");
    assertReaderCommandBody(sent.at(-1).body, expectedBody, `control-action-${action}`);
  }
  assert.equal(reader.requests.filter((request) => request.path === "/api/agent/active-001" && request.method === "POST").length, actions.length);
  await client.close();
});

test("clear_queue preserves dry-run and confirmation boundaries", async (t) => {
  const reader = await createMockReaderServer();
  t.after(() => reader.close());
  const client = startClient(undefined, { url: reader.url });
  t.after(() => client.close());
  await client.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "clear-queue-test", version: "1" } });

  const dryRun = await client.tool("reader_session_control", {
    action: "clear_queue",
    deviceId: "dev-a",
    sessionId: "active-001",
  });
  assert.equal(dryRun.outcome, "dry_run");
  assert.equal(dryRun.payloadSummary.type, "clear_queue");
  assert.equal(dryRun.payloadSummary.messageProvided, false);
  assert.equal(reader.requests.filter((request) => request.path === "/api/agent/active-001" && request.method === "POST").length, 0);

  const missingReason = await client.tool("reader_session_control", {
    action: "clear_queue",
    deviceId: "dev-a",
    sessionId: "active-001",
    dryRun: false,
    confirm: true,
    idempotencyKey: "clear-queue-missing-reason",
  });
  assert.equal(missingReason.__toolError, true);
  assert.match(missingReason.error, /confirmationReason is required/);
  assert.equal(reader.requests.filter((request) => request.path === "/api/agent/active-001" && request.method === "POST").length, 0);

  const accepted = await client.tool("reader_session_control", {
    action: "clear_queue",
    deviceId: "dev-a",
    sessionId: "active-001",
    dryRun: false,
    confirm: true,
    confirmationReason: "clear stale queued controls",
    idempotencyKey: "clear-queue-accepted",
    expectedQueueRevision: "a".repeat(64),
  });
  assert.equal(accepted.outcome, "accepted");
  const post = reader.requests.find((request) => request.path === "/api/agent/active-001" && request.method === "POST");
  assert.ok(post);
  assertReaderCommandBody(post.body, { type: "clear_queue", expectedQueueRevision: "a".repeat(64) }, "clear-queue-accepted", "clear stale queued controls");
  await client.close();
});

test("stop observes Reader targetStopped and replays the durable terminal receipt without a second POST", async (t) => {
  const reader = await createMockReaderServer({ stopReceiptMode: "eventual", stopRuntimeRunningAfterPost: false });
  t.after(() => reader.close());
  const client = startClient(undefined, { url: reader.url });
  t.after(() => client.close());
  await client.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "stop-observed-test", version: "1" } });

  const args = {
    action: "stop",
    deviceId: "dev-a",
    sessionId: "active-001",
    dryRun: false,
    confirm: true,
    confirmationReason: "stop the selected runtime",
    idempotencyKey: "stop-observed-001",
  };
  const observed = await client.tool("reader_session_control", args);
  assert.equal(observed.outcome, "stopped");
  assert.equal(observed.targetStopped, true);
  assert.equal(observed.completion, "observed");
  assert.equal(observed.stopObservation, "observed");
  assert.equal(observed.readerReceipt.receiptId, "stop-receipt-001");
  assert.equal(observed.runtimeObservation.running, false);

  const replay = await client.tool("reader_session_control", args);
  assert.equal(replay.replayed, true);
  assert.equal(replay.outcome, "stopped");
  assert.equal(replay.targetStopped, true);
  assert.equal(replay.completion, "observed");
  assert.equal(reader.requests.filter((request) => request.path === "/api/agent/active-001" && request.method === "POST").length, 1);
  assert.equal(reader.requests.filter((request) => request.path === "/api/agent/active-001/receipt" && request.method === "GET").length, 3);
  await client.close();
});

test("stop keeps unobserved and unknown receipt outcomes explicit", async (t) => {
  const unobservedReader = await createMockReaderServer({ stopReceiptMode: "unobserved" });
  t.after(() => unobservedReader.close());
  const unobservedClient = startClient(undefined, { url: unobservedReader.url });
  t.after(() => unobservedClient.close());
  await unobservedClient.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "stop-unobserved-test", version: "1" } });
  const unobserved = await unobservedClient.tool("reader_session_control", {
    action: "stop", deviceId: "dev-a", sessionId: "active-001", dryRun: false, confirm: true,
    confirmationReason: "observe stop without claiming completion", idempotencyKey: "stop-unobserved-001",
  });
  assert.equal(unobserved.outcome, "accepted");
  assert.equal(unobserved.targetStopped, false);
  assert.equal(unobserved.completion, "unobserved");
  assert.equal(unobserved.stopObservation, "unobserved");
  assert.equal(unobserved.runtimeObservation.running, true);
  await unobservedClient.close();

  const timeoutReader = await createMockReaderServer({ stopReceiptMode: "not_found", stopReceiptDelayMs: 75 });
  t.after(() => timeoutReader.close());
  const timeoutClient = startClient(undefined, {
    url: timeoutReader.url,
    env: { PI_WEB_READER_STOP_RECEIPT_TIMEOUT_MS: "50" },
  });
  t.after(() => timeoutClient.close());
  await timeoutClient.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "stop-timeout-test", version: "1" } });
  const timeout = await timeoutClient.tool("reader_session_control", {
    action: "stop", deviceId: "dev-a", sessionId: "active-001", dryRun: false, confirm: true,
    confirmationReason: "bounded stop observation", idempotencyKey: "stop-timeout-001",
  });
  assert.equal(timeout.outcome, "accepted", JSON.stringify(timeout));
  assert.equal(timeout.completion, "unobserved");
  assert.equal(timeout.stopObservation, "unobserved");
  assert.equal(timeout.targetStopped, false);
  await timeoutClient.close();

  const unknownReader = await createMockReaderServer({ stopReceiptMode: "unknown" });
  t.after(() => unknownReader.close());
  const unknownClient = startClient(undefined, { url: unknownReader.url });
  t.after(() => unknownClient.close());
  await unknownClient.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "stop-unknown-test", version: "1" } });
  const unknown = await unknownClient.tool("reader_session_control", {
    action: "stop", deviceId: "dev-a", sessionId: "active-001", dryRun: false, confirm: true,
    confirmationReason: "retain unknown receipt state", idempotencyKey: "stop-unknown-001",
  });
  assert.equal(unknown.outcome, "unknown");
  assert.equal(unknown.completion, "unobserved");
  assert.equal(unknown.stopObservation, "unknown");
  assert.equal(unknown.targetStopped, false);
  await unknownClient.close();
});

test("durable Reader replay and conflicts stay visible across adapter calls", async (t) => {
  const reader = await createMockReaderServer();
  t.after(() => reader.close());
  const client = startClient(undefined, { url: reader.url });
  t.after(() => client.close());
  await client.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "durable-receipt-test", version: "1" } });

  const replay = await client.tool("reader_session_control", {
    action: "prompt", deviceId: "dev-a", sessionId: "active-001", message: "replay fixture",
    dryRun: false, confirm: true, idempotencyKey: "reader-replay", confirmationReason: "fixture",
  });
  assert.equal(replay.outcome, "accepted");
  assert.equal(replay.readerOutcome, "completed");
  assert.equal(replay.readerReplayed, true);
  assert.equal(replay.readerReceipt.receiptId, "reader-receipt-001");

  const conflict = await client.tool("reader_session_control", {
    action: "prompt", deviceId: "dev-a", sessionId: "active-001", message: "conflict fixture",
    dryRun: false, confirm: true, idempotencyKey: "reader-conflict", confirmationReason: "fixture",
  });
  assert.equal(conflict.outcome, "conflict");
  assert.equal(conflict.code, "idempotency_conflict");
  assert.equal(conflict.existingReceiptId, "reader-receipt-001");
  await client.close();
});

function assertReaderCommandBody(actual, expected, idempotencyKey, expectedReason = "fixture") {
  const { idempotencyKey: actualKey, requestFingerprint, confirm, confirmationReason, dryRun, ...command } = actual;
  assert.equal(dryRun, false, "every real runtime POST must carry explicit execution intent");
  assert.deepEqual(command, expected);
  assert.equal(actualKey, idempotencyKey);
  assert.equal(typeof confirm, "boolean");
  assert.equal(confirm, true);
  assert.equal(confirmationReason, expectedReason);
  assert.match(requestFingerprint, /^[0-9a-f]{64}$/);
}

function startClient(root) {
  const options = arguments[1] ?? {};
  const childEnv = { ...process.env, NODE_NO_WARNINGS: "1" };
  if (options.env && typeof options.env === "object") Object.assign(childEnv, options.env);
  if (options.url) {
    delete childEnv.PI_WEB_READER_DATA_ROOT;
    childEnv.PI_WEB_READER_URL = options.url;
    delete childEnv.PI_WEB_READER_DEVICE_NAME;
  } else {
    childEnv.PI_WEB_READER_DATA_ROOT = root;
    delete childEnv.PI_WEB_READER_URL;
    childEnv.PI_WEB_READER_DEVICE_NAME = "fixture-mac-mini";
  }
  const child = spawn(process.execPath, [SERVER], {
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let nextId = 1;
  const pending = new Map();
  const notifications = [];
  const notificationWaiters = [];

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    let newline;
    while ((newline = stdout.indexOf("\n")) >= 0) {
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        rejectAll(new Error(`non-JSON stdout from MCP: ${line}`));
        continue;
      }
      if (!Object.hasOwn(message, "id") && message.method) {
        const waiter = notificationWaiters.shift();
        if (waiter) waiter.resolve(message);
        else notifications.push(message);
        continue;
      }
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      if (message.error) waiter.reject(Object.assign(new Error(message.error.message), { code: message.error.code, data: message.error.data }));
      else waiter.resolve(message.result);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.on("exit", (code, signal) => {
    rejectAll(new Error(`MCP exited before response (code=${code}, signal=${signal})`));
  });

  return {
    get lastRequestId() { return nextId - 1; },
    get notifications() { return notifications; },
    nextNotification(timeoutMs = 2_000) {
      if (notifications.length) return Promise.resolve(notifications.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = notificationWaiters.indexOf(waiter);
          if (index >= 0) notificationWaiters.splice(index, 1);
          reject(new Error("Timed out waiting for MCP notification"));
        }, timeoutMs);
        const waiter = { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } };
        notificationWaiters.push(waiter);
      });
    },
    get stderr() {
      return stderr;
    },
    call(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    async notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
      await new Promise((resolve) => setImmediate(resolve));
    },
    async tool(name, args) {
      const result = await this.call("tools/call", { name, arguments: args });
      assert.ok(Array.isArray(result.content));
      const payload = JSON.parse(result.content[0].text);
      if (result.isError) return { ...payload, __toolError: true };
      return payload;
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.stdin.end();
      await once(child, "exit");
    },
  };

  function rejectAll(error) {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    for (const waiter of notificationWaiters.splice(0)) waiter.reject(error);
  }
}

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reader-mcp-fixture-"));
  const active = path.join(root, "sessions", "demo");
  const archived = path.join(root, "archived_sessions", "demo");
  const debian = path.join(root, "sessions", "debian");
  const long = path.join(root, "sessions", "long");
  const nested = path.join(active, "nested");
  await fs.mkdir(active, { recursive: true });
  await fs.mkdir(archived, { recursive: true });
  await fs.mkdir(debian, { recursive: true });
  await fs.mkdir(long, { recursive: true });
  await fs.mkdir(nested, { recursive: true });

  await fs.writeFile(
    path.join(active, "active-001.jsonl"),
    [
      JSON.stringify({ type: "session", id: "active-001", cwd: "/home/reader/demo", title: "Active demo", timestamp: "2026-10-11T10:00:00.000Z" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "Inspect the Reader inventory" }, timestamp: "2026-10-11T10:01:00.000Z" }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: "Progress: token=super-secret-value api_key=api-secret-value" }, timestamp: "2026-10-11T10:02:00.000Z" }),
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(archived, "archived-001.jsonl"),
    [
      JSON.stringify({ type: "session", id: "archived-001", cwd: "/home/reader/archive", title: "Archived demo", timestamp: "2026-10-09T10:00:00.000Z" }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: "Archived result" }, timestamp: "2026-10-09T10:01:00.000Z" }),
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(debian, "named-debian-empty.jsonl"),
    `${JSON.stringify({ type: "session", id: "named-debian-empty", cwd: "/home/debian/project", title: "Named Debian empty session", timestamp: "2026-10-10T10:00:00.000Z" })}\n`,
  );
  await fs.writeFile(
    path.join(active, "duplicate-001.jsonl"),
    `${JSON.stringify({ type: "session", id: "duplicate-001", cwd: "/home/reader/demo", title: "Duplicate active", timestamp: "2026-10-08T10:00:00.000Z" })}\n`,
  );
  await fs.writeFile(
    path.join(archived, "duplicate-001.jsonl"),
    `${JSON.stringify({ type: "session", id: "duplicate-001", cwd: "/home/reader/archive", title: "Duplicate archived", timestamp: "2026-10-07T10:00:00.000Z" })}\n`,
  );
  await fs.writeFile(
    path.join(long, "long-001.jsonl"),
    [
      JSON.stringify({ type: "session", id: "long-001", cwd: "/home/reader/long", title: "Long output fixture", timestamp: "2026-10-06T10:00:00.000Z" }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: `Progress ${"x".repeat(5000)}` }, timestamp: "2026-10-06T10:01:00.000Z" }),
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(nested, "nested-should-not-list.jsonl"),
    `${JSON.stringify({ type: "session", id: "nested-should-not-list", cwd: "/nested" })}\n`,
  );
  await fs.writeFile(
    path.join(active, "invalid-artifact.jsonl"),
    `${JSON.stringify({ type: "not-a-session", id: "artifact-should-not-list" })}\n`,
  );
  await fs.writeFile(
    path.join(root, "sessions", "root-level-ignored.jsonl"),
    `${JSON.stringify({ type: "session", id: "root-level-ignored", cwd: "/root-level" })}\n`,
  );

  const outside = path.join(root, "outside-secret.jsonl");
  await fs.writeFile(outside, `${JSON.stringify({ type: "session", id: "outside-secret", cwd: "/outside" })}\n`);
  await fs.symlink(outside, path.join(active, "linked-outside.jsonl"));

  return { root };
}

async function createMockReaderServer(options = {}) {
  const onlineRemote = options.onlineRemote === true;
  const postDelayMs = Number.isFinite(options.postDelayMs) && options.postDelayMs > 0 ? options.postDelayMs : 0;
  const liveOldestCursor = Number.isSafeInteger(options.liveOldestCursor) && options.liveOldestCursor >= 1 ? options.liveOldestCursor : 1;
  const liveGapStatus = options.liveGapStatus === true;
  const createdRuntimeCwd = typeof options.createdRuntimeCwd === "string" ? options.createdRuntimeCwd : "/tmp";
  const createdRuntimeTools = Array.isArray(options.createdRuntimeTools) ? options.createdRuntimeTools : [];
  const createdRuntimeStrict = options.createdRuntimeStrict !== false;
  const stopReceiptMode = options.stopReceiptMode ?? "not_found";
  const stopRuntimeRunningAfterPost = options.stopRuntimeRunningAfterPost !== false;
  let stopPostAccepted = false;
  let stopReceiptReads = 0;
  const requests = [];
  const managedReceipts = new Map();
  let managedRevision = 1;
  let uiSnapshot = options.uiSnapshot ?? fixtureUiSnapshot();
  const uiStreams = new Set();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const body = await collectRequestBody(request);
    const record = { method: request.method, headers: request.headers, path: url.pathname, query: Object.fromEntries(url.searchParams), ...(body === undefined ? {} : { body }) };
    requests.push(record);

    if (request.method === "GET" && /^\/api\/(?:remote\/)?agent\/(?:active-001|remote-001)\/ui-requests$/.test(url.pathname)) {
      const snapshot = () => ({ ...uiSnapshot, sessionId: url.pathname.includes("remote-001") ? "remote-001" : "active-001" });
      if (url.searchParams.get("stream") !== "1") return sendJson(response, 200, snapshot());
      if (options.uiSseUnavailable) return sendJson(response, 404, { error: "unsupported" });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`event: ui_requests\ndata: ${JSON.stringify(snapshot())}\n\n`);
      const stream = { response, snapshot };
      uiStreams.add(stream);
      response.on("close", () => uiStreams.delete(stream));
      server.emit("uiStream");
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/reader/session-catalog") {
      response.on("close", () => { record.cancelledBeforeResponse = !response.writableFinished; });
      server.emit("catalogRequest");
      if (options.catalogDelayMs) await new Promise((resolve) => setTimeout(resolve, options.catalogDelayMs));
      const archived = url.searchParams.get("archived") === "1";
      const hidden = url.searchParams.get("scope") === "hidden";
    const baseSessions = archived
        ? hidden ? [readerApiSession("hidden-archived-001", "Hidden archived", "archived", "unknown", "2026-10-12T10:03:00.000Z")] : [readerApiSession("archived-001", "Archived demo", "archived", "idle", "2026-10-12T10:02:00.000Z")]
        : hidden ? [readerApiSession("hidden-001", "Hidden demo", "active", "waiting_user", "2026-10-12T10:01:00.000Z")] : [readerApiSession("active-001", "Active demo", "active", "running", "2026-10-12T10:04:00.000Z")];
      const sessions = onlineRemote && !archived && !hidden
        ? [...baseSessions, readerApiSession("remote-001", "Remote fixture", "active", "idle", "2026-10-12T10:00:00.000Z", "dev-b", "Remote laptop")]
        : baseSessions;
      return sendJson(response, 200, {
        schemaVersion: 1,
        ...(options.catalogUnsafe ? {} : { observation: {
          schemaVersion: 1, readOnly: true, runtimeStartAttempted: false, writeSideEffects: false,
        } }),
        generatedAt: "2026-10-12T10:05:00.000Z",
        device: { id: "dev-a", name: "Mac mini", online: true, lastSeenAt: "2026-10-12T10:05:00.000Z" },
        devices: [
          { id: "dev-a", name: "Mac mini", online: true, lastSeenAt: "2026-10-12T10:05:00.000Z" },
          onlineRemote
            ? { id: "dev-b", name: "Remote laptop", online: true, lastSeenAt: "2026-10-12T10:05:00.000Z" }
            : { id: "dev-b", name: "Offline laptop", online: false, error: "offline" },
        ],
        sessions,
      });
    }

    if (url.pathname === "/api/reader/control-plane") {
      if (options.managedUnavailable) return sendJson(response, 404, { error: "No managed route" });
      const input = request.method === "POST" ? body : Object.fromEntries(url.searchParams);
      const bound = { schemaVersion: 1, deviceId: options.managedWrongBinding ? "wrong-device" : input.deviceId, ...(options.legacyManagedCwd ? { cwd: input.cwd ?? null } : { cwdRef: input.cwd == null ? null : createHash("sha256").update(JSON.stringify(input.cwd)).digest("hex") }), scope: input.scope, area: input.area, sessionId: null, bootId: "config-boot-1" };
      const supportedOperations = input.area === "subagent_profiles" ? ["upsert", "delete", "set_enabled"] : input.area === "models_config" ? [] : ["set_codemode", "set_default"];
      if (request.method === "GET") {
        if (input.receiptId || input.idempotencyKey) {
          const receipt = input.receiptId ? [...managedReceipts.values()].find((item) => item.receiptId === input.receiptId) : managedReceipts.get(input.idempotencyKey);
          if (!receipt) return options.managedReceiptMissing404 ? sendJson(response, 404, { code: "receipt_not_found" }) : sendJson(response, 200, { ...bound, receipt: null, outcome: options.managedReceiptLegacyOutcome ? "not_found" : "unknown", readOnly: true, runtimeStartAttempted: false });
          return sendJson(response, 200, { ...bound, receipt, outcome: receipt.outcome });
        }
        return sendJson(response, 200, { ...bound, revision: `config-revision-${managedRevision}`, value: { codemode: "automatic", apiKey: "redacted-fixture" }, readOnly: true, supportedOperations, authorization: { source: "reader-owner-policy", scope: "config:write", callerScopedGrants: false } });
      }
      if (request.method === "POST") {
        if (input.dryRun === true) {
          if (options.managedDryRunRejected) return sendJson(response, 400, { code: "invalid_config_change", error: "Fixture validation refusal" });
          return sendJson(response, 200, { success: true, accepted: false, outcome: "dry_run", sideEffect: "none", snapshot: { ...bound, revision: `config-revision-${managedRevision}`, value: { codemode: "automatic" }, supportedOperations } });
        }
        if (input.cwd === "/forbidden") return sendJson(response, 403, { outcome: "blocked", code: "access_denied" });
        const existing = managedReceipts.get(input.idempotencyKey);
        if (existing) {
          if (existing.clientRequestFingerprint !== input.requestFingerprint) return sendJson(response, 409, { outcome: "conflict", code: "idempotency_conflict", receipt: existing });
          return sendJson(response, 200, { success: true, accepted: true, outcome: existing.outcome, receipt: existing, replayed: true });
        }
        if (input.expectedBootId !== "config-boot-1") return sendJson(response, 409, { outcome: "conflict", code: "boot_changed" });
        if (input.expectedRevision !== `config-revision-${managedRevision}`) return sendJson(response, 409, { outcome: "conflict", code: "revision_conflict" });
        const receipt = { receiptId: `config-receipt-${managedRevision}`, outcome: "completed", operation: input.operation, clientRequestFingerprint: input.requestFingerprint, scope: input.scope, deviceId: input.deviceId, revision: `config-revision-${managedRevision + 1}` };
        managedReceipts.set(input.idempotencyKey, receipt);
        managedRevision += 1;
        if (options.managedDisconnect) { response.destroy(); return; }
        return sendJson(response, 200, { success: true, accepted: true, outcome: "completed", receipt });
      }
      return sendJson(response, 405, { error: "Method not allowed" });
    }

    if (request.method === "GET" && url.pathname === "/api/models") {
      return sendJson(response, 200, {
        models: [{ provider: "fixture", id: "model-a", name: "Fixture model" }],
        defaultModel: { provider: "fixture", modelId: "model-a" },
        cwd: url.searchParams.get("cwd"),
      });
    }

    if (request.method === "GET" && url.pathname === "/api/models/enabled") {
      return sendJson(response, 200, {
        patterns: ["fixture/*"],
        scope: "project",
        cwd: url.searchParams.get("cwd"),
      });
    }

    if (request.method === "GET" && url.pathname === "/api/models-config") {
      const fixture = typeof options.modelsConfigBody === "function" ? options.modelsConfigBody() : options.modelsConfigBody;
      return sendJson(response, 200, fixture ?? {
        providers: [{ id: "fixture", name: "Fixture provider", apiKey: "secret-api-key" }],
      });
    }

    if (request.method === "GET" && url.pathname === "/api/models-config/catalog") {
      return sendJson(response, 200, {
        models: [{ provider: "fixture", id: "model-a", name: "Fixture model" }],
        recommendation: { provider: "fixture", modelId: "model-a" },
        source: "https://models.dev/api.json",
      });
    }

    if (request.method === "GET" && url.pathname === "/api/tools/settings") {
      return sendJson(response, 200, { isWindows: false, powerShellEnabled: false, codemode: true, codemodeMode: "on" });
    }

    if (request.method === "GET" && url.pathname === "/api/skills") {
      return sendJson(response, 200, {
        skills: [{ name: "fixture-skill", scope: url.searchParams.get("scope") ?? "project" }],
        cwd: url.searchParams.get("cwd"),
      });
    }

    if (request.method === "GET" && url.pathname === "/api/plugins") {
      return sendJson(response, 200, {
        plugins: [{ source: "fixture-plugin", scope: url.searchParams.get("scope") ?? "project" }],
        cwd: url.searchParams.get("cwd"),
      });
    }

    if (request.method === "GET" && url.pathname === "/api/mcp") {
      return sendJson(response, 200, {
        servers: [{ name: "fixture-mcp", scope: url.searchParams.has("cwd") ? "project" : "global" }],
        cwd: url.searchParams.get("cwd"),
      });
    }

    if (request.method === "GET" && url.pathname === "/api/agent/running") {
      return sendJson(response, 200, {
        sessionListVersion: 7,
        runningSessionIds: ["active-001"],
        completionNotificationSuppressedSessionIds: [],
      });
    }

    if (request.method === "GET" && url.pathname === "/api/agent/active-001/tools") {
      return sendJson(response, 200, { schemaVersion: 1, deviceId: "dev-a", sessionId: "active-001", ...(options.legacyManagedCwd ? { cwd: "/private/project" } : { cwdRef: createHash("sha256").update(JSON.stringify("/private/project")).digest("hex") }), revision: "settings-1", bootId: "boot-1", model: { provider: "fixture", id: "model-1" }, thinkingLevel: "low", strictToolAllowlist: true, selectionSemantics: "exact-registered-built-in-subset", tools: [{ name: "ls", active: true }] });
    }

    if (request.method === "GET" && url.pathname === "/api/agent/active-001") {
      const state = options.inspectHugeState
        ? {
          sessionId: "active-001",
          isStreaming: true,
          isPromptRunning: true,
          isBashRunning: false,
          isCompacting: false,
          strictToolAllowlist: true,
          autoCompactionEnabled: true,
          autoRetryEnabled: false,
          messageCount: 17,
          pendingMessageCount: 2,
          thinkingLevel: "max",
          queueRevision: "queue-fixture-001",
          model: { provider: "fixture", id: "model-1", secret: "redacted-fixture" },
          contextUsage: { percent: 42.5, contextWindow: 256000, tokens: 32000 },
          systemPrompt: "x".repeat(1_000_000),
          runtimeInspection: {
            sessionId: "active-001",
            capturedAt: "2026-10-12T10:06:00.000Z",
            snapshotId: "fixture-snapshot-001",
            systemPrompt: { characters: 1_000_000, lines: 10_000, estimatedTokens: 250_000, sha256: "a".repeat(64) },
            evidence: { basis: "agent-session-runtime", providerRequestCaptured: false, systemPromptSource: "agent.state.systemPrompt", note: "fixture" },
            tools: Array.from({ length: 200 }, (_, index) => ({ name: `tool-${index}`, active: index % 2 === 0, mentionedInSystemPrompt: true, description: "x".repeat(5_000), parameters: { type: "object" } })),
            skills: Array.from({ length: 200 }, (_, index) => ({ name: `skill-${index}`, promptVisible: true, disableModelInvocation: false, description: "x".repeat(5_000) })),
            extensions: Array.from({ length: 200 }, (_, index) => ({ status: "loaded", registeredTools: [`tool-${index}`], registeredCommands: [`command-${index}`], path: `/private/extension-${index}.ts` })),
            contextSources: Array.from({ length: 200 }, () => ({ scope: "project", origin: "fixture", path: "/private/source.md", inSystemPrompt: true })),
          },
          extensionWidgets: Array.from({ length: 100 }, () => ({ lines: ["x".repeat(10_000)] })),
        }
        : { isStreaming: true, sessionFile: "/private/reader.jsonl", cwd: "/private/project", token: "secret-token" };
      return sendJson(response, 200, {
        running: !(stopPostAccepted && !stopRuntimeRunningAfterPost),
        state,
      });
    }

    if (request.method === "GET" && url.pathname === "/api/agent/active-001/receipt" && url.searchParams.get("operation") === "abort") {
      const idempotencyKey = url.searchParams.get("idempotencyKey");
      stopReceiptReads += 1;
      if (options.stopReceiptDelayMs) await new Promise((resolve) => setTimeout(resolve, options.stopReceiptDelayMs));
      if (stopReceiptMode === "observed" || (stopReceiptMode === "eventual" && stopReceiptReads > 1)) {
        return sendJson(response, 200, {
          source: "reader-control-receipt",
          outcome: "aborted",
          receipt: { receiptId: "stop-receipt-001", idempotencyKey, operation: "abort", outcome: "aborted", targetStopped: true },
        });
      }
      if (stopReceiptMode === "eventual") {
        return sendJson(response, 200, {
          source: "reader-control-receipt",
          outcome: "aborted",
          receipt: { receiptId: "stop-receipt-001", idempotencyKey, operation: "abort", outcome: "aborted", targetStopped: false },
        });
      }
      if (stopReceiptMode === "unobserved") {
        return sendJson(response, 200, {
          source: "reader-control-receipt",
          outcome: "failed",
          receipt: { receiptId: "stop-receipt-002", idempotencyKey, operation: "abort", outcome: "failed", targetStopped: false },
        });
      }
      if (stopReceiptMode === "unknown") {
        return sendJson(response, 503, { code: "receipt_unavailable", error: "fixture receipt unavailable" });
      }
      return sendJson(response, 404, { code: "receipt_not_found", error: "fixture receipt not found" });
    }

    if (request.method === "GET" && url.pathname === "/api/agent/new/receipt") {
      const matched = url.searchParams.get("receiptId") === "create-receipt-001"
        || (url.searchParams.get("operation") === "create_session"
          && url.searchParams.get("idempotencyKey") === "fixture-create-receipt-key");
      if (!matched) return sendJson(response, 404, { code: "receipt_not_found" });
      return sendJson(response, 200, {
        source: "reader-control-receipt",
        outcome: "unknown",
        receipt: {
          receiptId: "create-receipt-001", deviceId: "dev-a", sessionId: "new",
          operation: "create_session", outcome: "unknown", idempotencyKeyRef: "redacted-key-reference",
          cwdRef: "redacted-cwd-reference", error: { code: "create_outcome_unknown", message: "Inspect before any retry" },
        },
        target: { deviceId: "dev-a", sessionId: "new" },
        runtimeStartAttempted: false,
        writeSideEffects: false,
      });
    }

    if (request.method === "GET" && url.pathname === "/api/agent/hidden-001") {
      return sendJson(response, 200, { running: false });
    }

    if (request.method === "GET" && url.pathname === "/api/agent/created-001") {
      return sendJson(response, 200, {
        running: true,
        state: {
          strictToolAllowlist: createdRuntimeStrict,
          runtimeInspection: {
            cwd: createdRuntimeCwd,
            systemPrompt: { characters: 0 },
            tools: createdRuntimeTools.map((name) => ({ name, active: true })),
          },
        },
      });
    }

    if (request.method === "GET" && url.pathname === "/api/agent/active-001/live" && url.searchParams.get("bootId") !== "old-boot") {
      if (options.liveCoverageUnavailable) return sendJson(response, 503, { code: "coverage_incomplete", outcome: "unknown" });
      const cursor = Number(url.searchParams.get("cursor") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "50");
      if (options.liveCursorAhead && cursor > 6) return sendJson(response, 409, { code: "cursor_ahead", outcome: "reset_required", recoverFromCursor: 6 });
      if (liveGapStatus && cursor === 1) {
        return sendJson(response, 409, {
          source: "reader-live-runtime",
          runtimeStatus: "live",
          outcome: "gap",
          code: "gap",
          bootId: "boot-fixture-001",
          sessionId: "active-001",
          cursor,
          oldestCursor: liveOldestCursor,
          nextCursor: 6,
          truncated: true,
          recoverFromCursor: liveOldestCursor - 1,
          reason: "fixture retained-window gap",
          runtimeStartAttempted: false,
          writeSideEffects: false,
          durableLedger: { available: true, replay: true, retention: "bounded-per-session" },
        });
      }
      const allEvents = [
        { cursor: 1, event: { type: "agent_start" } },
        { cursor: 2, event: { type: "message_start", message: { role: "assistant", content: "draft" } } },
        { cursor: 3, event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial" } } },
        { cursor: 4, event: { type: "tool_execution_start", toolCallId: "tool-001", toolName: "ls" } },
        { cursor: 5, event: { type: "tool_execution_update", toolCallId: "tool-001", toolName: "ls", secret: "[REDACTED]", longText: "x" } },
        { cursor: 6, event: { type: "tool_execution_end", toolCallId: "tool-001", toolName: "ls", isError: false } },
      ];
      const events = allEvents.filter((event) => event.cursor > cursor).slice(0, limit);
      return sendJson(response, 200, {
        source: options.durableReplay ? "reader-durable-live-ledger" : "reader-live-runtime",
        outcome: options.durableReplay ? "replayed" : "observed",
        runtimeStatus: options.durableReplay ? "not_live" : "live",
        coverageIncomplete: options.durableReplay === true,
        durableLedger: { available: true, coverageComplete: !options.durableReplay, replay: true,
          ...(options.durableReplay ? { unpersistedTail: "unknown-without-live-runtime" } : {}) },
        bootId: options.durableReplay ? (options.legacyStoppedBoot ? "old-runtime-boot" : "reader-process-2") : "boot-fixture-001",
        ...(options.durableReplay ? { bootScope: "reader-process", readerBootId: "reader-process-2", replayedRuntimeBootId: "old-runtime-boot" } : {}),
        cursor: 6,
        nextCursor: events.at(-1)?.cursor ?? cursor,
        oldestCursor: liveOldestCursor,
        truncated: false,
        bytesRead: 300,
        isStreaming: true,
        isPromptRunning: true,
        events,
        activeToolEvents: [],
        runtimeStartAttempted: options.liveUnsafeProof === true,
        writeSideEffects: false,
      });
    }

    if (request.method === "GET" && url.pathname === "/api/agent/active-001/live" && url.searchParams.get("bootId") === "old-boot") {
      if (options.processBootChanged) return sendJson(response, 409, { code: "boot_changed", bootScope: "reader-process",
        readerBootId: "reader-process-2", bootId: null, runtimeStatus: "not_live" });
      return sendJson(response, 409, { code: "boot_changed", bootId: "boot-fixture-002", error: "boot changed" });
    }

    if (request.method === "GET" && (url.pathname === "/api/sessions/created-001/safe-history" || url.pathname === "/api/sessions/active-001/safe-history")) {
      const isCreated = url.pathname.includes("created-001");
      if (options.safeHistoryRoute) {
        const result = await options.safeHistoryRoute(new Request(url), { params: Promise.resolve({ id: isCreated ? "created-001" : "active-001" }) });
        response.writeHead(result.status, Object.fromEntries(result.headers));
        return response.end(await result.text());
      }
      return sendJson(response, 200, {
        source: "reader-safe-history",
        sessionId: isCreated ? "created-001" : "active-001",
        ...(options.safeHistoryMissingPath ? {} : { sessionFilePath: `/tmp/session-${isCreated ? "created-001" : "active-001"}.jsonl` }),
        runtimeStatus: options.safeHistoryNonLive ? "not_live" : "live",
        durableOnly: options.safeHistoryNonLive === true,
        runtimeStartAttempted: false,
        writeSideEffects: false,
        snapshotRevision: "fixture-revision-1",
        entries: options.safeHistoryEntries ?? [
          { role: "user", text: "fixture prompt", timestamp: "2026-10-12T10:06:00.000Z" },
          { role: "assistant", text: "fixture assistant output", timestamp: "2026-10-12T10:06:01.000Z" },
          { role: "toolResult", entryId: "entry-tool-001", text: "fixture deferred tool output", isError: false, timestamp: "2026-10-12T10:06:02.000Z" },
        ],
        returnedCount: 3,
        bytesRead: 300,
        truncated: false,
        coverage: { source: options.safeHistoryNonLive ? "persisted-jsonl" : "live-memory", complete: options.safeHistoryNonLive === true },
      });
    }

    if (request.method === "GET" && url.pathname === "/api/sessions/created-001") {
      return sendJson(response, 200, {
        info: { cwd: createdRuntimeCwd, transient: true },
        context: {
          messages: [
            { role: "user", content: "fixture prompt", entryTimestamp: "2026-10-12T10:06:00.000Z" },
            { role: "assistant", content: [{ type: "text", text: "fixture assistant output" }, { type: "toolCall", name: "ls" }], entryTimestamp: "2026-10-12T10:06:01.000Z" },
            { role: "toolResult", entryId: "entry-tool-001", deferredText: true, content: [{ type: "text", text: "[deferred]" }], isError: false, entryTimestamp: "2026-10-12T10:06:02.000Z" },
          ],
        },
        stats: { totalMessages: 3 },
      });
    }

    if (request.method === "GET" && url.pathname === "/api/sessions/created-001/entries/entry-tool-001/tool-result") {
      return sendJson(response, 200, { text: "fixture deferred tool output" });
    }

    if (request.method === "POST" && url.pathname === "/api/agent/active-001") {
      if (body?.type === "answer_question" && options.uiAnswers) {
        if (body.runtimeGeneration !== uiSnapshot.runtimeGeneration) return sendJson(response, 409, { success: false, code: "ui_generation_conflict", error: "Runtime changed" });
        const pending = uiSnapshot.requests.find((item) => item.id === body.questionId);
        if (!pending) return sendJson(response, 409, { success: false, code: "ui_request_not_pending", error: "Request is no longer pending" });
        const answer = body.cancelled === true ? { cancelled: true } : typeof body.confirmed === "boolean" ? { confirmed: body.confirmed } : { value: body.answer };
        uiSnapshot = { ...uiSnapshot, revision: uiSnapshot.revision + 1, requests: uiSnapshot.requests.filter((item) => item.id !== pending.id) };
        if (pending.method === "select" && body.answer === "手动输入") uiSnapshot.requests.push(fixtureUiRequest("manual-input-2", "input", uiSnapshot.runtimeGeneration));
        for (const stream of uiStreams) stream.response.write(`event: ui_requests\ndata: ${JSON.stringify(stream.snapshot())}\n\n`);
        return sendJson(response, 200, { success: true, accepted: true, outcome: "accepted", data: { questionId: body.questionId, runtimeGeneration: body.runtimeGeneration, response: answer } });
      }
      if (body?.type === "abort") stopPostAccepted = true;
      if (body?.idempotencyKey === "reader-replay") {
        return sendJson(response, 200, { success: true, accepted: true, outcome: "completed", replayed: true, receipt: { receiptId: "reader-receipt-001", outcome: "completed" } });
      }
      if (body?.idempotencyKey === "reader-conflict") {
        return sendJson(response, 409, { success: false, accepted: false, outcome: "conflict", code: "idempotency_conflict", error: "fixture idempotency conflict", receipt: { receiptId: "reader-receipt-001", outcome: "completed" } });
      }
      return sendJson(response, 200, { success: true, data: { accepted: true, token: "secret-token" } });
    }

    if (request.method === "POST" && url.pathname === "/api/agent/created-001") {
      return sendJson(response, 200, { success: true, data: { accepted: true } });
    }

    if (request.method === "POST" && url.pathname === "/api/agent/new") {
      if (postDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, postDelayMs));
      if (options.createOutcomeUnknown) {
        return sendJson(response, 202, {
          success: false,
          accepted: true,
          outcome: "unknown",
          code: "create_runtime_start_failed",
          error: "Reader could not confirm session startup",
          receipt: {
            receiptId: "create-unknown-001",
            sessionId: "new",
            outcome: "unknown",
            error: { code: "create_runtime_start_failed", message: "Reader could not confirm session startup" },
          },
          runtimeStartAttempted: true,
        });
      }
      return sendJson(response, 200, { success: true, sessionId: "created-001", sessionBootId: "boot-fixture-session-001", data: null });
    }

    if (onlineRemote && request.method === "GET" && url.pathname === "/api/remote/agent/remote-001" && url.searchParams.get("peer") === "dev-b") {
      return sendJson(response, 200, { running: true, state: { isStreaming: false } });
    }

    if (onlineRemote && request.method === "POST" && url.pathname === "/api/remote/agent/remote-001" && url.searchParams.get("peer") === "dev-b") {
      return sendJson(response, 200, { success: true, data: { accepted: true } });
    }

    return sendJson(response, 404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    get uiStreamCount() { return uiStreams.size; },
    nextUiStream() { return once(server, "uiStream"); },
    nextCatalogRequest() { return once(server, "catalogRequest"); },
    updateUiSnapshot(next) {
      uiSnapshot = next;
      for (const stream of uiStreams) stream.response.write(`event: ui_requests\ndata: ${JSON.stringify(stream.snapshot())}\n\n`);
    },
    heartbeatUiStreams() { for (const stream of uiStreams) stream.response.write(": heartbeat\n\n"); },
    endUiStreams() { for (const stream of uiStreams) stream.response.end(); },
    rawUiFrame(text) { for (const stream of uiStreams) stream.response.write(text); },
    async close() {
      if (!server.listening) return;
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

function readerApiSession(id, name, storageScope, status, lastActivityAt, deviceId = "dev-a", deviceName = "Mac mini") {
  return {
    device: { id: deviceId, name: deviceName, online: true, lastSeenAt: "2026-10-12T10:05:00.000Z" },
    session: {
      id,
      name,
      firstMessage: name,
      created: "2026-10-12T09:00:00.000Z",
      modified: lastActivityAt,
      messageCount: 3,
    },
    projectLabel: "demo",
    projectKey: "demo-key",
    status,
    lastActivityAt,
    lastUserMessage: "Fixture request",
    lastAskedAt: lastActivityAt,
    latestRun: { runId: `run-${id}`, sessionId: id, startedAt: lastActivityAt, updatedAt: lastActivityAt, status },
    runs: [],
    waitingRequestIds: status === "waiting_user" ? ["wait-1"] : [],
    storageScope,
  };
}

async function collectRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  try { return JSON.parse(text); } catch { return text; }
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function snapshotTree(root) {
  const result = [];
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      const stat = await fs.lstat(absolute);
      const item = {
        path: relative,
        type: stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "file",
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
      if (stat.isSymbolicLink()) item.target = await fs.readlink(absolute);
      result.push(item);
      if (stat.isDirectory()) await visit(absolute);
    }
  }
  await visit(root);
  return result;
}

async function collectStream(stream) {
  let text = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream) text += chunk;
  return text;
}

async function removeTree(root) {
  await fs.rm(root, { recursive: true, force: true });
}


test("live settings expose bounded GET inventory and send exact model/tools mutations with caller CAS", async (t) => {
  const reader = await createMockReaderServer();
  t.after(() => reader.close());
  const client = await managedClient(t, reader);
  const inventory = await client.tool("reader_session_control", { action: "get_tools", deviceId: "dev-a", sessionId: "active-001", cwd: "/private/project" });
  assert.equal(inventory.outcome, "observed");
  assert.equal(inventory.revision, "settings-1");
  assert.deepEqual(inventory.tools, [{ name: "ls", active: true }]);
  assert.equal(inventory.target.cwd, undefined);
  assert.match(inventory.target.cwdRef, /^[a-f0-9]{64}$/);
  assert.equal(reader.requests.filter(r => r.method === "POST").length, 0);
  const base = { deviceId: "dev-a", sessionId: "active-001", cwd: "/private/project", dryRun: false, confirm: true, confirmationReason: "isolated live settings", expectedBootId: inventory.bootId, expectedRevision: inventory.revision };
  const missing = await client.tool("reader_session_control", { ...base, action: "set_tools", toolNames: [], expectedRevision: undefined, idempotencyKey: "settings-no-cas" });
  assert.equal(missing.__toolError, true);
  const tools = await client.tool("reader_session_control", { ...base, action: "set_tools", toolNames: [], idempotencyKey: "settings-tools-1" });
  assert.equal(tools.outcome, "accepted");
  const setTools = reader.requests.find(r => r.method === "POST" && r.body.type === "set_tools");
  assert.deepEqual(setTools.body.toolNames, []);
  assert.equal(setTools.body.dryRun, false);
  assert.equal(setTools.body.deviceId, "dev-a");
  assert.equal(setTools.body.cwd, "/private/project");
  assert.equal(setTools.body.expectedRevision, inventory.revision);
  assert.equal(setTools.body.message, undefined);
  await client.tool("reader_session_control", { ...base, action: "set_model", provider: "fixture", modelId: "model-1", thinkingLevel: "low", idempotencyKey: "settings-model-1" });
  const setModel = reader.requests.find(r => r.method === "POST" && r.body.type === "set_model");
  assert.equal(setModel.body.dryRun, false);
  assert.equal(setModel.body.provider, "fixture");
  assert.equal(setModel.body.modelId, "model-1");
  assert.equal(setModel.body.thinkingLevel, "low");
  const conflict = await client.tool("reader_session_control", { ...base, action: "set_model", provider: "fixture", modelId: "different", idempotencyKey: "settings-model-1" });
  assert.equal(conflict.outcome, "conflict");
  assert.equal(reader.requests.filter(r => r.method === "POST").length, 2);
});

test("managed reads reject legacy raw-cwd contracts instead of falling back", async (t) => {
  const reader = await createMockReaderServer({ legacyManagedCwd: true });
  t.after(() => reader.close());
  const client = await managedClient(t, reader);
  const config = await client.tool("reader_read_control_plane", { area: "tools_settings", managed: true, deviceId: "dev-a", scope: "global" });
  assert.equal(config.code, "reader_contract_mismatch");
  const tools = await client.tool("reader_session_control", { action: "get_tools", deviceId: "dev-a", sessionId: "active-001", cwd: "/private/project" });
  assert.equal(tools.code, "reader_contract_mismatch");
  assert.equal(reader.requests.some(r => r.method === "POST"), false);
});


test("config-only MCP definitions, undo ids, model metadata and project tools reach only the managed owner", async (t) => {
  const reader = await createMockReaderServer();
  t.after(() => reader.close());
  const client = await managedClient(t, reader);
  const operations = [
    { area: "mcp", operation: "add", name: "isolated", server: { url: "https://example.invalid/mcp", enabled: false } },
    { area: "mcp", operation: "undo", undoId: "isolated-undo" },
    { area: "models_config", operation: "set_model_metadata", provider: "fixture", modelId: "model-1", name: "Fixture metadata" },
    { area: "tools_settings", operation: "set_codemode", scope: "project", cwd: "/private/project", codemode: "automatic" },
  ];
  for (const [index, operation] of operations.entries()) {
    const result = await client.tool("reader_write_control_plane", { deviceId: "dev-a", scope: "global", ...operation, dryRun: false, confirm: true, confirmationReason: "isolated transport test", idempotencyKey: `extra-config-${index}`, expectedRevision: `config-revision-${index + 1}`, expectedBootId: "config-boot-1" });
    assert.equal(result.outcome, "completed");
    const sent = reader.requests.filter(r => r.method === "POST" && r.path === "/api/reader/control-plane").at(-1);
    assert.ok(sent, JSON.stringify(result));
    assert.equal(sent.body.area, operation.area);
    assert.equal(sent.body.operation, operation.operation);
    if (operation.server) assert.deepEqual(sent.body.changes.server, operation.server);
    if (operation.undoId) assert.equal(sent.body.changes.undoId, operation.undoId);
    if (operation.scope === "project") assert.equal(sent.body.cwd, operation.cwd);
  }
  const forbidden = await client.tool("reader_write_control_plane", { deviceId: "dev-a", scope: "global", area: "mcp", operation: "add", name: "forbidden", server: { url: "https://example.invalid", headers: { Authorization: "not accepted" } } });
  assert.equal(forbidden.__toolError, true);
});


test("profile CRUD binds exact scope and explicit tools to the existing managed owner", async (t) => {
  const reader = await createMockReaderServer(); t.after(() => reader.close());
  const client = await managedClient(t, reader);
  const common = { area: "subagent_profiles", deviceId: "dev-a", scope: "project", cwd: "/private/project" };
  const snapshot = await client.tool("reader_read_control_plane", { ...common, managed: true });
  assert.equal(snapshot.outcome, "observed");
  const args = { ...common, operation: "upsert", name: "fixture", systemPrompt: "Isolated profile.", tools: ["ls"], enabled: false, defaultContext: "fresh" };
  const dryRun = await client.tool("reader_write_control_plane", args);
  assert.equal(dryRun.outcome, "dry_run");
  const checked = reader.requests.find(request => request.method === "POST" && request.body.area === "subagent_profiles");
  assert.equal(checked.body.dryRun, true);
  assert.deepEqual(checked.body.changes.tools, ["ls"]);
  for (const patch of [{ cwd: undefined }, { name: "../escape" }, { tools: undefined }, { tools: ["external_tool"] }, { tools: ["ls", "ls"] }, { inheritSkills: "true" }]) {
    const invalid = await client.tool("reader_write_control_plane", { ...args, ...patch });
    assert.equal(invalid.__toolError, true);
  }
  const current = await client.tool("reader_read_control_plane", { ...common, managed: true });
  const result = await client.tool("reader_write_control_plane", { ...args, dryRun: false, confirm: true, confirmationReason: "Isolated profile fixture", idempotencyKey: "profile-upsert-001", expectedRevision: current.revision, expectedBootId: current.bootId });
  assert.equal(result.outcome, "completed");
  const sent = reader.requests.find(request => request.method === "POST" && request.body.idempotencyKey === "profile-upsert-001");
  assert.equal(sent.path, "/api/reader/control-plane");
  assert.equal(sent.body.scope, "project");
  assert.equal(sent.body.cwd, "/private/project");
  assert.deepEqual(sent.body.changes, { enabled: false, name: "fixture", systemPrompt: "Isolated profile.", tools: ["ls"], defaultContext: "fresh" });
});


test("session control treats injected strictToolAllowlist false as a no-op outside create_session", async (t) => {
  const reader = await createMockReaderServer();
  t.after(() => reader.close());
  const client = await managedClient(t, reader);

  const tools = await client.call("tools/list", {});
  const controlTool = tools.tools.find((tool) => tool.name === "reader_session_control");
  assert.equal(controlTool.inputSchema.properties.strictToolAllowlist.default, undefined);

  const omitted = await client.tool("reader_session_control", {
    action: "inspect",
    deviceId: "dev-a",
    sessionId: "active-001",
  });
  assert.equal(omitted.outcome, "observed");

  const explicitFalse = await client.tool("reader_session_control", {
    action: "inspect",
    deviceId: "dev-a",
    sessionId: "active-001",
    strictToolAllowlist: false,
  });
  assert.equal(explicitFalse.outcome, "observed");

  const explicitTrue = await client.tool("reader_session_control", {
    action: "inspect",
    deviceId: "dev-a",
    sessionId: "active-001",
    strictToolAllowlist: true,
  });
  assert.equal(explicitTrue.__toolError, true);
  assert.match(explicitTrue.error, /only for create_session/);
  assert.equal(reader.requests.filter((request) => request.path === "/api/agent/active-001" && request.method === "POST").length, 0);
});

test("session control supports multimodal images, answer_question, dry-run hints, and tail sessionFilePath guidance", async (t) => {
  const reader = await createMockReaderServer();
  t.after(() => reader.close());
  const client = await managedClient(t, reader);

  // 1. tools/list contains embedded AI WORKFLOW GUIDE
  const tools = await client.call("tools/list", {});
  const controlTool = tools.tools.find((tool) => tool.name === "reader_session_control");
  assert.ok(controlTool.description.includes("[AI WORKFLOW GUIDE]"));
  assert.match(controlTool.inputSchema.properties.expectedBootId.description, /create_session accepts a Reader-process boot id.*session-scoped createdSessionBootId/);

  // 2. dry-run returns actionable hint
  const dryRun = await client.tool("reader_session_control", {
    action: "prompt",
    deviceId: "dev-a",
    sessionId: "active-001",
    message: "hello",
    dryRun: true,
  });
  assert.equal(dryRun.outcome, "dry_run");
  assert.ok(dryRun.hint && dryRun.hint.includes("confirm: true"));

  // 3. answer_question sends extension_ui_response with questionId and answer
  const answered = await client.tool("reader_session_control", {
    action: "answer_question",
    deviceId: "dev-a",
    sessionId: "active-001",
    questionId: "q-101",
    runtimeGeneration: "generation-1",
    answer: "Option B",
    dryRun: false,
    confirm: true,
    confirmationReason: "User selected Option B",
    idempotencyKey: "ans-key-001",
  });
  assert.equal(answered.outcome, "accepted");
  const answerPost = reader.requests.filter((r) => r.method === "POST" && r.path === "/api/agent/active-001").at(-1);
  assert.equal(answerPost.body.type, "answer_question");
  assert.equal(answerPost.body.questionId, "q-101");
  assert.equal(answerPost.body.answer, "Option B");

  // 4. prompt with multimodal images validates and passes images array
  const imagePrompt = await client.tool("reader_session_control", {
    action: "prompt",
    deviceId: "dev-a",
    sessionId: "active-001",
    message: "analyze this screenshot",
    images: [
      { data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", mimeType: "image/png" },
    ],
    dryRun: false,
    confirm: true,
    confirmationReason: "Visual inspection",
    idempotencyKey: "img-prompt-001",
  });
  assert.equal(imagePrompt.outcome, "accepted");
  const imgPost = reader.requests.filter((r) => r.method === "POST" && r.path === "/api/agent/active-001").at(-1);
  assert.equal(imgPost.body.message, "analyze this screenshot");
  assert.ok(Array.isArray(imgPost.body.images));
  assert.equal(imgPost.body.images[0].mimeType, "image/png");

  // 5. malformed Base64 is rejected before a control POST is possible
  const postCountBeforeInvalidImage = reader.requests.filter((r) => r.method === "POST" && r.path === "/api/agent/active-001").length;
  const invalidImage = await client.tool("reader_session_control", {
    action: "prompt",
    deviceId: "dev-a",
    sessionId: "active-001",
    message: "reject malformed image",
    images: [{ data: "!!!not-base64!!!", mimeType: "image/png" }],
    dryRun: true,
  });
  assert.equal(invalidImage.__toolError, true);
  assert.match(invalidImage.error, /valid Base64/);
  assert.equal(reader.requests.filter((r) => r.method === "POST" && r.path === "/api/agent/active-001").length, postCountBeforeInvalidImage);

  // 6. reader_read_tail returns sessionFilePath when available
  const tail = await client.tool("reader_read_tail", { sessionId: "active-001" });
  assert.equal(tail.found, true);
  assert.equal(tail.sessionFilePath, "/tmp/session-active-001.jsonl");
});

test("reader_read_tail gives an executable bounded retry when Reader omits its JSONL path", async (t) => {
  const reader = await createMockReaderServer({ safeHistoryMissingPath: true, safeHistoryNonLive: true });
  t.after(() => reader.close());
  const client = await managedClient(t, reader);
  const tail = await client.tool("reader_read_tail", { sessionId: "active-001" });
  assert.equal(tail.found, true);
  assert.equal(tail.runtimeStatus, "not_live");
  assert.equal(tail.durableOnly, true);
  assert.equal(tail.sessionFilePath, null);
  assert.match(tail.guidance, /reader_read_tail.*maxEntries: 50.*maxBytes: 131072/);
  assert.doesNotMatch(tail.guidance, /physical JSONL file at sessionFilePath/);
});

// Execute the complete checked-in GET handler and its real integer parser,
// replacing only the Next response adapter and history I/O. This keeps this
// standalone package dependency-free and catches wire-budget drift without
// copying the production limit into the HTTP fixture.
async function safeHistoryRouteFixture() {
  const repoRoot = path.resolve(import.meta.dirname, "../../..");
  const runtimeCode = (source) => stripTypeScriptTypes(source)
    .replace(/^import[\s\S]*?;\n/gm, "")
    .replace(/^export\s+\{[^}]*\};?\s*$/gm, "")
    .replace(/^export /gm, "");
  const historySource = await fs.readFile(path.join(repoRoot, "lib/reader-safe-history.ts"), "utf8");
  const boundedSafeHistoryInteger = vm.runInNewContext(`${runtimeCode(historySource)}\nboundedInteger;`, { Error });
  const observed = [];
  const routeSource = await fs.readFile(path.join(repoRoot, "app/api/sessions/[id]/safe-history/route.ts"), "utf8");
  const GET = vm.runInNewContext(`${runtimeCode(routeSource)}\nGET;`, {
    URL, Error,
    NextResponse: { json: (value, init) => Response.json(value, init) },
    boundedSafeHistoryInteger,
    readSafeSessionHistory: async (input) => {
      observed.push({ ...input });
      return {
        source: "reader-safe-history", sessionId: input.sessionId,
        entries: [{ role: "assistant", text: "synthetic route-boundary history" }],
        runtimeStatus: "not_live", durableOnly: true, bytesRead: 70,
        runtimeStartAttempted: false, writeSideEffects: false,
        sessionFilePath: null, truncated: false,
      };
    },
  });
  return { GET, observed };
}

test("live tail defaults, advertised maximum and missing-path retry pass the real safe-history GET budget", async (t) => {
  const route = await safeHistoryRouteFixture();
  const reader = await createMockReaderServer({ safeHistoryRoute: route.GET });
  t.after(() => reader.close());
  const client = await managedClient(t, reader);
  const tools = await client.call("tools/list", {});
  const tailTool = tools.tools.find((tool) => tool.name === "reader_read_tail");
  const controlTool = tools.tools.find((tool) => tool.name === "reader_session_control");
  const schema = tailTool.inputSchema.properties.maxBytes;
  assert.equal(schema.default, 65536);
  assert.equal(schema.maximum, 131072);
  assert.match(tailTool.description, /maxBytes: 131072/);
  assert.match(controlTool.description, /maxBytes: 131072/);
  for (const maxBytes of [undefined, schema.maximum]) {
    const tail = await client.tool("reader_read_tail", { sessionId: "active-001", ...(maxBytes === undefined ? {} : { maxBytes }) });
    assert.equal(tail.found, true);
    assert.equal(tail.outcome, "observed");
    assert.equal(route.observed.at(-1).maxBytes, maxBytes ?? schema.default);
  }
  const first = await client.tool("reader_read_tail", { sessionId: "active-001" });
  const retry = /maxEntries: (\d+) and maxBytes: (\d+)/.exec(first.guidance);
  assert.ok(retry, "missing-path guidance must contain an executable retry");
  const expanded = await client.tool("reader_read_tail", { sessionId: "active-001", maxEntries: Number(retry[1]), maxBytes: Number(retry[2]) });
  assert.equal(expanded.found, true);
  assert.equal(route.observed.at(-1).maxEntries, 50);
  assert.equal(route.observed.at(-1).tail, 50);
  assert.equal(route.observed.at(-1).maxBytes, schema.maximum);
  const requestsBeforeInvalid = reader.requests.length;
  for (const maxBytes of [schema.maximum + 1, 262144]) {
    const rejected = await client.tool("reader_read_tail", { sessionId: "active-001", maxBytes });
    assert.equal(rejected.__toolError, true);
  }
  assert.equal(reader.requests.length, requestsBeforeInvalid, "live over-budget requests must fail before any Reader I/O");
  assert.equal(reader.requests.some((request) => request.path === "/api/sessions/active-001"), false);
  const readsBeforeRouteRejection = route.observed.length;
  const invalidResponse = await fetch(`${reader.url}/api/sessions/active-001/safe-history?maxBytes=${schema.maximum + 1}`);
  assert.ok(invalidResponse.status >= 400, "the contract fixture must execute the real route bound, not blindly accept budgets");
  assert.equal(route.observed.length, readsBeforeRouteRejection);
});

test("storage tail preserves its independent 256 KiB schema and read budget", async (t) => {
  const fixture = await createFixture();
  t.after(() => removeTree(fixture.root));
  const folder = path.join(fixture.root, "sessions", "large-budget");
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, "large-budget.jsonl"), [
    JSON.stringify({ type: "session", id: "large-budget", cwd: "/fixture/budget" }),
    ...Array.from({ length: 35 }, (_, index) => JSON.stringify({ type: "message", message: { role: "assistant", content: `message ${index} ${"x".repeat(6000)}` } })),
    "",
  ].join("\n"));
  const client = startClient(fixture.root);
  t.after(() => client.close());
  await client.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "storage-budget-test", version: "1" } });
  const tools = await client.call("tools/list", {});
  const tailTool = tools.tools.find((tool) => tool.name === "reader_read_tail");
  assert.equal(tailTool.inputSchema.properties.maxBytes.maximum, 262144);
  assert.match(tailTool.description, /maxBytes: 262144/);
  const tail = await client.tool("reader_read_tail", { sessionId: "large-budget", maxEntries: 50, maxBytes: 262144 });
  assert.equal(tail.session.id, "large-budget");
  assert.equal(tail.entries.length, 35);
  assert.ok(tail.bytesRead > 131072 && tail.bytesRead <= 262144, "storage reads must not be silently clamped to the live limit");
  const rejected = await client.tool("reader_read_tail", { sessionId: "active-001", maxBytes: 262145 });
  assert.equal(rejected.__toolError, true);
});

test("inspect keeps effective status in a bounded projection for oversized runtime state", async (t) => {
  const reader = await createMockReaderServer({ inspectHugeState: true });
  t.after(() => reader.close());
  const client = await managedClient(t, reader);
  const inspected = await client.tool("reader_session_control", {
    action: "inspect",
    deviceId: "dev-a",
    sessionId: "active-001",
  });
  assert.equal(inspected.outcome, "observed");
  assert.equal(inspected.running, true);
  assert.equal(inspected.state.stateProjection, "bounded");
  assert.equal(inspected.state.stateTruncated, true);
  assert.equal(inspected.state.isStreaming, true);
  assert.equal(inspected.state.isPromptRunning, true);
  assert.equal(inspected.state.messageCount, 17);
  assert.equal("systemPrompt" in inspected.state, false);
  assert.equal("extensionWidgets" in inspected.state, false);
  assert.ok(Array.isArray(inspected.state.runtimeInspection.tools));
  assert.ok(inspected.state.runtimeInspection.tools.length <= 50);
  assert.equal("description" in inspected.state.runtimeInspection.tools[0], false);
  assert.ok(Buffer.byteLength(JSON.stringify(inspected), "utf8") < 512 * 1024);
});

function fixtureUiRequest(id = "select-1", method = "select", runtimeGeneration = "generation-1") {
  const options = ["继续", "手动输入", "拒绝授权"];
  return { id, method, runtimeGeneration, title: "  完整问题\n" + "问题内容".repeat(350),
    ...(method === "select" ? { options } : {}),
    ...(method === "editor" ? { prefill: "  initial text\nnext line  " } : {}),
    responseSchema: { kind: method === "select" ? "select" : method === "confirm" ? "confirm" : "text",
      allowFreeText: method === "input" || method === "editor", ...(method === "select" ? { options } : {}) },
    createdAt: "2026-10-19T00:00:00.000Z" };
}

function fixtureUiSnapshot(overrides = {}) {
  return { schemaVersion: 1, sessionId: "active-001", runtimeGeneration: "generation-1", revision: 1,
    runtimeStatus: "live", requests: [fixtureUiRequest()], runtimeStartAttempted: false, writeSideEffects: false, ...overrides };
}

const UI_URI = "reader://ui-requests/dev-a/active-001";

test("UI read mode and resource reads preserve full authoritative question content", async (t) => {
  const snapshot = fixtureUiSnapshot({ requests: [fixtureUiRequest(), fixtureUiRequest("confirm-1", "confirm"), fixtureUiRequest("input-1", "input"), fixtureUiRequest("editor-1", "editor")] });
  const reader = await createMockReaderServer({ uiSnapshot: snapshot }); t.after(() => reader.close());
  const client = await managedClient(t, reader);
  const initialized = await client.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "ui-client", version: "1" } });
  assert.equal(initialized.capabilities.resources.subscribe, true);
  assert.equal((await client.call("tools/list", {})).tools.length, 9);
  const templates = await client.call("resources/templates/list", {});
  assert.equal(templates.resourceTemplates[0].uriTemplate, "reader://ui-requests/{deviceId}/{sessionId}");
  const result = await client.tool("reader_read_live_events", { sessionId: "active-001", device: "dev-a", mode: "ui_requests" });
  assert.equal(result.resourceUri, UI_URI);
  assert.deepEqual(result.requests, snapshot.requests);
  assert.equal(result.runtimeStartAttempted, false);
  const resource = await client.call("resources/read", { uri: UI_URI });
  assert.deepEqual(JSON.parse(resource.contents[0].text).requests, snapshot.requests);
  assert.ok(reader.requests.every((request) => request.method === "GET"));
  assert.equal(reader.requests.some((request) => request.path === "/api/agent/active-001"), false, "Read must not use runtime-starting endpoints");
});

test("UI resource subscription translates a single SSE connection into standard push notifications", async (t) => {
  const reader = await createMockReaderServer(); t.after(() => reader.close());
  const client = await managedClient(t, reader);
  await client.notify("notifications/initialized", {});
  assert.deepEqual(await client.call("resources/subscribe", { uri: UI_URI }), {});
  assert.deepEqual(await client.call("resources/subscribe", { uri: UI_URI }), {});
  assert.equal(reader.uiStreamCount, 1);
  const callsAtSubscribe = reader.requests.length;
  reader.heartbeatUiStreams();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(client.notifications.length, 0, "Heartbeat does not invent a resource change");
  assert.equal(reader.requests.length, callsAtSubscribe, "No periodic HTTP polling behind a subscription");
  const next = fixtureUiSnapshot({ revision: 2, requests: [fixtureUiRequest("new-2", "input")] });
  reader.updateUiSnapshot(next);
  assert.deepEqual(await client.nextNotification(), { jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri: UI_URI } });
  assert.deepEqual(JSON.parse((await client.call("resources/read", { uri: UI_URI })).contents[0].text).requests, next.requests);
  await client.call("resources/unsubscribe", { uri: UI_URI });
  reader.updateUiSnapshot(fixtureUiSnapshot({ revision: 3, requests: [] }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(client.notifications.length, 0);
  assert.equal(reader.uiStreamCount, 0);
});

test("UI SSE wait wakes on revision or generation change and timeout never implies completion", async (t) => {
  const reader = await createMockReaderServer(); t.after(() => reader.close());
  const client = await managedClient(t, reader);
  const opened = reader.nextUiStream();
  const pending = client.tool("reader_read_live_events", { sessionId: "active-001", device: "dev-a", mode: "wait_ui_requests", runtimeGeneration: "generation-1", revision: 1, timeoutMs: 2_000 });
  await opened;
  reader.updateUiSnapshot(fixtureUiSnapshot({ runtimeGeneration: "generation-2", revision: 1, requests: [fixtureUiRequest("new-generation", "input", "generation-2")] }));
  const changed = await pending;
  assert.equal(changed.outcome, "changed");
  assert.equal(changed.runtimeGeneration, "generation-2");
  assert.equal(changed.requests[0].id, "new-generation");
  const timed = await client.tool("reader_read_live_events", { sessionId: "active-001", mode: "wait_ui_requests", runtimeGeneration: "generation-2", revision: 1, timeoutMs: 100 });
  assert.equal(timed.outcome, "timeout");
  assert.equal(timed.changed, false);
  assert.equal(timed.requests.length, 1);
  assert.equal(reader.requests.filter((request) => request.path.endsWith("/ui-requests")).length, 2);
  assert.equal(reader.requests.filter((request) => request.path.endsWith("/ui-requests")).every((request) => request.query.stream === "1"), true);
});

test("UI waits honor JSON-RPC cancellation and stdio close releases subscriptions", async (t) => {
  const reader = await createMockReaderServer(); t.after(() => reader.close());
  const client = await managedClient(t, reader);
  const opened = reader.nextUiStream();
  const pending = client.tool("reader_read_live_events", { sessionId: "active-001", mode: "wait_ui_requests", runtimeGeneration: "generation-1", revision: 1, timeoutMs: 60_000 });
  const requestId = client.lastRequestId;
  await opened;
  await client.notify("notifications/cancelled", { requestId, reason: "User cancelled" });
  assert.match((await pending).error, /cancelled/);
  await client.call("resources/subscribe", { uri: UI_URI });
  assert.ok(reader.uiStreamCount >= 1);
  await client.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(reader.uiStreamCount, 0);
});

test("UI disconnect is explicit and resubscription gets fresh state without automatic polling", async (t) => {
  const reader = await createMockReaderServer(); t.after(() => reader.close());
  const client = await managedClient(t, reader);
  await client.call("resources/subscribe", { uri: UI_URI });
  reader.endUiStreams();
  await client.nextNotification();
  const disconnected = JSON.parse((await client.call("resources/read", { uri: UI_URI })).contents[0].text);
  assert.equal(disconnected.subscription.status, "disconnected");
  const streamCount = reader.requests.filter((item) => item.query.stream === "1").length;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(reader.requests.filter((item) => item.query.stream === "1").length, streamCount);
  reader.updateUiSnapshot(fixtureUiSnapshot({ revision: 2, requests: [] }));
  await client.call("resources/subscribe", { uri: UI_URI });
  const fresh = JSON.parse((await client.call("resources/read", { uri: UI_URI })).contents[0].text);
  assert.equal(fresh.subscription.status, "connected");
  assert.deepEqual(fresh.requests, []);
});

test("UI readers fail closed on incomplete, stale, oversized or unsupported stream contracts", async (t) => {
  for (const uiSnapshot of [
    fixtureUiSnapshot({ runtimeStartAttempted: true }),
    fixtureUiSnapshot({ runtimeStatus: "not_live" }),
    fixtureUiSnapshot({ requests: [fixtureUiRequest("wrong", "input", "old-generation")] }),
    fixtureUiSnapshot({ requests: [fixtureUiRequest(), fixtureUiRequest()] }),
    fixtureUiSnapshot({ requests: [{ ...fixtureUiRequest(), title: "x".repeat(200_000) }] }),
  ]) {
    const reader = await createMockReaderServer({ uiSnapshot }); t.after(() => reader.close());
    const client = await managedClient(t, reader);
    const result = await client.tool("reader_read_live_events", { sessionId: "active-001", mode: "ui_requests" });
    assert.equal(result.__toolError, true);
    assert.equal(result.requests, undefined);
  }
  const reader = await createMockReaderServer({ uiSseUnavailable: true }); t.after(() => reader.close());
  const client = await managedClient(t, reader);
  await assert.rejects(client.call("resources/subscribe", { uri: UI_URI }), /no polling fallback/);
  assert.equal(reader.requests.filter((item) => item.path.endsWith("/ui-requests")).length, 1);
});

test("UI remote reads and subscriptions bind the exact existing peer route", async (t) => {
  const reader = await createMockReaderServer({ onlineRemote: true }); t.after(() => reader.close());
  const client = await managedClient(t, reader);
  const uri = "reader://ui-requests/dev-b/remote-001";
  await client.call("resources/read", { uri });
  await client.call("resources/subscribe", { uri });
  const calls = reader.requests.filter((item) => item.path.endsWith("/ui-requests"));
  assert.equal(calls.length, 2);
  assert.ok(calls.every((item) => item.path === "/api/remote/agent/remote-001/ui-requests" && item.query.peer === "dev-b"));
  for (const bad of ["https://host/", "reader://ui-requests/dev-a/..", "reader://ui-requests/dev-a/%2Ftmp", `${UI_URI}?stream=1`]) {
    await assert.rejects(client.call("resources/read", { uri: bad }), /Invalid|canonical/);
  }
});

test("UI answers require exact generation and preserve select/confirm/input/editor/cancel results", async (t) => {
  const requests = [fixtureUiRequest(), fixtureUiRequest("confirm-1", "confirm"), fixtureUiRequest("input-1", "input"), fixtureUiRequest("editor-1", "editor"), fixtureUiRequest("cancel-1", "input")];
  const reader = await createMockReaderServer({ uiAnswers: true, uiSnapshot: fixtureUiSnapshot({ requests }) }); t.after(() => reader.close());
  const client = await managedClient(t, reader);
  const base = { action: "answer_question", deviceId: "dev-a", sessionId: "active-001", runtimeGeneration: "generation-1", dryRun: false, confirm: true, confirmationReason: "User supplied this exact response" };
  const missingGeneration = await client.tool("reader_session_control", { ...base, runtimeGeneration: undefined, questionId: "select-1", answer: "继续", idempotencyKey: "answer-missing" });
  assert.match(missingGeneration.error, /runtimeGeneration/);
  const contradictory = await client.tool("reader_session_control", { ...base, questionId: "select-1", answer: "继续", confirmed: false, idempotencyKey: "answer-conflict" });
  assert.match(contradictory.error, /exactly one/);
  assert.equal(reader.requests.some((item) => item.method === "POST"), false);
  for (const [questionId, fields, expected] of [
    ["select-1", { answer: "继续" }, { value: "继续" }],
    ["confirm-1", { confirmed: false }, { confirmed: false }],
    ["input-1", { answer: "" }, { value: "" }],
    ["editor-1", { answer: "  " + "Multiline editor text\n".repeat(900) }, { value: "  " + "Multiline editor text\n".repeat(900) }],
    ["cancel-1", { cancelled: true }, { cancelled: true }],
  ]) {
    const result = await client.tool("reader_session_control", { ...base, questionId, ...fields, idempotencyKey: `answer-${questionId}` });
    assert.equal(result.outcome, "accepted");
    assert.equal(result.completion, "unobserved");
    assert.deepEqual(result.readerResponse.data.response, expected);
    const post = reader.requests.filter((item) => item.method === "POST").at(-1);
    assert.equal(post.body.runtimeGeneration, "generation-1");
    assert.equal(post.body.questionId, questionId);
  }
  const stale = await client.tool("reader_session_control", { ...base, questionId: "select-1", answer: "继续", runtimeGeneration: "old-generation", idempotencyKey: "answer-stale" });
  assert.equal(stale.outcome, "rejected");
  assert.equal(stale.code, "ui_generation_conflict");
  assert.equal(stale.readerResponse.success, false);
  const empty = await client.tool("reader_read_live_events", { sessionId: "active-001", mode: "ui_requests" });
  assert.deepEqual(empty.requests, []);
});

test("ask_user_question manual input follows its new request instead of replaying the select id", async (t) => {
  const reader = await createMockReaderServer({ uiAnswers: true }); t.after(() => reader.close());
  const client = await managedClient(t, reader);
  const base = { action: "answer_question", deviceId: "dev-a", sessionId: "active-001", runtimeGeneration: "generation-1", dryRun: false, confirm: true, confirmationReason: "User requested manual text" };
  await client.tool("reader_session_control", { ...base, questionId: "select-1", answer: "手动输入", idempotencyKey: "manual-select" });
  const next = await client.tool("reader_read_live_events", { sessionId: "active-001", mode: "ui_requests" });
  assert.deepEqual(next.requests.map((item) => item.id), ["manual-input-2"]);
  const result = await client.tool("reader_session_control", { ...base, questionId: next.requests[0].id, answer: "  exact user text\n", idempotencyKey: "manual-text" });
  assert.deepEqual(result.readerResponse.data.response, { value: "  exact user text\n" });
  assert.deepEqual(reader.requests.filter((item) => item.method === "POST").map((item) => item.body.questionId), ["select-1", "manual-input-2"]);
});

test("UI snapshots preserve unsupported custom UI while closed runtimes expose no stale requests", async (t) => {
  const custom = { ...fixtureUiRequest("custom-1", "custom"), responseSchema: { kind: "custom", supported: false, allowFreeText: false } };
  const reader = await createMockReaderServer({ uiSnapshot: fixtureUiSnapshot({ requests: [fixtureUiRequest(), custom] }) }); t.after(() => reader.close());
  const client = await managedClient(t, reader);
  assert.deepEqual((await client.tool("reader_read_live_events", { sessionId: "active-001", mode: "ui_requests" })).requests[1], custom);
  await Promise.all([client.call("resources/subscribe", { uri: UI_URI }), client.call("resources/subscribe", { uri: UI_URI })]);
  assert.equal(reader.requests.filter((item) => item.query.stream === "1").length, 1);
  reader.updateUiSnapshot(fixtureUiSnapshot({ revision: 2, runtimeStatus: "closed", requests: [] }));
  await client.nextNotification();
  reader.endUiStreams();
  const closed = JSON.parse((await client.call("resources/read", { uri: UI_URI })).contents[0].text);
  assert.equal(closed.subscription.status, "closed");
  assert.deepEqual(closed.requests, []);
  assert.equal(client.notifications.length, 0);
});

test("UI SSE tolerates UTF-8/multiline framing and rejects a revision regression", async (t) => {
  const reader = await createMockReaderServer(); t.after(() => reader.close());
  const client = await managedClient(t, reader);
  await client.call("resources/subscribe", { uri: UI_URI });
  const next = fixtureUiSnapshot({ revision: 2, requests: [fixtureUiRequest("unicode", "editor")] });
  const jsonLines = JSON.stringify(next, null, 2).split("\n").map((line) => `data: ${line}\r\n`).join("");
  const frame = Buffer.from(`: comment\r\nevent: ui_requests\r\n${jsonLines}\r\n`, "utf8");
  // Force the first Chinese character across writes and across event-loop turns.
  const split = frame.indexOf(Buffer.from("完整")) + 1;
  reader.rawUiFrame(frame.subarray(0, split));
  await new Promise((resolve) => setTimeout(resolve, 15));
  reader.rawUiFrame(frame.subarray(split));
  assert.equal((await client.nextNotification()).method, "notifications/resources/updated");
  reader.rawUiFrame(`event: ui_requests\ndata: ${JSON.stringify(fixtureUiSnapshot())}\n\n`);
  await client.nextNotification();
  const disconnected = JSON.parse((await client.call("resources/read", { uri: UI_URI })).contents[0].text);
  assert.equal(disconnected.subscription.status, "disconnected");
});

test("UI response idempotency binds the generation and never answers a subsequent request implicitly", async (t) => {
  const reader = await createMockReaderServer({ uiAnswers: true }); t.after(() => reader.close());
  const client = await managedClient(t, reader);
  const args = { action: "answer_question", deviceId: "dev-a", sessionId: "active-001", runtimeGeneration: "generation-1", questionId: "select-1", answer: "手动输入", dryRun: false, confirm: true, confirmationReason: "User selected manual input", idempotencyKey: "ui-bound-replay" };
  const first = await client.tool("reader_session_control", args);
  const replay = await client.tool("reader_session_control", args);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.readerResponse, first.readerResponse);
  assert.equal(reader.requests.filter((item) => item.method === "POST").length, 1);
  const conflict = await client.tool("reader_session_control", { ...args, runtimeGeneration: "generation-2" });
  assert.equal(conflict.code, "idempotency_conflict");
  assert.equal(reader.requests.filter((item) => item.method === "POST").length, 1);
  const pending = await client.tool("reader_read_live_events", { sessionId: "active-001", mode: "ui_requests" });
  assert.deepEqual(pending.requests.map((item) => item.id), ["manual-input-2"]);
  const invalid = await client.tool("reader_session_control", { ...args, cancelled: false, idempotencyKey: "ui-cancelled-false" });
  assert.match(invalid.error, /exactly one/);
  assert.equal(reader.requests.filter((item) => item.method === "POST").length, 1);
});

test("UI wait deadline aborts catalog discovery instead of starting late background work", async (t) => {
  const reader = await createMockReaderServer({ catalogDelayMs: 900 }); t.after(() => reader.close());
  const client = await managedClient(t, reader);
  const started = performance.now();
  const result = await client.tool("reader_read_live_events", { sessionId: "active-001", mode: "wait_ui_requests", runtimeGeneration: "generation-1", revision: 1, timeoutMs: 50 });
  assert.match(result.error, /timed out before an authoritative snapshot/);
  assert.ok(performance.now() - started < 500, "Deadline includes ownership discovery, not only SSE consumption");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(reader.requests.some((item) => item.path.endsWith("/ui-requests")), false);
  assert.ok(reader.requests.every((item) => item.cancelledBeforeResponse === true));
});

test("UI cancelled resource subscription aborts preflight and cannot later leave a live SSE", async (t) => {
  const reader = await createMockReaderServer({ catalogDelayMs: 400 }); t.after(() => reader.close());
  const client = await managedClient(t, reader);
  const discovered = reader.nextCatalogRequest();
  const pending = client.call("resources/subscribe", { uri: UI_URI });
  const rejected = assert.rejects(pending, /cancelled/);
  const requestId = client.lastRequestId;
  await discovered;
  const cancelledAt = performance.now();
  await client.notify("notifications/cancelled", { requestId });
  await rejected;
  assert.ok(performance.now() - cancelledAt < 200);
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(reader.uiStreamCount, 0);
  assert.equal(reader.requests.some((item) => item.path.endsWith("/ui-requests")), false);
  assert.ok(reader.requests.every((item) => item.cancelledBeforeResponse === true));
});

test("UI cancelling one duplicate subscription leaves the other explicit request intact", async (t) => {
  const reader = await createMockReaderServer({ catalogDelayMs: 150 }); t.after(() => reader.close());
  const client = await managedClient(t, reader);
  const first = client.call("resources/subscribe", { uri: UI_URI });
  const firstId = client.lastRequestId;
  const rejected = assert.rejects(first, /cancelled/);
  const second = client.call("resources/subscribe", { uri: UI_URI });
  await client.notify("notifications/cancelled", { requestId: firstId });
  await rejected;
  assert.deepEqual(await second, {});
  assert.equal(reader.uiStreamCount, 1);
  assert.equal(reader.requests.filter((item) => item.query.stream === "1").length, 1);
});

test("UI answer retains the original Reader idempotency-conflict response", async (t) => {
  const reader = await createMockReaderServer(); t.after(() => reader.close());
  const client = await managedClient(t, reader);
  const result = await client.tool("reader_session_control", { action: "answer_question", deviceId: "dev-a", sessionId: "active-001", runtimeGeneration: "generation-1", questionId: "q-101", answer: "Option B", dryRun: false, confirm: true, confirmationReason: "User selected Option B", idempotencyKey: "reader-conflict" });
  assert.equal(result.outcome, "conflict");
  assert.equal(result.readerResponse.code, "idempotency_conflict");
  assert.equal(result.readerResponse.receipt.receiptId, "reader-receipt-001");
  assert.equal(result.readerResponse.success, false);
});
