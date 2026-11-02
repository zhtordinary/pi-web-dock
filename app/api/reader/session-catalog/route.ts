import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { GET as readActivity } from "@/app/api/session-runs/route";

export const dynamic = "force-dynamic";

/** Reuse the business projection while suppressing analysis restoration on every peer. */
export function GET(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  const url = new URL(request.url);
  url.searchParams.set("observeOnly", "1");
  return readActivity(new Request(url, request));
}
