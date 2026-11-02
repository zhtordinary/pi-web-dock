import { createSessionSearchGet } from "@/lib/session-history-http";
import { loadSessionHistoryProjection } from "@/lib/session-history-source";

export const dynamic = "force-dynamic";
export const GET = createSessionSearchGet(loadSessionHistoryProjection);
