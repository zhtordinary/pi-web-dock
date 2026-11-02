// Reader's own classification of user prompts for activity rows and previews.
// Recap triggering stays with the Recap package (see session-recap.ts).

// Only these complete phrases carry no new task content. A continuation word
// followed by a concrete task remains an effective question.
const pureContinuation = new Set([
  "继续", "继续吧", "继续一下", "继续做", "继续处理", "继续分析", "继续往下", "继续下一步",
  "接着", "接着做", "接着处理", "接着往下", "下一步", "好继续", "好的继续", "嗯继续",
]);

// Confirmation phrases may include a short follow-up such as "我看看效果".
// Do not treat bare "好" or "完成" as confirmation prefixes: "好，修复登录"
// and "完成报告" are new tasks, not no-op continuations.
const confirmationPrefix = /^(?:好(?:的)?继续|嗯继续|好了|好了吗|好吧|完成了(?:吗|么|没|没有)?|完成了吗|搞定了(?:吗|么|没|没有)?|搞定了吗|弄好了吗|做好了吗|修好了吗|弄完了|做完了|准备好了吗|可以了吗|还有(?:吗|没|没有|别的吗|其他吗|呢)|然后呢|就这样吗|就这些吗|就这)/;

export const SUBAGENT_WAKE_PREFIXES = [
  "Inspect subagent updates above",
  "Subagent updates above",
] as const;

const SUBAGENT_WAKE_ACK = "Answer pending supervisor requests within your authority.";
const SUBAGENT_WAKE_FULL_SUFFIX = `${SUBAGENT_WAKE_ACK} For completed work, read saved results and resume the already-authorized parent task, or report completion. If approval is required, explicitly ask the user. Do not silently yield, rerun completed work, or infer new authorization.`;
const SUBAGENT_WAKE_TEXTS = new Set<string>([
  ...SUBAGENT_WAKE_PREFIXES,
  ...SUBAGENT_WAKE_PREFIXES.map((prefix) => `${prefix}.`),
  ...SUBAGENT_WAKE_PREFIXES.map((prefix) => `${prefix}. ${SUBAGENT_WAKE_ACK}`),
  ...SUBAGENT_WAKE_PREFIXES.map((prefix) => `${prefix}. ${SUBAGENT_WAKE_FULL_SUFFIX}`),
]);

export function isSubagentWakeText(text: string | null | undefined): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (SUBAGENT_WAKE_TEXTS.has(trimmed)) return true;
  const prefixMatch = trimmed.match(/^本次具体要求[：:]\s*(.+)$/);
  return Boolean(prefixMatch && SUBAGENT_WAKE_TEXTS.has(prefixMatch[1].trim()));
}

export function textContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type?: unknown; text?: unknown } => typeof block === "object" && block !== null)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim();
}

export function isContinuationPrompt(message: string): boolean {
  if (isSubagentWakeText(message)) return true;
  const compact = message.trim().replace(/[\s\u3000，。！？、；：,.!?;:'"“”‘’`]+/g, "");
  if (pureContinuation.has(compact)) return true;
  const match = compact.match(confirmationPrefix);
  return Boolean(match && compact.slice(match[0].length).length <= 8);
}
