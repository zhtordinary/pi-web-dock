import { randomUUID } from "node:crypto";
import {
  createAgentSessionServices,
  getAgentDir,
  SettingsManager,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { installCpaTransport } from "./cpa-responses-transport";
import { serializeByKey } from "./key-serializer";
import { createOpenAIProviderChildExtension } from "./openai-provider-child-extension";
import { installOpenAIProviderAliases } from "./openai-provider-aliases";

/** The common SDK boundary for Reader sessions, including Side Ask and children. */
export async function createReaderAgentSessionServices(options: Parameters<typeof createAgentSessionServices>[0]) {
  const resourceLoaderOptions = options.resourceLoaderOptions;
  const services = await createAgentSessionServices({
    ...options,
    ...(resourceLoaderOptions && resourceLoaderOptions.noExtensions !== true
      ? {
          resourceLoaderOptions: {
            ...resourceLoaderOptions,
            extensionFactories: [
              ...(resourceLoaderOptions.extensionFactories ?? []),
              createOpenAIProviderChildExtension(options.agentDir ?? getAgentDir()),
            ],
          },
        }
      : {}),
  });
  const aliasesInstalled = installOpenAIProviderAliases(services.modelRuntime);
  installCpaTransport(services.modelRuntime);
  if (aliasesInstalled && typeof services.modelRuntime.refresh === "function") {
    await services.modelRuntime.refresh({ allowNetwork: false });
  }
  return services;
}

const temporaryRuntimeCleanups = new WeakMap<ModelRuntime, () => void>();

/**
 * ModelRuntime that also includes providers registered by extensions (an
 * extension that calls `registerProvider` / `createProvider` during resource
 * loading). A bare `ModelRuntime.create()` only knows built-in providers plus
 * models.json, so extension-registered providers were invisible to the
 * provider-listing and auth routes.
 *
 * The agent dir acts as cwd so project-local extensions stay out; global
 * package extensions always load. Temporary callers get a fresh runtime and
 * must dispose it when finished. Read-only routes should use
 * `getModelRuntimeWithExtensions()` instead.
 */
export async function createModelRuntimeWithExtensions(): Promise<ModelRuntime> {
  const agentDir = getAgentDir();
  const services = await createReaderAgentSessionServices({ cwd: agentDir, agentDir });
  const extensionRuntime = services.resourceLoader.getExtensions().runtime;
  temporaryRuntimeCleanups.set(services.modelRuntime, () => extensionRuntime.invalidate());
  return services.modelRuntime;
}

interface SharedModelRuntime {
  agentDir: string;
  runtime: Promise<ModelRuntime>;
  /** Each entry has its own refresh queue so a stuck extension does not block a newer entry. */
  queueKey: string;
  /** Infinity while the runtime is being built; the TTL starts after a successful build. */
  expiresAt: number;
}

declare global {
  var __piWebSharedModelRuntime: SharedModelRuntime | undefined;
}

// Extension imports are synchronous and can block the event loop. Keep the
// expensive build rare while refreshing auth/models files on every read.
const SHARED_MODEL_RUNTIME_TTL_MS = 60 * 60_000;
const SHARED_MODEL_RUNTIME_REFRESH_KEY: symbol = Symbol.for("pi-web:shared-model-runtime-refresh");

/**
 * Reuse one extension-loaded runtime for read-only routes. `refresh()` is
 * deliberately still run for every caller: it rereads auth.json, models.json
 * and models-store.json without contacting provider networks, so credentials
 * remain current while extension factories are not imported for every request.
 */
export async function getModelRuntimeWithExtensions(): Promise<ModelRuntime> {
  const agentDir = getAgentDir();
  let entry = globalThis.__piWebSharedModelRuntime;
  if (!entry || entry.agentDir !== agentDir || entry.expiresAt <= Date.now()) {
    entry = buildSharedModelRuntime(agentDir);
    globalThis.__piWebSharedModelRuntime = entry;
  }

  // A build is shared by concurrent settings requests. Refreshes are serialized
  // because the SDK keeps one availability snapshot per runtime.
  const shared = await entry.runtime;
  return serializeByKey(SHARED_MODEL_RUNTIME_REFRESH_KEY, entry.queueKey, async () => {
    await shared.refresh({ allowNetwork: false });
    return shared;
  });
}

function buildSharedModelRuntime(agentDir: string): SharedModelRuntime {
  const entry: SharedModelRuntime = {
    agentDir,
    runtime: createModelRuntimeWithExtensions(),
    queueKey: `${agentDir}\0${randomUUID()}`,
    expiresAt: Number.POSITIVE_INFINITY,
  };
  entry.runtime.then(
    () => {
      entry.expiresAt = Date.now() + SHARED_MODEL_RUNTIME_TTL_MS;
    },
    () => {
      // Do not retain a failed build; the next request gets a clean attempt.
      if (globalThis.__piWebSharedModelRuntime === entry) globalThis.__piWebSharedModelRuntime = undefined;
    },
  );
  return entry;
}

/** Rebuild the shared read-only runtime after extensions or packages change. */
export function invalidateModelRuntimeWithExtensions(): void {
  globalThis.__piWebSharedModelRuntime = undefined;
}

/**
 * The options Pi's TUI passes to ModelRuntime.login(). OAuth providers such as
 * openai require the installation UUID from the shared global settings file.
 */
export function createLoginOptions(agentDir = getAgentDir()) {
  const settingsManager = SettingsManager.create(agentDir, agentDir);
  return {
    options: { getDeviceId: () => settingsManager.getOrCreateDeviceId() },
    flush: () => settingsManager.flush(),
  };
}

/** Invalidate the temporary extension runtime and release its tracked subscriptions. */
export function disposeModelRuntime(runtime: ModelRuntime): void {
  const cleanup = temporaryRuntimeCleanups.get(runtime);
  if (!cleanup) return;
  temporaryRuntimeCleanups.delete(runtime);
  try {
    cleanup();
  } catch {
    console.warn("[model-runtime] temporary extension runtime invalidation failed");
  }
}
