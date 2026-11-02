import { NextResponse } from "next/server";
import { readFavoriteState, setFavorite } from "@/lib/favorite-state";
import { readHiddenState, restoreSessionForStorage } from "@/lib/hidden-state";
import { setSessionCategory } from "@/lib/session-category-state";
import { listAllSessions, listArchivedSessions } from "@/lib/session-reader";
import { projectIdentityKey } from "@/lib/project-identity";
import { localDeviceId, readActivityConfig } from "@/lib/activity-peers";

function validSessionId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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
    const body = await req.json().catch(() => null) as { kind?: unknown; id?: unknown } | null;
    if (body?.kind !== "session" || !validSessionId(body.id)) {
      return NextResponse.json({ error: "kind=session and non-empty id are required" }, { status: 400 });
    }
    if (!await restoreSessionStorage(body.id)) {
      return NextResponse.json({ error: "the session's device is hidden" }, { status: 409 });
    }
    const favorites = setFavorite(body.id, true);
    setSessionCategory(body.id, null);
    return NextResponse.json({ ok: true, favorites });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const params = new URL(req.url).searchParams;
  const kind = params.get("kind");
  const id = params.get("id");
  if (kind !== "session" || !validSessionId(id)) {
    return NextResponse.json({ error: "kind=session and non-empty id are required" }, { status: 400 });
  }
  return NextResponse.json({ ok: true, favorites: setFavorite(id, false) });
}

export async function GET() {
  return NextResponse.json({ favorites: readFavoriteState() }, { headers: { "Cache-Control": "no-store" } });
}
