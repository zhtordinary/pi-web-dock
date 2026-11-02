import { stat } from "fs";
import { promisify } from "util";
import { NextResponse } from "next/server";
import type { CompactionContextInfo, ContextUsage, SessionCostSummary } from "@/lib/pi-types";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";
import {
  getSessionReadAgentContext,
  getSessionReadBranch,
  getSessionReadSnapshot,
} from "@/lib/session-read-cache";
import {
  estimateSessionContextUsage,
  getCompactionContextInfo,
  getReadOnlyModelRuntime,
} from "@/lib/session-context-usage";
import { billingPriceDataSignature, calculateSessionCost, findBillingScript, sessionCostRevision, type SessionCostResult } from "@/lib/billing";

export const runtime = "nodejs";

const statAsync = promisify(stat);

import {
  cacheCost,
  readCost,
} from "@/lib/session-caches";

// Share computations only while both session and pricing revisions match.
const costInFlight = new Map<string, Promise<SessionCostResult>>();
async function readSessionContextUsage(id: string, filePath: string): Promise<ContextUsage | null> {
  const liveRpc = getRpcSession(id);
  if (liveRpc?.isAlive()) {
    const liveUsage = liveRpc.getContextUsage();
    if (liveUsage) return liveUsage;
  }

  try {
    const snapshot = getSessionReadSnapshot(filePath);
    const context = getSessionReadAgentContext(snapshot);
    if (!context.model) return null;
    const model = (await getReadOnlyModelRuntime()).getModel(context.model.provider, context.model.modelId);
    if (!model) return null;
    return estimateSessionContextUsage(
      context.messages as unknown as import("@earendil-works/pi-agent-core").AgentMessage[],
      getSessionReadBranch(snapshot) as unknown as import("@/lib/types").SessionEntry[],
      model.contextWindow,
    );
  } catch {
    return null;
  }
}

async function readSessionCompactionContexts(id: string, filePath: string): Promise<Record<string, CompactionContextInfo>> {
  try {
    const liveRpc = getRpcSession(id);
    const branchEntries = liveRpc?.isAlive()
      ? liveRpc.inner.sessionManager.getBranch()
      : getSessionReadBranch(getSessionReadSnapshot(filePath));
    return getCompactionContextInfo(
      branchEntries as unknown as import("@/lib/types").SessionEntry[],
      await getReadOnlyModelRuntime(),
    );
  } catch {
    return {};
  }
}

async function mtimeMs(path: string): Promise<number | null> {
  try {
    return (await statAsync(path)).mtimeMs;
  } catch {
    return null;
  }
}

