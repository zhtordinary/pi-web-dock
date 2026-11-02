import { resolveLocalFileHref, resolveLocalFilePath } from "./file-links.ts";

export interface ImageGenerationBilling {
  status: "confirmed" | "pending" | "unavailable";
  source?: "apimart-task" | "laozhang-log";
  amount?: number;
  currency: "USD";
  credits?: number;
  quota?: number;
  taskId?: string;
  requestId?: string;
  toolCallId?: string;
  startedAt: number;
  requestedImages?: number;
  returnedImages?: number;
  size?: string;
  resolution?: string;
  quality?: string;
  reason?: string;
}

export interface ProviderCharge {
  amount: number;
  currency: "USD";
  source: "apimart-task" | "laozhang-log";
  taskId?: string;
  requestId?: string;
}

export interface ImageGenerationOutput {
  version: 1;
  toolCallId: string;
  files: string[];
  usageIds: string[];
}

export interface ImageGenerationOutputReceipt {
  id: string;
  provider: string;
  model: string;
  billing?: ImageGenerationBilling;
}

export interface ImageGenerationCost {
  id: string;
  provider: string;
  model: string;
  amount: number | null;
  status: "confirmed" | "estimated" | "pending" | "unavailable";
  billing: ImageGenerationBilling;
  outputs?: ImageGenerationOutput[];
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function identifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9_.:/-]{1,300}$/.test(value) ? value : undefined;
}

// SDK tool IDs are opaque; provider task IDs retain their stricter validation.
function toolCallIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 300
    && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value) ? value : undefined;
}

export function readImageGenerationBilling(value: unknown): ImageGenerationBilling | undefined {
  if (!record(value) || !["confirmed", "pending", "unavailable"].includes(String(value.status))
      || value.currency !== "USD" || !nonNegative(value.startedAt) || !Number.isFinite(new Date(value.startedAt).getTime())) return undefined;
  const source = value.source === "apimart-task" || value.source === "laozhang-log" ? value.source : undefined;
  const taskId = identifier(value.taskId);
  const requestId = identifier(value.requestId);
  const confirmed = value.status === "confirmed" && nonNegative(value.amount)
    && ((source === "apimart-task" && taskId) || (source === "laozhang-log" && requestId));
  return {
    status: value.status === "confirmed" ? confirmed ? "confirmed" : "unavailable" : value.status as "pending" | "unavailable",
    currency: "USD", startedAt: value.startedAt, source, taskId, requestId, toolCallId: toolCallIdentifier(value.toolCallId),
    ...(confirmed ? { amount: value.amount as number } : {}),
    ...(nonNegative(value.credits) ? { credits: value.credits } : {}),
    ...(nonNegative(value.quota) && Number.isSafeInteger(value.quota) ? { quota: value.quota } : {}),
    ...Object.fromEntries(["requestedImages", "returnedImages"].flatMap((key) =>
      nonNegative(value[key]) && Number.isSafeInteger(value[key]) ? [[key, value[key]]] : [])),
    ...Object.fromEntries(["size", "resolution", "quality", "reason"].flatMap((key) =>
      typeof value[key] === "string" && value[key].length <= 100 ? [[key, value[key]]] : [])),
  };
}

export function readProviderCharge(value: unknown): ProviderCharge | undefined {
  if (!record(value) || !nonNegative(value.amount) || value.currency !== "USD") return undefined;
  const taskId = identifier(value.taskId);
  const requestId = identifier(value.requestId);
  if (!((value.source === "apimart-task" && taskId) || (value.source === "laozhang-log" && requestId))) return undefined;
  return { amount: value.amount, currency: "USD", source: value.source as ProviderCharge["source"], taskId, requestId };
}

export function providerCharge(billing: ImageGenerationBilling | undefined): ProviderCharge | undefined {
  return billing?.status === "confirmed" ? readProviderCharge(billing) : undefined;
}

export function readImageGenerationOutput(value: unknown): ImageGenerationOutput | undefined {
  if (!record(value) || value.version !== 1 || !toolCallIdentifier(value.toolCallId)
      || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > 16
      || !Array.isArray(value.usageIds) || value.usageIds.length < 1 || value.usageIds.length > 16) return undefined;
  const files = value.files;
  const usageIds = value.usageIds;
  if (!files.every((file) => typeof file === "string" && file.length <= 4096 && !file.includes("\0")
      && (/^\/(?!\/)/.test(file) || /^[A-Za-z]:[\\/]/.test(file) || /^\\\\/.test(file)))
      || !usageIds.every((id) => typeof id === "string" && id.startsWith("image-generation:") && identifier(id))
      || new Set(files).size !== files.length || new Set(usageIds).size !== usageIds.length) return undefined;
  return { version: 1, toolCallId: value.toolCallId as string, files: files as string[], usageIds: usageIds as string[] };
}

/** Bind only the exact files and receipt identities returned by the generation tool. */
export function imageGenerationOutputFromTool(toolCallId: string, toolName: string, details: unknown): ImageGenerationOutput | undefined {
  if (toolName !== "generate_image" || !record(details) || !Array.isArray(details.imageGeneration)) return undefined;
  const receipts = details.imageGeneration;
  if (!receipts.length || receipts.some((receipt) => !record(receipt) || !record(receipt.billing)
      || receipt.billing.toolCallId !== toolCallId)) return undefined;
  return readImageGenerationOutput({ version: 1, toolCallId, files: details.files, usageIds: receipts.map((receipt) => receipt.id) });
}

