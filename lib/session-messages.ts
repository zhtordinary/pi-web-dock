import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { SESSION_PEER_CUSTOM_TYPE, type SessionPeerDetails, type SessionPeerMessage } from "./session-peer-message.ts";

export { SESSION_PEER_CUSTOM_TYPE } from "./session-peer-message.ts";
export type { SessionPeerDetails, SessionPeerMessage } from "./session-peer-message.ts";

export type MessageIdentity = {
  deviceId: string;
  deviceName: string;
  sessionId: string;
  sessionFile: string | null;
  title: string | null;
  project: string;
};
export type MessageKind = "info" | "request" | "handoff" | "question" | "reply";
export type MessageOperation = "prompt" | "steer" | "follow_up" | "reply";
export type WorkStatus = "accepted" | "completed" | "blocked" | "declined";
export type ReplyDelivery = "follow_up" | "steer";
export type ReplyDeliveryPolicy = ReplyDelivery | "auto";
export type ReplyDeliverySource =
  | "explicit_user_approval"
  | "default_auto"
  | "default_follow_up"
  | "recipient_downgrade"
  | "auto_active"
  | "auto_idle";
export type SessionMessage = {
  version: 1;
  id: string;
  createdAt: string;
  sequence?: number;
  sender: MessageIdentity;
  recipient: string;
  replyTo: string;
  kind: MessageKind;
  /** Actual native control operation used for this message, when known. */
  operation?: MessageOperation;
  inReplyTo?: string;
  taskId?: string;
  workStatus?: WorkStatus;
  /** Effective mode used for this message's external send, when one exists. */
  replyDelivery?: ReplyDelivery;
  /** Original request policy; missing legacy fields are interpreted as auto. */
  replyDeliveryRequested?: ReplyDeliveryPolicy;
  replyDeliverySource?: ReplyDeliverySource;
  responseRequired: boolean;
  body: string;
  transport: "pending" | "accepted" | "unknown";
  receiverStatus?: "pending" | "running" | "completed" | "cleared" | "failed";
  receiverNote?: string;
};
export type SessionMessageReceipt = {
  messageId: string;
  target: string;
  transport: "pending" | "accepted" | "unknown";
  accepted: boolean;
  operation?: MessageOperation;
  duplicate?: boolean;
  responseRequired?: boolean;
  replyDeliveryRequested?: ReplyDeliveryPolicy;
  replyDelivery?: ReplyDelivery;
  replyDeliverySource?: ReplyDeliverySource;
  error?: string;
  note?: string;
  receiverStatus?: SessionMessage["receiverStatus"];
  receiverNote?: string;
};

function validId(id: string): string {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("invalid messageId");
  return id;
}
function file(root: string, id: string): string { return join(root, validId(id) + ".json"); }
function parseSessionMessage(text: string): SessionMessage {
  try { return JSON.parse(text) as SessionMessage; }
  catch { throw new Error("session message is unreadable"); }
}
export function sessionMessageReturnRoute(message: Pick<SessionMessage, "replyTo" | "sender">): string {
  return message.replyTo || message.sender.sessionId;
}
export function readSessionMessage(root: string, id: string, caller: string): SessionMessage {
  const messagePath = file(root, id);
  let message: SessionMessage;
  try {
    message = JSON.parse(readFileSync(messagePath, "utf8")) as SessionMessage;
  } catch (error) {
    throw new Error("session message receipt is malformed", { cause: error });
  }
  if (![message.sender.sessionId, message.recipient, sessionMessageReturnRoute(message)].includes(caller)) {
    throw new Error("message is not addressed to this session");
  }
  return message;
}

/** Read one exact message after the caller has already passed a live target-control boundary. */
export function readSessionMessageForControl(root: string, id: string): SessionMessage {
  try {
    return parseSessionMessage(readFileSync(file(root, id), "utf8"));
  } catch (error) {
    throw new Error("session message receipt is malformed", { cause: error });
  }
}

