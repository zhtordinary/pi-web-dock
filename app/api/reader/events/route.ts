import { getReaderRuntimeChannel, READER_RUNTIME_BUILD } from "@/lib/reader-runtime-build";
import { configuredPeerList, localDeviceIdentity, readActivityConfig } from "@/lib/activity-peers";
import { activityCursor, activityEventsSince, subscribeActivityEvents } from "@/lib/activity-events";
import { subscribePeerActivity } from "@/lib/peer-activity-poller";
import { getRunningRpcSessionIds, subscribeRunningSessions, getWaitingForUserRequests, subscribeWaitingUserRequests } from "@/lib/rpc-manager";
import { subscribeSessionWaitChanges } from "@/lib/session-wait-events";
import { createReaderEventStream } from "@/lib/reader-event-stream";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const config = readActivityConfig();
  const local = localDeviceIdentity(config, new Date().toISOString());
  const cursors: Record<string, { bootId: string; seq: number }> = {};
  try {
    const raw = new URL(request.url).searchParams.get("cursors");
    if (raw && raw.length <= 16384) {
      const parsed = JSON.parse(raw);
      for (const [id, value] of Object.entries(parsed).slice(0, 64)) {
        const cursor = value as { bootId?: unknown; seq?: unknown };
        if (typeof cursor?.bootId === "string" && cursor.bootId.length <= 128 && Number.isSafeInteger(cursor.seq) && Number(cursor.seq) >= 0) {
          cursors[id] = { bootId: cursor.bootId, seq: Number(cursor.seq) };
        }
      }
    }
  } catch { /* Invalid resume tokens get a fresh snapshot. */ }
  const shouldForward = (event: { bootId?: unknown; seq?: unknown }, device: string) => {
    const previous = cursors[device];
    return !previous || event.bootId !== previous.bootId || typeof event.seq !== "number" || event.seq > previous.seq;
  };
  const activity = (event: Record<string, unknown>, device: string) => ({
    ...event, device, type: event.kind === "wait" ? "waits_changed" : "activity",
  });
  const stream = createReaderEventStream(request, {
    subscribe(emit, register) {
      register(subscribeActivityEvents(event => { if (shouldForward(event, local.id)) emit(activity({ ...event }, local.id)); }));
      register(subscribeRunningSessions(ids => emit({ type: "running", device: local.id, runningSessionIds: ids })));
      register(subscribeWaitingUserRequests(sessions => emit({ type: "waiting_user", device: local.id, sessions })));
      register(subscribeSessionWaitChanges());
      for (const peer of configuredPeerList(config, local)) {
        const subscription = subscribePeerActivity(peer,
          event => { if (shouldForward(event, peer.id)) emit(activity({ ...event }, peer.id)); },
          state => emit({ type: "peer_state", device: peer.id, online: state === "online" }));
        register(() => subscription.unsubscribe());
      }
    },
    snapshot() {
      const cursor = activityCursor();
      const requested = cursors[local.id];
      const retained = activityEventsSince(0);
      const gap = Boolean(requested && (requested.bootId !== cursor.bootId || requested.seq > cursor.seq
        || (retained.length && requested.seq < retained[0].seq - 1)));
      const since = !gap && requested?.bootId === cursor.bootId ? requested.seq : 0;
      return [
        { type: "activity_meta", device: local.id, ...cursor, reset: gap, snapshotDomains: ["runtime", "waiting_user"] },
        { type: "runtime_identity", device: local.id, bootId: cursor.bootId, channel: getReaderRuntimeChannel(), ...READER_RUNTIME_BUILD },
        { type: "running", device: local.id, runningSessionIds: getRunningRpcSessionIds(), snapshot: true, snapshotVersion: cursor },
        { type: "waiting_user", device: local.id, sessions: getWaitingForUserRequests(), snapshot: true, snapshotVersion: cursor },
        { type: "waits_changed", device: local.id, snapshot: true },
        ...activityEventsSince(since).map(event => activity({ ...event, replay: true }, local.id)),
      ];
    },
  });
  return new Response(stream, { headers: {
    "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", Connection: "keep-alive",
  } });
}
