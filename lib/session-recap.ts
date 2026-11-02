// Reader's only reader of the independent session-recap-title package's
// persisted results. The package owns generation, triggering and its own text
// layout; Reader reads the structured fields and renders the task flow itself.

type RecordValue = Record<string, unknown>;

const RECAP_ENTRY_PREFIX = "session-recap-title:";
const RECAP_RESULT_ENTRY = `${RECAP_ENTRY_PREFIX}result`;
// Status glyphs match the todo preview; blocked tasks are marked with ✗.
const TASK_STATUS_MARKERS = { active: " ◐", completed: " ✓", paused: " ○", blocked: " ✗" } as const;

export type SessionRecapTaskStatus = keyof typeof TASK_STATUS_MARKERS;

export interface SessionRecapTask {
  title: string;
  status: SessionRecapTaskStatus;
}

export interface SessionRecapSummary {
  /** Stored text, shown as-is only when the result has no title and task flow. */
  recap: string;
  title?: string;
  tasks?: SessionRecapTask[];
  completedAt?: number;
}

export interface SessionRecapDisplay {
  title?: string;
  /** Rendered task-flow lines; empty when the stored text is shown instead. */
  taskFlow: string[];
  body: string;
}

function asRecord(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" ? value as RecordValue : undefined;
}

function readTask(value: unknown): SessionRecapTask | undefined {
  const task = asRecord(value);
  const title = typeof task?.title === "string" ? task.title.replace(/\s+/g, " ").trim() : "";
  if (!title) return undefined;
  const status = task?.status;
  return { title, status: status === "completed" || status === "paused" || status === "blocked" ? status : "active" };
}

/** Empty results only advance the package's coverage point and are not recaps. */
export function readSessionRecap(entry: unknown): SessionRecapSummary | undefined {
  const record = asRecord(entry);
  if (record?.type !== "custom" || record.customType !== RECAP_RESULT_ENTRY) return undefined;
  const data = asRecord(record.data);
  const recap = typeof data?.recap === "string" ? data.recap.trim() : "";
  if (!recap) return undefined;
  const title = typeof data?.title === "string" ? data.title.trim() : "";
  const rawTasks = data?.tasks;
  const tasks = Array.isArray(rawTasks)
    ? rawTasks.map(readTask).filter((task): task is SessionRecapTask => Boolean(task))
    : [];
  const completedAt = data?.completedAt;
  return {
    recap,
    ...(title ? { title } : {}),
    ...(tasks.length ? { tasks } : {}),
    ...(typeof completedAt === "number" && Number.isFinite(completedAt) ? { completedAt } : {}),
  };
}

/** Recap, title and repair calls recorded by the package count as Recap usage. */
export function isSessionRecapUsageEntry(entry: unknown): boolean {
  const record = asRecord(entry);
  if (record?.type !== "custom") return false;
  return (typeof record.customType === "string" && record.customType.startsWith(RECAP_ENTRY_PREFIX))
    || asRecord(record.data)?.kind === "recap";
}

export function sessionRecapDisplay(recap: SessionRecapSummary | undefined): SessionRecapDisplay {
  const title = recap?.title;
  const tasks = title ? recap?.tasks ?? [] : [];
  if (!title || tasks.length === 0) return { taskFlow: [], body: recap?.recap ?? "" };
  const taskFlow = tasks.map((task, index) =>
    `${index === tasks.length - 1 ? "└─" : "├─"} ${index + 1}.${task.title}${TASK_STATUS_MARKERS[task.status] ?? TASK_STATUS_MARKERS.active}`);
  return { title, taskFlow, body: taskFlow.join("\n") };
}
