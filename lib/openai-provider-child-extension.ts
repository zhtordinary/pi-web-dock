import { readFileSync } from "node:fs";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

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
  if (event.headers["session-id"] === current.id) event.headers["session-id"] = parentId;
  if (event.headers.session_id === current.id) event.headers.session_id = parentId;
}

/** Apply Reader's subscription request affinity in the parent session. */
export function createOpenAIProviderChildExtension(): InlineExtension {
  return {
    name: "pi-web-openai-provider-child",
    hidden: true,
    factory(pi) {
      pi.on("before_provider_headers", (event, ctx) => {
        applySubscriptionForkSessionAffinity(event, ctx);
      });
    },
  };
}