/** A recovered task already records its owner, upstream IDs, receipt IDs and saved files. */
export function imageGenerationOutputFromTask(value: unknown, sessionId: string, receipts: readonly ImageGenerationOutputReceipt[]): ImageGenerationOutput | undefined {
  if (!record(value) || value.state !== "saved" || !record(value.owner) || value.owner.sessionId !== sessionId
      || typeof value.provider !== "string" || typeof value.model !== "string" || !Array.isArray(value.billing)
      || !value.billing.length || value.billing.length > 16) return undefined;
  const usageIds: string[] = [];
  const callIds = new Set<string>();
  for (const item of value.billing) {
    if (!record(item) || typeof item.id !== "string" || typeof item.taskId !== "string") return undefined;
    const matches = receipts.filter((receipt) => receipt.id === item.id && receipt.provider === value.provider
      && receipt.model === value.model && receipt.billing?.taskId === item.taskId && receipt.billing?.toolCallId);
    if (!matches.length) return undefined;
    for (const match of matches) callIds.add(match.billing!.toolCallId!);
    usageIds.push(item.id);
  }
  if (callIds.size !== 1) return undefined;
  return readImageGenerationOutput({ version: 1, toolCallId: [...callIds][0], files: value.files, usageIds });
}

export function readImageGenerationCosts(value: unknown): ImageGenerationCost[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row): ImageGenerationCost[] => {
    if (!record(row) || typeof row.id !== "string" || typeof row.provider !== "string" || typeof row.model !== "string"
        || !["confirmed", "estimated", "pending", "unavailable"].includes(String(row.status))) return [];
    const billing = readImageGenerationBilling(row.billing);
    if (!billing || (row.amount !== null && !nonNegative(row.amount))) return [];
    if (row.status === "confirmed" && (billing.status !== "confirmed" || row.amount !== billing.amount)) return [];
    if (row.status === "estimated" && row.amount === null) return [];
    const outputs = Array.isArray(row.outputs) ? row.outputs.flatMap((value) => {
      const output = readImageGenerationOutput(value);
      return output && output.toolCallId === billing.toolCallId && output.usageIds.includes(row.id as string) ? [output] : [];
    }) : [];
    return [{ id: row.id, provider: row.provider, model: row.model, billing, amount: row.amount as number | null,
      status: row.status as ImageGenerationCost["status"], ...(outputs.length ? { outputs } : {}) }];
  });
}

export function mergeImageGenerationCosts(immediate: readonly ImageGenerationCost[], reconciled: readonly ImageGenerationCost[]): ImageGenerationCost[] {
  const rows = new Map(immediate.map((row) => [row.id, row]));
  for (const row of reconciled) {
    if (rows.get(row.id)?.status === "confirmed" && row.status !== "confirmed") continue;
    rows.set(row.id, row);
  }
  return [...rows.values()];
}

/** Match a generated image only to one complete, explicitly recorded output batch. */
export function imageGenerationCostsForFile(href: string | undefined, cwd: string | undefined, costs: readonly ImageGenerationCost[]):
  { costs: ImageGenerationCost[]; batch: boolean } | undefined {
  const filePath = resolveLocalFileHref(href, cwd);
  if (!filePath) return undefined;
  const groups = new Map<string, { output: ImageGenerationOutput; rows: Map<string, ImageGenerationCost> }>();
  for (const cost of costs) for (const output of cost.outputs ?? []) {
    if (!output.files.some((file) => resolveLocalFilePath(file) === filePath)) continue;
    const key = JSON.stringify([output.toolCallId, [...output.files].sort(), [...output.usageIds].sort()]);
    const group = groups.get(key) ?? { output, rows: new Map<string, ImageGenerationCost>() };
    group.rows.set(cost.id, cost);
    groups.set(key, group);
  }
  if (groups.size !== 1) return undefined;
  const group = [...groups.values()][0];
  if (group.output.usageIds.some((id) => !group.rows.has(id))) return undefined;
  const rows = group.output.usageIds.map((id) => group.rows.get(id)!);
  return { costs: rows, batch: group.output.files.length > 1 || rows.length > 1
    || rows.some((row) => (row.billing.returnedImages ?? 0) > 1) };
}

/** Tool details are immediate observations; the cost API may later supply a reconciled receipt. */
export function imageGenerationCostsFromDetails(details: unknown): ImageGenerationCost[] {
  if (!record(details) || !Array.isArray(details.imageGeneration)) return [];
  return details.imageGeneration.flatMap((value): ImageGenerationCost[] => {
    if (!record(value) || typeof value.id !== "string" || typeof value.provider !== "string" || typeof value.model !== "string") return [];
    const billing = readImageGenerationBilling(value.billing);
    if (!billing) return [];
    return [{ id: value.id, provider: value.provider, model: value.model, billing,
      status: billing.status, amount: billing.status === "confirmed" ? billing.amount ?? null : null }];
  });
}
