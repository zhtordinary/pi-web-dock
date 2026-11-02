import {
  createAgentSessionServices,
  getAgentDir,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";

const temporaryRuntimeCleanups = new WeakMap<ModelRuntime, () => void>();

/**
 * ModelRuntime that also includes providers registered by extensions (an
 * extension that calls `registerProvider` / `createProvider` during resource
 * loading). A bare `ModelRuntime.create()` only knows built-in providers plus
 * models.json, so extension-registered providers were invisible to the
 * provider-listing and auth routes.
 *
 * The agent dir acts as cwd so project-local extensions stay out; global
 * package extensions always load. Not cached: these routes need fresh
 * credentials for auth status and login/logout to be truthful.
 */
export async function createModelRuntimeWithExtensions(): Promise<ModelRuntime> {
  const agentDir = getAgentDir();
  const services = await createAgentSessionServices({ cwd: agentDir, agentDir });
  const extensionRuntime = services.resourceLoader.getExtensions().runtime;
  temporaryRuntimeCleanups.set(services.modelRuntime, () => extensionRuntime.invalidate());
  return services.modelRuntime;
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
