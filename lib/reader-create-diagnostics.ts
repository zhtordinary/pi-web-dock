export const READER_CREATE_FAILURE_STAGES = [
  "request_revalidation",
  "runtime_start",
  "binding_persistence",
  "runtime_setup",
  "runtime_state_read",
  "initial_command",
  "control",
] as const;

export type ReaderCreateFailureStage = (typeof READER_CREATE_FAILURE_STAGES)[number];

export const READER_CREATE_FAILURE_CATEGORIES = [
  "resource_missing",
  "permission_denied",
  "resource_busy",
  "timeout",
  "module_resolution",
  "invalid_argument",
  "invalid_state",
  "aborted",
  "unclassified",
] as const;

export type ReaderCreateFailureCategory = (typeof READER_CREATE_FAILURE_CATEGORIES)[number];

export type ReaderCreateFailureDiagnostic = {
  correlationId: string;
  stage: ReaderCreateFailureStage;
  category: ReaderCreateFailureCategory;
};

const CATEGORY_BY_ERROR_CODE: Readonly<Record<string, ReaderCreateFailureCategory>> = {
  ENOENT: "resource_missing",
  ENOTDIR: "resource_missing",
  EACCES: "permission_denied",
  EPERM: "permission_denied",
  ERR_ACCESS_DENIED: "permission_denied",
  EBUSY: "resource_busy",
  EADDRINUSE: "resource_busy",
  ETIMEDOUT: "timeout",
  ERR_MODULE_NOT_FOUND: "module_resolution",
  MODULE_NOT_FOUND: "module_resolution",
  ERR_REQUIRE_ESM: "module_resolution",
  ERR_INVALID_ARG_TYPE: "invalid_argument",
  ERR_INVALID_ARG_VALUE: "invalid_argument",
  ERR_INVALID_STATE: "invalid_state",
  ABORT_ERR: "aborted",
};

const STAGE_BY_FAILURE_CODE: Readonly<Record<string, ReaderCreateFailureStage>> = {
  create_request_revalidation_failed: "request_revalidation",
  create_runtime_start_failed: "runtime_start",
  create_binding_persistence_failed: "binding_persistence",
  create_runtime_setup_failed: "runtime_setup",
  create_runtime_state_failed: "runtime_state_read",
  create_initial_command_failed: "initial_command",
};

function categoryForError(error: unknown): ReaderCreateFailureCategory {
  if (!error || typeof error !== "object") return "unclassified";
  let code: unknown;
  try {
    code = (error as { code?: unknown }).code;
  } catch {
    return "unclassified";
  }
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(CATEGORY_BY_ERROR_CODE, code)
    ? CATEGORY_BY_ERROR_CODE[code]
    : "unclassified";
}

export function readerCreateFailureStageForCode(code: string): ReaderCreateFailureStage | undefined {
  return Object.prototype.hasOwnProperty.call(STAGE_BY_FAILURE_CODE, code)
    ? STAGE_BY_FAILURE_CODE[code]
    : undefined;
}

export function readerCreateFailureDiagnostic(
  correlationId: string,
  stage: ReaderCreateFailureStage,
  error: unknown,
): ReaderCreateFailureDiagnostic {
  return { correlationId, stage, category: categoryForError(error) };
}

export function isReaderCreateFailureDiagnostic(
  value: unknown,
  correlationId: string,
): value is ReaderCreateFailureDiagnostic {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const diagnostic = value as Record<string, unknown>;
  const keys = Object.keys(diagnostic);
  return keys.length === 3
    && keys.every((key) => ["correlationId", "stage", "category"].includes(key))
    && diagnostic.correlationId === correlationId
    && typeof diagnostic.stage === "string"
    && (READER_CREATE_FAILURE_STAGES as readonly string[]).includes(diagnostic.stage)
    && typeof diagnostic.category === "string"
    && (READER_CREATE_FAILURE_CATEGORIES as readonly string[]).includes(diagnostic.category);
}
