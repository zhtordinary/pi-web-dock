import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

const REQUIRED_CHILD_API_PATH = (agentDir: string) => join(
  agentDir,
  "npm",
  "node_modules",
  "pi-subagents",
  "src",
  "api",
  "required-child-extensions.js",
);
const REQUIRED_CHILD_EXTENSIONS = [
  {
    id: "reader-openai-provider-aliases",
    path: join(process.cwd(), "packages", "reader-openai-subscription", "index.ts"),
  },
  {
    id: "pi-web-usage-pricing",
    path: join(process.cwd(), "packages", "reader-usage-pricing", "index.ts"),
  },
] as const;

type RequiredChildExtensionRegistration = { dispose(): void };
type RequiredChildExtensionApi = {
  registerRequiredChildExtensions(input: {
    sessionId: string;
    extensions: readonly { id: string; path: string }[];
  }): RequiredChildExtensionRegistration;
};

async function loadRequiredChildExtensionApi(agentDir: string): Promise<RequiredChildExtensionApi | undefined> {
  const modulePath = REQUIRED_CHILD_API_PATH(agentDir);
  if (!existsSync(modulePath)) return undefined;
  // Load the user's installed pi-subagents copy, not a second bundled module instance.
  const loaded = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ pathToFileURL(modulePath).href) as Partial<RequiredChildExtensionApi>;
  if (typeof loaded.registerRequiredChildExtensions !== "function") {
    throw new Error("pi-subagents required-child-extensions API is unavailable");
  }
  return loaded as RequiredChildExtensionApi;
}

/** Register all Reader-owned child extensions in one per-session snapshot. */
export function createReaderChildExtensions(agentDir: string): InlineExtension {
  return {
    name: "pi-web-reader-child-extensions",
    hidden: true,
    factory(pi) {
      let disposed = false;
      let registration: RequiredChildExtensionRegistration | undefined;
      let registrationPromise: Promise<RequiredChildExtensionRegistration | undefined> | undefined;

      pi.on("session_start", async (_event, ctx) => {
        if (registrationPromise) {
          await registrationPromise;
          return;
        }
        registrationPromise = (async () => {
          const missing = REQUIRED_CHILD_EXTENSIONS.find((extension) => !existsSync(extension.path));
          if (missing) throw new Error(`Reader child extension is missing: ${missing.path}`);
          const api = await loadRequiredChildExtensionApi(agentDir);
          if (!api || disposed) return undefined;
          const next = api.registerRequiredChildExtensions({
            sessionId: ctx.sessionManager.getSessionId(),
            extensions: REQUIRED_CHILD_EXTENSIONS,
          });
          if (disposed) {
            next.dispose();
            return undefined;
          }
          registration = next;
          return next;
        })();
        await registrationPromise;
      });

      pi.on("session_shutdown", async () => {
        disposed = true;
        await registrationPromise?.catch(() => undefined);
        registration?.dispose();
        registration = undefined;
      });
    },
  };
}
