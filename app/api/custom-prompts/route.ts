import { existsSync } from "node:fs";
import { NextRequest, NextResponse } from "next/server";
import {
  getCustomPromptsFilePath,
  readCustomPrompts,
  saveCustomPrompt,
  deleteCustomPrompt,
  reorderCustomPrompts,
} from "@/lib/custom-prompts-state";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

export async function GET(): Promise<NextResponse> {
  const filePath = getCustomPromptsFilePath();
  try {
    const prompts = readCustomPrompts();
    return NextResponse.json({ prompts, filePath, fileExists: existsSync(filePath) }, { headers: noStore });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to read prompts file", filePath, fileExists: existsSync(filePath) },
      { status: 500, headers: noStore }
    );
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await req.json();
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400, headers: noStore });
    }

    if (body.action === "reorder" || Array.isArray(body.orderedIds)) {
      const orderedIds = Array.isArray(body.orderedIds) ? body.orderedIds : [];
      const prompts = reorderCustomPrompts(orderedIds);
      return NextResponse.json({ ok: true, prompts }, { headers: noStore });
    }

    const { id, title, content, description, order } = body;
    const cleanTitle = typeof title === "string" ? title.trim() : "";
    const cleanContent = typeof content === "string" ? content : "";

    if (!cleanTitle && !cleanContent) {
      return NextResponse.json({ error: "Title or content is required" }, { status: 400, headers: noStore });
    }

    const saved = saveCustomPrompt({
      id: typeof id === "string" && id.trim() ? id.trim() : undefined,
      title: cleanTitle,
      content: cleanContent,
      description: typeof description === "string" ? description.trim() : undefined,
      order: typeof order === "number" ? order : undefined,
    });

    const prompts = readCustomPrompts();
    return NextResponse.json({ prompt: saved, prompts }, { headers: noStore });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to save prompt" },
      { status: 500, headers: noStore }
    );
  }
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  try {
    const { searchParams } = new URL(req.url);
    let id = searchParams.get("id");

    if (!id) {
      try {
        const body = await req.json();
        if (body && typeof body.id === "string") {
          id = body.id;
        }
      } catch {
        // Ignored
      }
    }

    if (!id) {
      return NextResponse.json({ error: "Prompt id is required" }, { status: 400, headers: noStore });
    }

    const ok = deleteCustomPrompt(id);
    const prompts = readCustomPrompts();
    return NextResponse.json({ ok, prompts }, { headers: noStore });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete prompt" },
      { status: 500, headers: noStore }
    );
  }
}
