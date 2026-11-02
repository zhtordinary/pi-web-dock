/**
 * Flatten a tool call's input into readable rows for the expanded tool card.
 *
 * A tool card shows its arguments as indented JSON, which is hard to scan for
 * the common case of a handful of scalars. These rows are only used when every
 * value is a scalar; a nested object or array would lose its subtree in a flat
 * table, so the caller falls back to JSON for those. The decision is structural,
 * never by tool name: any tool whose arguments happen to be flat benefits, and
 * a tool that takes nested input keeps its JSON.
 */

export interface ToolField {
  key: string;
  /** Rendered value; `null` and booleans keep their JSON spelling. */
  value: string;
  /** True when the value contains a line break, so the row must not collapse it. */
  multiline: boolean;
}

function isScalar(value: unknown): boolean {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

/**
 * Rows for a flat input object, or null when the input is not an object or has
 * any nested value. An empty object has no rows to show.
 */
export function toolFieldsOfInput(input: unknown): ToolField[] | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) return null;
  const fields: ToolField[] = [];
  for (const [key, raw] of entries) {
    if (!isScalar(raw)) return null;
    const value = raw === null ? "null" : String(raw);
    fields.push({ key, value, multiline: value.includes("\n") });
  }
  return fields;
}
