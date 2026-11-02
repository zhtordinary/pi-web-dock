export interface SessionExecutionState {
  parentActive: boolean;
  retrying: boolean;
  unattended: boolean;
  backgroundRunIds: string[];
  queuedCount: number;
  active: boolean;
}

export function sessionExecutionState(signals: Omit<SessionExecutionState, "active">): SessionExecutionState {
  return { ...signals, active: signals.parentActive || signals.retrying || signals.backgroundRunIds.length > 0 };
}

/** Stop acknowledgements are not termination proof. Keep unresolved work visible. */
export async function stopSessionExecution(operations: {
  snapshot(): SessionExecutionState;
  stopParent(): Promise<void>;
  stopBackground(runId: string): Promise<void>;
}, timeoutMs = 8_000) {
  const errors: string[] = [];
  try { await operations.stopParent(); }
  catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  const runs = operations.snapshot().backgroundRunIds;
  const results = await Promise.allSettled(runs.map(id => operations.stopBackground(id)));
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") errors.push(`${runs[index]}: ${String(result.reason)}`);
  }
  const deadline = Date.now() + timeoutMs;
  let state = operations.snapshot();
  while (state.active && errors.length === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
    state = operations.snapshot();
  }
  return { stopped: !state.active && errors.length === 0, state, errors };
}
