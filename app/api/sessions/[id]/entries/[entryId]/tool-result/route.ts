import { NextResponse } from "next/server";
import { getSessionEntries, resolveSessionPath } from "@/lib/session-reader";

/** Return deferred tool-result text only after the user expands its tool call. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; entryId: string }> },
) {
  const { id, entryId } = await params;
  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) return NextResponse.json({ error: "Session not found" }, { status: 404 });

    const entry = getSessionEntries(filePath).find((candidate) => candidate.id === entryId);
    if (!entry || entry.type !== "message" || entry.message.role !== "toolResult") {
      return NextResponse.json({ error: "Tool result not found" }, { status: 404 });
    }

    const text = entry.message.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    return NextResponse.json({ text }, { headers: { "Cache-Control": "private, no-cache" } });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
