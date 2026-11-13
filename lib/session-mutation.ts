import { zhCNLocale } from "./i18n/messages/zh-CN.ts";
import { getLocalePlugin, resolveBrowserLocale } from "./i18n/registry.ts";

/** Localize known Reader failures without changing arbitrary remote error details. */
export function sessionMutationErrorMessage(error: unknown, t: (key: string) => string): string {
  const message = error instanceof Error ? error.message : String(error);
  const known = zhCNLocale.messages["sessionActivity.sideAskPreventsArchive"];
  return message === known || message === `Error: ${known}` ? t("sessionActivity.sideAskPreventsArchive") : message;
}

export async function assertSessionMutationOk(response: Response): Promise<void> {
  if (response.ok) return;
  const body = await response.json().catch(() => null) as { error?: unknown; code?: unknown } | null;
  const message = typeof body?.error === "string" && body.error.trim()
    ? body.error
    : `HTTP ${response.status}`;
  const locale = resolveBrowserLocale(typeof document === "undefined" ? [] : [document.documentElement.lang]);
  const messages = getLocalePlugin(locale)?.messages;
  const localized = body?.code === "session_child_lifecycle_requires_parent"
    ? messages?.["sessionActivity.subagentLifecycleRequiresParent"]
    : undefined;
  throw new Error(localized ?? sessionMutationErrorMessage(message, (key) => messages?.[key] ?? key));
}
