/** Shared wire contract. This module has no server/runtime dependencies. */
export type SessionMutationAction = "rename" | "archive" | "unarchive" | "delete";
export type SessionMutationCommand = {
  operationId: string;
  deviceId: string;
  sessionId: string;
  op: SessionMutationAction;
  name?: string;
  force: boolean;
};
export type SessionMutationReceipt = {
  operationId: string;
  deviceId: string;
  sessionId: string;
  status: "not_found" | "accepted" | "running" | "completed" | "failed" | "unknown" | "conflict";
  httpStatus?: number;
  error?: string;
};

export function validateSessionMutationCommand(value: unknown): SessionMutationCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid mutation command");
  const command = value as Record<string, unknown>;
  const bounded = (key: string, max: number) => {
    const text = command[key];
    if (typeof text !== "string" || !text.trim() || text.length > max || /[\0\r\n]/.test(text)) throw new Error(`Invalid ${key}`);
    return text;
  };
  const operationId = bounded("operationId", 200);
  if (operationId.length < 8) throw new Error("Invalid operationId");
  const deviceId = bounded("deviceId", 200);
  const sessionId = bounded("sessionId", 200);
  if (!["rename", "archive", "unarchive", "delete"].includes(String(command.op))) throw new Error("Invalid mutation action");
  if (typeof command.force !== "boolean") throw new Error("Invalid force");
  if (command.op === "rename" && (typeof command.name !== "string" || command.name.length > 2000)) throw new Error("Invalid name");
  if (command.op !== "rename" && command.name !== undefined) throw new Error("Unexpected name");
  return { operationId, deviceId, sessionId, op: command.op as SessionMutationAction,
    ...(command.op === "rename" ? { name: command.name as string } : {}), force: command.force };
}

export function unknownSessionMutation(command: Pick<SessionMutationCommand, "operationId" | "deviceId" | "sessionId">, error?: string): SessionMutationReceipt {
  return { operationId: command.operationId, deviceId: command.deviceId, sessionId: command.sessionId, status: "unknown", ...(error ? { error } : {}) };
}

export function isSessionMutationReceipt(value: unknown, command: SessionMutationCommand): value is SessionMutationReceipt {
  if (!value || typeof value !== "object") return false;
  const result = value as SessionMutationReceipt;
  return result.operationId === command.operationId && result.deviceId === command.deviceId && result.sessionId === command.sessionId
    && ["not_found", "accepted", "running", "completed", "failed", "unknown", "conflict"].includes(result.status);
}

export function sessionMutationRequest(command: SessionMutationCommand, origin: string): Request {
  const isArchive = command.op === "archive" || command.op === "unarchive";
  const url = new URL(`/api/sessions/${encodeURIComponent(command.sessionId)}${isArchive ? "/archive" : ""}`, origin);
  if (command.force) url.searchParams.set("force", "1");
  const body = command.op === "rename" ? { name: command.name } : isArchive ? { archived: command.op === "archive" } : undefined;
  return new Request(url, { method: command.op === "delete" ? "DELETE" : command.op === "rename" ? "PATCH" : "POST",
    headers: { host: url.host, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
}
