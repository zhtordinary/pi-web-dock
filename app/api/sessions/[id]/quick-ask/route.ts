import { NextResponse } from "next/server";
import { zhCNLocale } from "@/lib/i18n/messages/zh-CN";
import { existsSync } from "node:fs";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { resolveSessionPath } from "@/lib/session-reader";
import { forkQuickAskSession, getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { parseQuickAskImages, QuickAskError, quickAskErrorText } from "@/lib/quick-ask-context";
import { createQuickAskEventStream } from "@/lib/quick-ask-event-stream";
import {
  quickAskDeletedRuns,
  quickAskListEntry,
  quickAskListRun,
  quickAskPromotedBranches,
  quickAskRunSnapshots,
  type QuickAskScope,
} from "@/lib/quick-ask-log";
import { projectSessionQuickAsks, readQuickAskRecords } from "@/lib/quick-ask-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
type RouteParams = { params: Promise<{ id: string }> };
type RequestBody = Record<string, unknown>;

async function requestBody(req: Request): Promise<RequestBody> {
  let value: unknown;
  try { value = await req.json(); }
  catch { throw new QuickAskError("Invalid JSON request body", 400); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new QuickAskError("Request body must be an object", 400);
  return value as RequestBody;
}

function identifier(value: unknown, field: string, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string" || !value.trim() || value.length > 512 || /[\x00-\x1f]/.test(value)) {
    throw new QuickAskError(`${field} must be a non-empty identifier`, 400);
  }
  return value.trim();
}
function scopeOf(body: RequestBody): QuickAskScope {
  return { threadId: identifier(body.threadId, "threadId", "default"), branchId: identifier(body.branchId, "branchId", "main") };
}
function failure(error: unknown): NextResponse {
  return NextResponse.json({ error: quickAskErrorText(error) }, { status: error instanceof QuickAskError ? error.status : 500 });
}
async function sourceFile(id: string): Promise<string> {
  const file = getRpcSession(id)?.sessionFile || await resolveSessionPath(id);
  if (!file) throw new QuickAskError("Session not found", 404);
  return file;
}
async function ownerForWrite(id: string, file: string) {
  const existing = getRpcSession(id);
  if (existing?.isShuttingDown()) throw new QuickAskError("Session is shutting down", 409);
  const owner = existing?.isAlive() ? existing : (await startRpcSession(id, file, undefined)).session;
  owner.assertSessionWriteAllowed();
  return owner;
}
function eventResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, { headers: {
    "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no",
  } });
}

/** Reads and observers never wake a model or acquire ownership of a generating task. */
export async function GET(req: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const file = await sourceFile(id);
    const owner = getRpcSession(id);
    const live = owner?.isAlive() ? owner.peekQuickAskRuntime() : undefined;
    const records = owner?.isAlive() ? owner.inner.sessionManager.getEntries()
      : existsSync(file) ? await readQuickAskRecords(file) : [];
    const url = new URL(req.url);
    const runId = url.searchParams.get("runId");
    if (runId) {
      identifier(runId, "runId");
      const run = live?.snapshot(runId) ?? quickAskRunSnapshots(records, [], false).find((candidate) => candidate.id === runId);
      if (!run) {
        const deleted = quickAskDeletedRuns(records).get(runId);
        if (deleted) return NextResponse.json({ error: zhCNLocale.messages["sidekick.runDeleted"], code: "quick_ask_deleted", runId, ...deleted }, { status: 410 });
        throw new QuickAskError("Side Ask run not found", 404);
      }
      if (url.searchParams.get("stream") === "1") return eventResponse(createQuickAskEventStream(req, run, live));
      return NextResponse.json({ success: true, run: quickAskListRun(run) });
    }
    const promotedBranches = quickAskPromotedBranches(records);
    const latest = live?.snapshots() ?? quickAskRunSnapshots(records);
    const latestIds = new Set(latest.map((run) => run.id));
    const retained = (live?.snapshots(false) ?? quickAskRunSnapshots(records, [], false)).filter((run) =>
      promotedBranches.includes(run.branchId) && run.status !== "completed" && !latestIds.has(run.id));
    return NextResponse.json({ success: true, items: projectSessionQuickAsks(records).map(quickAskListEntry),
      runs: [...retained, ...latest].map(quickAskListRun), promotedBranches });
  } catch (error) { return failure(error); }
}

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const body = await requestBody(req);
    if ((body.targetId === undefined) === (body.threadId === undefined)) throw new QuickAskError("Exactly one deletion target is required", 400);
    if (body.targetId !== undefined && body.requestId !== undefined) throw new QuickAskError("requestId requires a topic deletion", 400);
    const requestId = body.requestId === undefined ? undefined : identifier(body.requestId, "requestId");
    const file = await sourceFile(id);
    const owner = await ownerForWrite(id, file);
    const branchId = identifier(body.branchId, "branchId", "main");
    if (body.targetId !== undefined) {
      const targetId = identifier(body.targetId, "targetId");
      const target = projectSessionQuickAsks(owner.inner.sessionManager.getEntries()).find((item) => item.id === targetId
        && (item.data.branchId ?? item.branchId ?? "main") === branchId);
      if (!target) throw new QuickAskError("Question not found on this branch", 404);
      owner.getQuickAskRuntime().delete({ branchId, threadId: target.data.threadId ?? target.threadId ?? "default" }, targetId);
    } else owner.getQuickAskRuntime().delete({ branchId, threadId: identifier(body.threadId, "threadId") }, undefined, requestId);
    return NextResponse.json({ success: true });
  } catch (error) { return failure(error); }
}