function requestedReplyDelivery(message: Pick<SessionMessage, "replyDelivery" | "replyDeliveryRequested" | "responseRequired">): ReplyDeliveryPolicy | undefined {
  return message.replyDeliveryRequested ?? message.replyDelivery ?? (message.responseRequired ? "auto" : undefined);
}

function deliveryReceiptFields(message: Pick<SessionMessage, "replyDelivery" | "replyDeliveryRequested" | "replyDeliverySource" | "responseRequired">): Pick<SessionMessageReceipt, "replyDeliveryRequested" | "replyDelivery" | "replyDeliverySource"> {
  const requested = requestedReplyDelivery(message);
  return {
    ...(requested ? { replyDeliveryRequested: requested } : {}),
    ...(message.replyDelivery ? { replyDelivery: message.replyDelivery } : {}),
    ...(message.replyDeliverySource ? { replyDeliverySource: message.replyDeliverySource } : {}),
  };
}

export function sessionMessageStatus(root: string, id: string, caller: string) {
  const message = readSessionMessage(root, id, caller);
  const dir = join(root, validId(id) + "-replies");
  let names: string[] = [];
  try { names = readdirSync(dir); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const replies = names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => {
    let reply: SessionMessage;
    try {
      reply = JSON.parse(readFileSync(join(dir, name), "utf8")) as SessionMessage;
    } catch (error) {
      throw new Error("session reply receipt is malformed", { cause: error });
    }
    return {
      id: reply.id,
      sequence: reply.sequence ?? 0,
      createdAt: reply.createdAt,
      workStatus: reply.workStatus,
      ...deliveryReceiptFields(reply),
      transport: reply.transport,
      ...(reply.operation ? { operation: reply.operation } : {}),
      body: reply.body.slice(0, 1000),
    };
  }).sort((a, b) => a.sequence - b.sequence).slice(-20);
  return {
    message: { ...message, ...deliveryReceiptFields(message), body: message.body.slice(0, 2000) },
    replies,
    note: "Transport acceptance is not acknowledgement or verified completion. Work status is reported by the recipient.",
  };
}

/** Resolve the one response-required peer request visible to this recipient.
 * A short ref is accepted only when it identifies one exact stored message;
 * this keeps model-facing refs compact without guessing across requests. */
