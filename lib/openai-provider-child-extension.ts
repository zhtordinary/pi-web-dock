import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

const OPENAI_PROVIDER_CHILD_EXTENSION_ID = "reader-openai-provider-aliases";
const CHILD_EXTENSION_PATH = join(process.cwd(), "packages", "reader-openai-subscription", "index.ts");
const REQUIRED_CHILD_API_PATH = (agentDir: string) => join(
  agentDir,
  "npm",
  "node_modules",
  "pi-subagents",
  "src",
  "api",
  "required-child-extensions.js",
);

type RequiredChildExtensionRegistration = { dispose(): void };
type RequiredChildExtensionApi = {
  registerRequiredChildExtensions(input: {
    sessionId: string;
    extensions: readonly { id: string; path: string }[];
  }): RequiredChildExtensionRegistration;
};

function readParentSessionId(parentSession: string | undefined): string | undefined {
  if (!parentSession) return undefined;
  try {
    const firstLine = readFileSync(parentSession, "utf8").split("\n", 1)[0];
    const header = JSON.parse(firstLine) as { type?: string; id?: unknown };
    return header.type === "session" && typeof header.id === "string" ? header.id : undefined;
  } catch {
    return undefined;
  }
}

function applySubscriptionForkSessionAffinity(event: { headers: Record<string, string | null> }, ctx: {
  model?: { provider?: string };
  sessionManager: { getHeader(): { id: string; parentSession?: string } | null };
}): void {
  if (ctx.model?.provider !== "openai-subscription") return;
  const current = ctx.sessionManager.getHeader();
  if (!current) return;
  const parentId = readParentSessionId(current.parentSession);
  if (!parentId) return;
  for (const headerName of ["session-id", "session_id"]) {
    if (event.headers[headerName] === current.id) event.headers[headerName] = parentId;
  }
}

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

/** Register the packaged alias extension for every native pi-subagents child. */
export function createOpenAIProviderChildExtension(agentDir: string): InlineExtension {
  return {
    name: "pi-web-openai-provider-child",
    hidden: true,
    factory(pi) {
      pi.on("before_provider_headers", (event, ctx) => {
        applySubscriptionForkSessionAffinity(event, ctx);
      });

      let disposed = false;
      let registration: RequiredChildExtensionRegistration | undefined;
      let registrationPromise: Promise<RequiredChildExtensionRegistration | undefined> | undefined;

      pi.on("session_start", async (_event, ctx) => {
        if (registrationPromise) {
          await registrationPromise;
          return;
        }
        registrationPromise = (async () => {
          if (!existsSync(CHILD_EXTENSION_PATH)) {
            throw new Error(`Packaged child Provider extension is missing: ${CHILD_EXTENSION_PATH}`);
          }
          const api = await loadRequiredChildExtensionApi(agentDir);
          if (!api || disposed) return undefined;
          const next = api.registerRequiredChildExtensions({
            sessionId: ctx.sessionManager.getSessionId(),
            extensions: [{ id: OPENAI_PROVIDER_CHILD_EXTENSION_ID, path: CHILD_EXTENSION_PATH }],
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