/** A cold materialization is a file operation, not an excuse to boot the full Agent runtime. */
async function forkSideAsk(id: string, file: string, body: RequestBody): Promise<NextResponse> {
  const scope = scopeOf(body);
  const targetId = body.targetId === undefined ? undefined : identifier(body.targetId, "targetId");
  const active = getRpcSession(id)?.peekQuickAskRuntime()?.snapshots().find((run) =>
    run.threadId === scope.threadId && run.branchId === scope.branchId && run.status === "running");
  const operation = forkQuickAskSession(id, file, scope, targetId, body.threadId === undefined);
  if (body.wait === false && !targetId && active) {
    void operation.catch((error) => console.error("[pi-web] Side Ask conversion failed:", quickAskErrorText(error)));
    return NextResponse.json({ success: true, pending: true, run: active }, { status: 202 });
  }
  return NextResponse.json(await operation);
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    if (req.signal.aborted) throw new QuickAskError("Request ended before Side Ask admission", 499);
    const { id } = await params;
    const body = await requestBody(req);
    const file = await sourceFile(id);
    if (req.signal.aborted) throw new QuickAskError("Request ended before Side Ask admission", 499);
    if (body.action === "fork") return await forkSideAsk(id, file, body);
    const owner = await ownerForWrite(id, file);
    if (req.signal.aborted) throw new QuickAskError("Request ended before Side Ask admission", 499);
    const side = owner.getQuickAskRuntime();
    if (body.action === "stop") {
      const run = side.stop(identifier(body.runId, "runId"));
      if (!run) throw new QuickAskError("Side Ask run not found", 404);
      return NextResponse.json({ success: true, run });
    }
    if (body.action === "promote_branch") {
      return NextResponse.json({ success: true, promotedCount: side.promote(identifier(body.fromBranchId, "fromBranchId")) });
    }
    if (body.action !== undefined && body.action !== "start") throw new QuickAskError("Unsupported Side Ask action", 400);
    const scope = scopeOf(body);
    const question = typeof body.question === "string" ? body.question.trim() : "";
    const images = parseQuickAskImages(body.images);
    if (!question && !images.length) throw new QuickAskError("question or images is required", 400);
    if (Object.hasOwn(body, "expectedParentId") && body.expectedParentId !== null && typeof body.expectedParentId !== "string") {
      throw new QuickAskError("expectedParentId must be a string or null", 400);
    }
    let model: { provider: string; id: string } | undefined;
    if (body.model !== undefined) {
      if (!body.model || typeof body.model !== "object") throw new QuickAskError("model must be an object", 400);
      const selected = body.model as { provider?: unknown; id?: unknown; modelId?: unknown };
      model = { provider: identifier(selected.provider, "model.provider"), id: identifier(selected.id ?? selected.modelId, "model.id") };
    }
    const thinking = body.thinkingLevel;
    if (thinking !== undefined && thinking !== "auto" && (typeof thinking !== "string" || !THINKING_LEVELS.has(thinking))) {
      throw new QuickAskError("Invalid Side Ask thinking level", 400);
    }
    if (req.signal.aborted) throw new QuickAskError("Request ended before Side Ask admission", 499);
    const admitted = await side.start({ ...scope, question, images,
      ...(typeof body.threadTitle === "string" ? { threadTitle: body.threadTitle.slice(0, 512) } : {}),
      ...(body.requestId === undefined ? {} : { requestId: identifier(body.requestId, "requestId") }),
      ...(Object.hasOwn(body, "expectedParentId") ? { expectedParentId: body.expectedParentId as string | null } : {}),
      ...(model ? { model } : {}), ...(thinking && thinking !== "auto" ? { thinkingLevel: thinking as ThinkingLevel } : {}),
    });
    if (body.action === "start") return NextResponse.json({ success: true, run: admitted }, { status: 202 });
    // Existing callers keep SSE and preparation errors such as HTTP 413, without owning cancellation.
    const ready = await side.whenReady(admitted.id);
    return eventResponse(createQuickAskEventStream(req, ready, side, "legacy"));
  } catch (error) { return failure(error); }
}
