import { NextResponse } from "next/server";
import { abortSubagent, getSubagentRun, steerSubagent } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

function parseParentSessionId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("parentSessionId must be a non-empty string");
  }
  return value.trim();
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const parentSessionId = parseParentSessionId(new URL(req.url).searchParams.get("parentSessionId") ?? undefined);
    const run = await getSubagentRun(id, parentSessionId);
    if (!run) return NextResponse.json({ error: "Subagent not found" }, { status: 404 });
    return NextResponse.json({ run });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message.startsWith("parentSessionId ") ? 400 : 500 });
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = await req.json() as { action?: unknown; message?: unknown; parentSessionId?: unknown };
    const parentSessionId = parseParentSessionId(body.parentSessionId);
    if (body.action === "steer") {
      if (typeof body.message !== "string" || !body.message.trim()) {
        return NextResponse.json({ error: "message required" }, { status: 400 });
      }
      await steerSubagent(id, body.message, parentSessionId);
    } else if (body.action === "abort") {
      await abortSubagent(id, parentSessionId);
    } else {
      return NextResponse.json({ error: "action must be steer or abort" }, { status: 400 });
    }
    return NextResponse.json({ ok: true, run: await getSubagentRun(id, parentSessionId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, {
      status: message.startsWith("parentSessionId ") ? 400 : message.includes("not running") ? 409 : 500,
    });
  }
}
