import { NextResponse } from "next/server";
import { readModelRoutingConfig, writeModelRoutingConfig, type ModelRoutingConfig } from "@/lib/model-routing";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const config = await readModelRoutingConfig();
    return NextResponse.json(config);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const body = (await req.json()) as ModelRoutingConfig;
    await writeModelRoutingConfig(body);
    const updated = await readModelRoutingConfig();
    return NextResponse.json({ success: true, config: updated });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  return PUT(req);
}
