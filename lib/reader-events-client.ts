"use client";
import { createReaderEventsClient } from "../public/reader-events-client.mjs";

export type ReaderEvent = Record<string, unknown> & { type: string; device?: string };
type Packet = { kind: string; data?: ReaderEvent; sharing?: string };
let client: ReturnType<typeof createReaderEventsClient> | undefined;

/** All component subscribers in this document use the same cross-page broker. */
export function openReaderEventSource(types?: readonly string[]) {
  client ??= createReaderEventsClient(window);
  const source = {
    onmessage: null as ((event: MessageEvent<string>) => void) | null,
    onopen: null as (() => void) | null,
    onerror: null as (() => void) | null,
    sharing: null as string | null,
    close: () => {},
  };
  let closed = false;
  const unsubscribe = client.subscribe((packet: Packet) => {
    if (closed) return;
    if (packet.kind === "open") { source.sharing = packet.sharing ?? source.sharing; source.onopen?.(); }
    else if (packet.kind === "error") source.onerror?.();
    else if (packet.kind === "event" && packet.data && (!types || types.includes(packet.data.type))) {
      source.onmessage?.(new MessageEvent("message", { data: JSON.stringify(packet.data) }));
    }
  });
  source.close = () => { if (!closed) { closed = true; unsubscribe(); } };
  return source;
}