export function resolveSessionReplyMessageId(root: string, recipient: string, ref?: string): string {
  const exact = ref?.trim();
  // Exact IDs also support progress updates and idempotent retries after a
  // final reply; the normal recipient/return-route checks still apply.
  if (exact && /^[a-f0-9]{64}$/.test(exact)) {
    const message = readSessionMessage(root, exact, recipient);
    if (message.recipient !== recipient) throw new Error("only the original recipient may reply");
    if (message.kind === "reply" || !message.responseRequired) throw new Error("message does not require a reply");
    return exact;
  }
  if (exact && !/^[a-f0-9]{8,63}$/.test(exact)) throw new Error("invalid replyRef");
  const candidates: SessionMessage[] = [];
  let names: string[] = [];
  try { names = readdirSync(root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    let message: SessionMessage;
    try { message = JSON.parse(readFileSync(join(root, name), "utf8")) as SessionMessage; } catch { continue; }
    if (message.id !== name.slice(0, -5) || message.recipient !== recipient
      || message.kind === "reply" || !message.responseRequired) continue;
    if (exact) {
      if (message.id.startsWith(exact)) candidates.push(message);
      continue;
    }
    if (message.receiverStatus === "cleared" || message.receiverStatus === "failed") continue;
    let replies: string[] = [];
    try { replies = readdirSync(join(root, message.id + "-replies")); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const completed = replies.some((replyName) => {
      if (!/^[a-f0-9]{64}\.json$/.test(replyName)) return false;
      try {
        const reply = JSON.parse(readFileSync(file(root, replyName.slice(0, -5)), "utf8")) as SessionMessage;
        return reply.inReplyTo === message.id && reply.transport === "accepted"
          && (reply.workStatus === "completed" || reply.workStatus === "declined");
      } catch { return false; }
    });
    if (!completed) candidates.push(message);
  }
  if (candidates.length === 1) return candidates[0].id;
  if (candidates.length > 1) throw new Error(`replyRef is ambiguous; use messageId from one of: ${candidates.map((item) => item.id).join(", ")}`);
  throw new Error(exact ? "replyRef does not identify an addressed request" : "reply requires messageId; no pending request is addressed to this session");
}

function writeMessageState(path: string, message: SessionMessage): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(message), { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  } finally {
    try { unlinkSync(temp); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** Receiver observations supplement, rather than replace, transport acceptance. */
export function recordSessionMessageOutcome(root: string, id: string, status: "cleared" | "failed", note: string): void {
  const path = file(root, id);
  let message: SessionMessage;
  try {
    message = JSON.parse(readFileSync(path, "utf8")) as SessionMessage;
  } catch (error) {
    throw new Error("session message receipt is malformed", { cause: error });
  }
  if (message.receiverStatus === "cleared" || message.receiverStatus === "failed") return;
  writeMessageState(path, { ...message, receiverStatus: status, receiverNote: note.slice(0, 500) });
}

export function renderSessionMessage(message: SessionMessage): SessionPeerMessage {
  const { body, id, ...details } = message;
  const peerDetails: SessionPeerDetails = {
    source: "session-control",
    messageId: id,
    uiContent: body,
    ...details,
  };
  return {
    customType: SESSION_PEER_CUSTOM_TYPE,
    // The SDK deliberately omits details from convertToLlm(). Keep the
    // model-facing envelope short and explicit; full identity stays in the
    // structured details and the durable SessionMessage receipt.
    content: `[Agent peer ${message.kind}; from=${(message.sender.title || message.sender.sessionId.slice(0, 8)).replace(/[\r\n\[\]]/g, " ").slice(0, 80)}${message.responseRequired ? `; replyRef=${id}` : ""}${message.inReplyTo ? `; inReplyTo=${message.inReplyTo}` : ""}${message.workStatus ? `; workStatus=${message.workStatus} (reported)` : ""}]\n${body}`,
    display: true,
    details: peerDetails,
  };
}

export async function deliverSessionMessage(input: {
  root: string;
  callId: string;
  sender: MessageIdentity;
  recipient: string;
  replyTo?: string;
  kind?: MessageKind;
  inReplyTo?: string;
  taskId?: string;
  workStatus?: WorkStatus;
  replyDelivery?: ReplyDelivery;
  operation?: MessageOperation;
  responseRequired?: boolean;
  body: string;
  send: (message: SessionPeerMessage, delivery?: ReplyDelivery) => Promise<unknown>;
  resolveReplyDelivery?: (context: { original: SessionMessage }) => ReplyDelivery;
}): Promise<SessionMessageReceipt> {
  const body = input.body.trim();
  if (!body || body.length > 20000) throw new Error("message must contain 1..20000 characters");
  if (!input.callId || !input.sender.sessionId || !input.recipient) throw new Error("missing message identity");
  if (input.recipient === input.sender.sessionId) throw new Error("cannot send a message to self");
  const kind = input.kind ?? "info";
  if (!["info", "request", "handoff", "question", "reply"].includes(kind)) throw new Error("invalid message kind");
  const operation = input.operation;
  if (operation !== undefined && !["prompt", "steer", "follow_up", "reply"].includes(operation)) throw new Error("invalid message operation");
  if (kind === "reply" && operation !== undefined && operation !== "reply") throw new Error("reply operation must be reply");
  if (kind !== "reply" && operation === "reply") throw new Error("reply operation requires kind reply");
  const requestedInput = input.replyDelivery;
  if (requestedInput !== undefined && !["follow_up", "steer"].includes(requestedInput)) throw new Error("invalid replyDelivery");
  const responseRequired = kind === "reply" ? false : input.responseRequired ?? kind !== "info";
  let original: SessionMessage | undefined;
  let requestedDelivery: ReplyDeliveryPolicy | undefined;
  let replyDelivery: ReplyDelivery | undefined;
  let replyDeliverySource: ReplyDeliverySource | undefined;
  let resolveAutoReply = false;

  if (kind === "reply") {
    if (!input.inReplyTo) throw new Error("reply requires messageId");
    original = readSessionMessage(input.root, input.inReplyTo, input.sender.sessionId);
    if (original.recipient !== input.sender.sessionId || original.kind === "reply" || !original.responseRequired) {
      throw new Error("only the original recipient may reply to a response-required message");
    }
    if (input.recipient !== sessionMessageReturnRoute(original)) throw new Error("reply target does not match recorded return route");
    if (!["accepted", "completed", "blocked", "declined"].includes(input.workStatus ?? "")) throw new Error("reply requires a workStatus");
    const approved = requestedReplyDelivery(original) ?? "auto";
    if (requestedInput === "steer" && approved !== "steer") throw new Error("reply cannot upgrade delivery without original approval");
    if (requestedInput === "follow_up") {
      requestedDelivery = "follow_up";
      replyDelivery = "follow_up";
      replyDeliverySource = "recipient_downgrade";
    } else {
      requestedDelivery = approved;
      if (approved === "auto") resolveAutoReply = true;
      else {
        replyDelivery = approved;
        replyDeliverySource = original.replyDeliverySource ?? "explicit_user_approval";
      }
    }
  } else if (input.inReplyTo || input.workStatus) {
    throw new Error("messageId and workStatus are only valid for reply");
  } else {
    if (requestedInput === "steer" && (!responseRequired || kind === "info")) throw new Error("steer reply delivery requires a response-required coordination request");
    if (responseRequired) {
      requestedDelivery = requestedInput ?? "auto";
      if (requestedDelivery === "auto") replyDeliverySource = "default_auto";
      else {
        replyDelivery = requestedDelivery;
        replyDeliverySource = "explicit_user_approval";
      }
    }
  }

  const id = createHash("sha256").update(input.sender.sessionId + "\0" + input.callId).digest("hex");
  const path = file(input.root, id);
  const sameIdentity = (prior: SessionMessage): boolean => {
    const priorRequested = prior.replyDeliveryRequested
      ?? (prior.kind === "reply" ? undefined : prior.replyDelivery ?? (prior.responseRequired ? "auto" : undefined));
    const deliveryMatches = priorRequested === requestedDelivery
      || (prior.replyDeliveryRequested === undefined && prior.kind === "reply" && (requestedDelivery === "auto" || prior.replyDelivery === requestedDelivery));
    return prior.body === body
      && prior.recipient === input.recipient
      && prior.kind === kind
      && prior.operation === operation
      && prior.inReplyTo === input.inReplyTo
      && prior.workStatus === input.workStatus
      && prior.replyTo === (input.replyTo || input.sender.sessionId)
      && deliveryMatches
      && prior.responseRequired === responseRequired
      && prior.taskId === input.taskId;
  };
  const duplicateReceipt = (prior: SessionMessage) => ({
    messageId: id,
    target: prior.recipient,
    transport: prior.transport,
    duplicate: true,
    accepted: prior.transport === "accepted",
    ...(prior.operation ? { operation: prior.operation } : {}),
    ...deliveryReceiptFields(prior),
    ...(prior.receiverStatus ? { receiverStatus: prior.receiverStatus, receiverNote: prior.receiverNote } : {}),
  });

  // Dynamic auto selection is a one-time decision. Replays return the first
  // persisted effective mode before sampling the target again.
  if (existsSync(path)) {
    const prior = readSessionMessage(input.root, id, input.sender.sessionId);
    if (!sameIdentity(prior)) throw new Error("tool call identity reused with a different message");
    return duplicateReceipt(prior);
  }

  if (resolveAutoReply) {
    if (!original) throw new Error("reply is missing its original message");
    replyDelivery = input.resolveReplyDelivery?.({ original }) ?? "follow_up";
    if (!["follow_up", "steer"].includes(replyDelivery)) throw new Error("reply delivery resolver returned an invalid mode");
    replyDeliverySource = replyDelivery === "steer" ? "auto_active" : "auto_idle";
  }

  const message: SessionMessage = {
    version: 1, id, createdAt: new Date().toISOString(), sender: input.sender,
    recipient: input.recipient, replyTo: input.replyTo || input.sender.sessionId, kind,
    ...(operation ? { operation } : {}),
    ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.workStatus ? { workStatus: input.workStatus } : {}),
    ...(requestedDelivery ? { replyDeliveryRequested: requestedDelivery } : {}),
    ...(replyDelivery ? { replyDelivery } : {}),
    ...(replyDeliverySource ? { replyDeliverySource } : {}),
    responseRequired, body, transport: "pending",
  };
  mkdirSync(input.root, { recursive: true, mode: 0o700 });
  try { writeFileSync(path, JSON.stringify(message), { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const prior = readSessionMessage(input.root, id, input.sender.sessionId);
    if (!sameIdentity(prior)) throw new Error("tool call identity reused with a different message");
    return duplicateReceipt(prior);
  }
  let replyPath: string | undefined;
  if (message.inReplyTo) {
    const dir = join(input.root, validId(message.inReplyTo) + "-replies");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    message.sequence = readdirSync(dir).filter(name => name.endsWith(".json")).length + 1;
    replyPath = join(dir, id + ".json");
    writeFileSync(replyPath, JSON.stringify(message), { flag: "wx", mode: 0o600 });
  }
  // Persist before the external effect; pending/unknown must never auto-replay.
  let failure: string | undefined;
  try {
    if (message.kind === "reply" && !message.replyDelivery) throw new Error("reply delivery was not resolved");
    await input.send(renderSessionMessage(message), message.kind === "reply" ? message.replyDelivery : undefined);
    message.transport = "accepted";
  } catch {
    message.transport = "unknown";
    failure = "delivery outcome unknown; inspect the target before issuing a new request";
  }
  // A receiver can clear a queued submission before the sender resumes this
  // await. Preserve that observation while finalizing the transport receipt.
  const unknownReceipt = (error: string) => ({
    messageId: id,
    target: message.recipient,
    transport: "unknown" as const,
    accepted: false,
    responseRequired: message.responseRequired,
    ...deliveryReceiptFields(message),
    error,
    note: "accepted means transport accepted, not work accepted or completed",
  });
  let observed: SessionMessage;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return unknownReceipt("transport receipt malformed; inspect the target before issuing a new request");
    }
    const candidate = parsed as SessionMessage;
    const sender = candidate.sender;
    const senderMatches = Boolean(sender && typeof sender === "object"
      && sender.deviceId === message.sender.deviceId
      && sender.deviceName === message.sender.deviceName
      && sender.sessionId === message.sender.sessionId
      && sender.sessionFile === message.sender.sessionFile
      && sender.title === message.sender.title
      && sender.project === message.sender.project);
    if (candidate.version !== 1 || candidate.id !== id || !senderMatches || !sameIdentity(candidate)
        || !["pending", "accepted", "unknown"].includes(candidate.transport)) {
      return unknownReceipt("transport receipt identity invalid; inspect the target before issuing a new request");
    }
    observed = candidate;
  } catch {
    // Do not overwrite a corrupted receipt: the raw bytes are evidence and
    // the caller must inspect the target before any retry.
    return unknownReceipt("transport receipt unreadable; inspect the target before issuing a new request");
  }
  if (observed.receiverStatus) {
    message.receiverStatus = observed.receiverStatus;
    message.receiverNote = observed.receiverNote;
  }
  writeMessageState(path, message);
  if (replyPath) writeMessageState(replyPath, message);
  return {
    messageId: id,
    target: message.recipient,
    transport: message.transport,
    accepted: message.transport === "accepted",
    ...(message.operation ? { operation: message.operation } : {}),
    responseRequired: message.responseRequired,
    ...deliveryReceiptFields(message),
    ...(message.receiverStatus ? { receiverStatus: message.receiverStatus, receiverNote: message.receiverNote } : {}),
    ...(failure ? { error: failure } : {}),
    note: "accepted means transport accepted, not work accepted or completed",
  };
}
