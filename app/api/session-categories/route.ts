import { NextResponse } from "next/server";
import {
  readSessionCategoryState,
  setSessionCategory,
  type SessionStorageCategory,
} from "@/lib/session-category-state";
import { readHiddenState, restoreSessionForStorage } from "@/lib/hidden-state";
import { setFavorite } from "@/lib/favorite-state";
import { listAllSessions, listArchivedSessions } from "@/lib/session-reader";
import { projectIdentityKey } from "@/lib/project-identity";
import { localDeviceId, readActivityConfig } from "@/lib/activity-peers";

function validSessionId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validCategory(value: unknown): value is SessionStorageCategory | null {
  return value === null || value === "to_discuss" || value === "to_revise" || value === "completed";
}

async function restoreSessionStorage(sessionId: string): Promise<boolean> {
  const deviceId = localDeviceId(readActivityConfig());
  if (readHiddenState().devices.includes(deviceId)) return false;
  const sessions = [
    ...await listAllSessions({ force: true }),
    ...await listArchivedSessions({ force: true }),
  ];
  const session = sessions.find((candidate) => candidate.id === sessionId);
  restoreSessionForStorage(sessionId, session ? session.projectKey ?? projectIdentityKey(session.projectRoot ?? session.cwd) : undefined);
  return true;
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null) as { kind?: unknown; id?: unknown; category?: unknown } | null;
    if (body?.kind !== "session" || !validSessionId(body.id)) {
      return NextResponse.json({ error: "kind=session and non-empty id are required" }, { status: 400 });
    }
    if (!validCategory(body.category)) {
      return NextResponse.json({ error: "category must be 'to_discuss', 'to_revise', 'completed', or null" }, { status: 400 });
    }
    if (body.category !== null) {
      if (!await restoreSessionStorage(body.id)) {
        return NextResponse.json({ error: "the session's device is hidden" }, { status: 409 });
      }
      setFavorite(body.id, false);
    }
    const categories = setSessionCategory(body.id, body.category);
    return NextResponse.json({ ok: true, categories });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const kind = params.get("kind");
    const id = params.get("id");
    if (kind !== "session" || !validSessionId(id)) {
      return NextResponse.json({ error: "kind=session and non-empty id are required" }, { status: 400 });
    }
    return NextResponse.json({ ok: true, categories: setSessionCategory(id, null) });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function GET() {
  try {
    return NextResponse.json({ categories: readSessionCategoryState() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