function costResponse(
  result: SessionCostResult,
  contextUsage: ContextUsage | null | undefined,
  compactionContexts: Record<string, CompactionContextInfo> | undefined,
) {
  const cost = result.cost ?? {};
  const legacySummary: SessionCostSummary = {
    amount: (cost.status === "calculated" || cost.status === "partial") && typeof cost.amount === "number" && Number.isFinite(cost.amount) ? cost.amount : null,
    currency: cost.currency ?? "USD",
    status: cost.status === "calculated" || cost.status === "partial" ? cost.status : "unavailable",
    usage: result.usage ?? null,
    sessionCount: 1,
    models: [],
    missingPriceModels: result.missingPriceModels ?? [],
    pendingUsageCount: result.pendingUsageCount ?? 0,
    pendingUsageModels: result.pendingUsageModels ?? [],
    unavailableSessions: 0,
  };
  const emptyChildCost: SessionCostSummary = {
    amount: 0,
    currency: "USD",
    status: "calculated",
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    },
    sessionCount: 0,
    models: [],
    missingPriceModels: [],
    pendingUsageCount: 0,
    pendingUsageModels: [],
    unavailableSessions: 0,
  };
  const parentCost = result.parentCost ?? legacySummary;
  const childCost = result.childCost ?? emptyChildCost;
  const mainCost = result.mainCost ?? parentCost;
  const compactionCost = result.compactionCost;
  const recapCost = result.recapCost ?? emptyChildCost;
  const totalCost = result.totalCost ?? legacySummary;
  const missingPriceModels = totalCost.missingPriceModels;
  const amountAvailable = (totalCost.status === "calculated" || totalCost.status === "partial")
    && typeof totalCost.amount === "number"
    && Number.isFinite(totalCost.amount);
  return NextResponse.json({
    amount: amountAvailable ? totalCost.amount : null,
    currency: totalCost.currency,
    status: amountAvailable ? totalCost.status : "unavailable",
    missingPriceModels,
    pendingUsageCount: totalCost.pendingUsageCount,
    pendingUsageModels: totalCost.pendingUsageModels,
    messageCosts: result.messageCosts ?? {},
    imageGenerationCosts: result.imageGenerationCosts ?? [],
    compactionCosts: result.compactionCosts ?? {},
    compactionContexts,
    // Full-session cumulative token usage, computed by the same script that
    // prices the session. Used by the top bar so token stats and cache hit
    // rate cover the whole session history, not just post-compaction messages.
    usage: result.usage ?? null,
    contextUsage,
    parentCost,
    childCost,
    mainCost,
    ...(compactionCost ? { compactionCost } : {}),
    recapCost,
    extensionCosts: result.extensionCosts ?? [],
    totalCost,
  }, { headers: { "Cache-Control": "no-store" } });
}

async function runCostScript(scriptPath: string | null, filePath: string): Promise<SessionCostResult> {
  return calculateSessionCost(filePath, scriptPath);
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const filePath = await resolveSessionPath(id);
  if (!filePath) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  const summary = new URL(req.url).searchParams.get("view") === "summary";
  const contextUsage = summary ? undefined : await readSessionContextUsage(id, filePath);
  const compactionContexts = summary ? undefined : await readSessionCompactionContexts(id, filePath);

  const scriptPath = findBillingScript();

  try {
    const [sessionMtimeMs, sessionRevision, scriptMtimeMs, priceTableSignature] = await Promise.all([
      mtimeMs(filePath),
      sessionCostRevision(filePath),
      scriptPath ? mtimeMs(scriptPath) : null,
      billingPriceDataSignature(),
    ]);
    const cached = sessionMtimeMs === null ? undefined : readCost(id);
    if (
      cached
      && cached.sessionMtimeMs === sessionMtimeMs
      && cached.sessionRevision === sessionRevision
      && cached.scriptMtimeMs === scriptMtimeMs
      && cached.priceTableSignature === priceTableSignature
      && (cached.result as SessionCostResult).mainCost
      && (cached.result as SessionCostResult).recapCost
      && Array.isArray((cached.result as SessionCostResult).extensionCosts)
      && Array.isArray((cached.result as SessionCostResult).imageGenerationCosts)
    ) return costResponse(cached.result as SessionCostResult, contextUsage, compactionContexts);

    const revisionKey = JSON.stringify([id, sessionRevision, scriptPath, scriptMtimeMs, priceTableSignature]);
    let pending = costInFlight.get(revisionKey);
    if (!pending) {
      const run = runCostScript(scriptPath, filePath);
      pending = run.finally(() => {
        if (costInFlight.get(revisionKey) === pending) costInFlight.delete(revisionKey);
      });
      costInFlight.set(revisionKey, pending);
    }
    const result = await pending;
    if (sessionMtimeMs !== null) {
      cacheCost(id, { sessionMtimeMs, sessionRevision, scriptMtimeMs, priceTableSignature, result });
    }
    return costResponse(result, contextUsage, compactionContexts);
  } catch (error) {
    console.warn("[pi-web] session cost unavailable:", error instanceof Error ? error.message : String(error));
    return NextResponse.json({ amount: null, currency: "USD", status: "unavailable", usage: null, compactionCosts: {}, compactionContexts, contextUsage });
  }
}
