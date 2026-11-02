import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  SLASH_FAVORITES_FILE,
  readSlashFavoriteState,
  setSlashFavoriteCategories,
  setSlashFavoriteKeys,
} from "@/lib/slash-favorite-state";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

function failure(error: unknown, code: string, status: number): NextResponse {
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error), code },
    { status, headers: noStore },
  );
}

export async function GET() {
  try {
    const favorites = await Promise.resolve(readSlashFavoriteState());
    return NextResponse.json(
      { favorites, filePath: SLASH_FAVORITES_FILE },
      { headers: noStore },
    );
  } catch (error) {
    return failure(error, "slash_favorites_read_failed", 503);
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403, headers: noStore });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415, headers: noStore });
  }
  const body = (await req.json().catch(() => null)) as { keys?: unknown; categories?: unknown } | null;
  if (!body || (!Array.isArray(body.keys) && !Array.isArray(body.categories))) {
    return NextResponse.json({ error: "keys must be an array (or categories must be an array)" }, { status: 400, headers: noStore });
  }
  try {
    const updated = Array.isArray(body.categories)
      ? setSlashFavoriteCategories(body.categories)
      : setSlashFavoriteKeys(body.keys);
    return NextResponse.json({ ok: true, favorites: updated, filePath: SLASH_FAVORITES_FILE }, { headers: noStore });
  } catch (error) {
    return failure(error, "slash_favorites_write_failed", 500);
  }
}
