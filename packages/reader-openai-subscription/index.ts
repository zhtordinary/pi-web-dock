import { readFileSync } from "node:fs";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  aliasProvider,
  OPENAI_API_PROVIDER_ID,
  OPENAI_PROVIDER_CHILD_EXTENSION_ID,
  OPENAI_SUBSCRIPTION_PROVIDER_ID,
} from "./provider";

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

/** Rebuild Reader's OpenAI aliases inside the independent child Pi process. */
export default function (pi: ExtensionAPI): void {
  pi.on("before_provider_headers", (event, ctx) => {
    if (ctx.model?.provider !== OPENAI_SUBSCRIPTION_PROVIDER_ID) return;
    const current = ctx.sessionManager.getHeader();
    if (!current) return;
    const parentId = readParentSessionId(current.parentSession);
    if (!parentId) return;
    for (const headerName of ["session-id", "session_id"]) {
      if (event.headers[headerName] === current.id) event.headers[headerName] = parentId;
    }
  });

  const source = builtinProviders().find((provider) => provider.id === "openai");
  if (!source) throw new Error("Built-in OpenAI provider is unavailable");
  if (source.auth.oauth) {
    pi.registerProvider(aliasProvider(
      source,
      OPENAI_SUBSCRIPTION_PROVIDER_ID,
      "OpenAI (ChatGPT subscription)",
      { oauth: source.auth.oauth },
    ));
  }
  if (source.auth.apiKey) {
    pi.registerProvider(aliasProvider(source, OPENAI_API_PROVIDER_ID, "OpenAI API", { apiKey: source.auth.apiKey }));
  }
  pi.events.emit("subagent:acknowledge-extension", { id: OPENAI_PROVIDER_CHILD_EXTENSION_ID });
}
