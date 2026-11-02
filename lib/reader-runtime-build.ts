/** Build constants are embedded by Next; never reread a mutable release selector. */
export const READER_RUNTIME_BUILD = Object.freeze({
  buildId: process.env.NEXT_PUBLIC_READER_BUILD_ID ?? null,
  readerCommit: process.env.NEXT_PUBLIC_READER_COMMIT ?? null,
});

export type ReaderRuntimeChannel = "production" | "preview";

/** The trusted launcher binding, independent of the browser or proxy port. */
export function getReaderRuntimeChannel(): ReaderRuntimeChannel | undefined {
  const port = process.env.PI_WEB_BOUND_PORT?.trim();
  if (port === "30141") return "production";
  if (port === "30142") return "preview";
  return undefined;
}
