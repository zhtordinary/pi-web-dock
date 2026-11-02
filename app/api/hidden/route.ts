import { NextResponse } from "next/server";
import { clearProjectHidden, HIDDEN_KINDS, setHidden, type HiddenKind } from "@/lib/hidden-state";
import { setFavorite } from "@/lib/favorite-state";
import { setSessionCategory } from "@/lib/session-category-state";
import { attachSessionProjectInfo, listAllSessions, listArchivedSessions } from "@/lib/session-reader";
import { getRpcSessionInfos } from "@/lib/rpc-manager";
import { projectIdentityKey } from "@/lib/project-identity";

export const dynamic = "force-dynamic";

function parseKind(value: unknown): HiddenKind | null {
  return typeof value === "string" && (HIDDEN_KINDS as readonly string[]).includes(value)
    ? (value as HiddenKind)
    : null;
}

// 隐藏收纳写入入口：本机数据 POST /api/hidden；异设备数据由聚合端
// 经 /api/remote/hidden?peer=<id> 代理转发（路由自带 POST/DELETE 透传）。

async function clearDeviceStorage(): Promise<void> {
  const sessions = [
    ...await listAllSessions({ force: true }),
    ...await listArchivedSessions({ force: true }),
  ];
  for (const session of sessions) {
    setFavorite(session.id, false);
    setSessionCategory(session.id, null);
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null) as { kind?: unknown; id?: unknown } | null;
    const kind = parseKind(body?.kind);
    if (!kind || typeof body?.id !== "string" || !body.id.trim()) {
      return NextResponse.json({ error: "kind (session|project|device) and id are required" }, { status: 400 });
    }
    const hidden = setHidden(kind, body.id, true);
    if (kind === "session") {
      setFavorite(body.id, false);
      setSessionCategory(body.id, null);
    } else if (kind === "device") {
      await clearDeviceStorage();
    }
    return NextResponse.json({ ok: true, hidden });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const kind = parseKind(params.get("kind"));
    const id = params.get("id");
    if (!kind || !id?.trim()) {
      return NextResponse.json({ error: "kind (session|project|device) and id are required" }, { status: 400 });
    }
    const hidden = kind === "project"
      ? clearProjectHidden(id, [
        ...await listAllSessions({ readOnly: true }),
        ...await listArchivedSessions({ readOnly: true }),
        ...await attachSessionProjectInfo(getRpcSessionInfos()),
      ].map((session) => ({ id: session.id, projectKey: session.projectKey ?? projectIdentityKey(session.projectRoot ?? session.cwd) })))
      : setHidden(kind, id, false);
    return NextResponse.json({ ok: true, hidden });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
