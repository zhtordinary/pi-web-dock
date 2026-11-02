export function asyncMetadataKey(runId: string, path: readonly string[] = []): string {
  const root = encodeURIComponent(runId.trim());
  return path.length === 0
    ? root
    : `${root}::${path.map((part) => encodeURIComponent(part)).join("/")}`;
}

export function asyncStatusChildId(step: Record<string, unknown>, index: number): string {
  for (const key of ["childId", "workflowKey", "runId"] as const) {
    const value = step[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return `step:${index}`;
}
