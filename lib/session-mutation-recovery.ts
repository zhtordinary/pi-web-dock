import type { SessionMutationCommand, SessionMutationReceipt } from "./session-mutation-command";

export const SESSION_MUTATION_PROTOCOL = 2;
export type SessionMutationRecoveryEntry = {
  receipt: SessionMutationReceipt;
  command?: SessionMutationCommand;
  updatedAt: string;
};
export type SessionMutationRecoveryPage = { operations: SessionMutationRecoveryEntry[]; nextCursor?: string };
export type SessionMutationIdentity = Pick<SessionMutationCommand, "operationId" | "deviceId" | "sessionId">;
