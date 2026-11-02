import type { PackageSource } from "@earendil-works/pi-coding-agent";

const RESOURCE_KEYS = ["extensions", "skills", "prompts", "themes"] as const;
const DISABLED_SENTINEL = "!**";
const DISABLED_MISSING_MARKER = "!__pi_web_package_disabled_missing__";
const DISABLED_PRESENT_MARKER = "!__pi_web_package_disabled_present__";
type PackageEntry = Exclude<PackageSource, string>;

export function packageSource(entry: PackageSource): string {
  return typeof entry === "string" ? entry : entry.source;
}

function getDisabledMarker(patterns: unknown): { index: number; marker: string } | undefined {
  if (!Array.isArray(patterns)) return undefined;
  const markerIndex = Math.max(
    patterns.lastIndexOf(DISABLED_MISSING_MARKER),
    patterns.lastIndexOf(DISABLED_PRESENT_MARKER),
  );
  if (markerIndex > 0 && patterns[markerIndex - 1] === DISABLED_SENTINEL) {
    return { index: markerIndex, marker: patterns[markerIndex] };
  }
  return undefined;
}

function hasDisabledSentinel(entry: PackageEntry): boolean {
  return RESOURCE_KEYS.every((key) => getDisabledMarker(entry[key]) !== undefined);
}

function isLegacyDisabledPackage(entry: PackageEntry): boolean {
  return RESOURCE_KEYS.every((key) => {
    const patterns = entry[key];
    return Array.isArray(patterns) && patterns.length === 0;
  });
}

export function isDisabledPackage(entry: PackageSource): boolean {
  return typeof entry !== "string"
    && (isLegacyDisabledPackage(entry) || hasDisabledSentinel(entry));
}

function withoutDisabledSentinel(entry: PackageEntry): PackageSource {
  const next: PackageEntry = { ...entry };
  for (const key of RESOURCE_KEYS) {
    const patterns = next[key];
    const marker = getDisabledMarker(patterns);
    if (!Array.isArray(patterns) || !marker) continue;
    const original = patterns.slice(0, marker.index - 1);
    // Only the exact force-exclusion prefix derived from the saved original
    // belongs to Reader. CLI/user rules appended after it are not generated
    // state and must survive enabling the parent again.
    const generated = original.filter((pattern) => pattern.startsWith("+"))
      .map((pattern) => `-${pattern.slice(1)}`);
    let suffix = marker.index + 1;
    for (const pattern of generated) {
      if (patterns[suffix] !== pattern) break;
      suffix++;
    }
    const restored = [...original, ...patterns.slice(suffix)];
    if (marker.marker === DISABLED_MISSING_MARKER && restored.length === 0) delete next[key];
    else next[key] = restored;
  }
  const hasResourceFields = RESOURCE_KEYS.some((key) => Object.prototype.hasOwnProperty.call(next, key));
  return hasResourceFields || next.autoload !== undefined ? next : next.source;
}

/**
 * Disable a package without throwing away its resource filters. The SDK has
 * no package-level disabled flag, so append a `!**` exclusion to every
 * resource list. Existing force-includes remain in place but are paired with
 * force-excludes after an internal marker, so the original arrays can be
 * restored exactly on enable. It uses only supported PackageSource pattern
 * syntax and does not add unknown fields to settings or resolution.
 */
export function setPackageEntryDisabled(
  entry: PackageSource,
  disabled: boolean,
): PackageSource {
  if (!disabled) {
    if (typeof entry === "string") return entry;
    if (hasDisabledSentinel(entry)) return withoutDisabledSentinel(entry);
    // Legacy disabled entries have no recoverable filter snapshot. Return the
    // plain source so `autoload: false` cannot keep the package disabled.
    if (isLegacyDisabledPackage(entry)) return entry.source;
    return entry;
  }

  if (typeof entry === "string") {
    return {
      source: entry,
      extensions: [DISABLED_SENTINEL, DISABLED_MISSING_MARKER],
      skills: [DISABLED_SENTINEL, DISABLED_MISSING_MARKER],
      prompts: [DISABLED_SENTINEL, DISABLED_MISSING_MARKER],
      themes: [DISABLED_SENTINEL, DISABLED_MISSING_MARKER],
    };
  }
  // Re-project a marked disabled entry: a later CLI force-include must not
  // bypass the parent cap. This produces a fresh value, never mutates settings.
  if (hasDisabledSentinel(entry)) return setPackageEntryDisabled(withoutDisabledSentinel(entry), true);
  if (isLegacyDisabledPackage(entry)) return entry;
  const next: PackageEntry = { ...entry };
  for (const key of RESOURCE_KEYS) {
    const hasField = Object.prototype.hasOwnProperty.call(entry, key);
    const patterns = Array.isArray(entry[key]) ? [...entry[key]] : [];
    const forceExcludes = patterns
      .filter((pattern) => pattern.startsWith("+"))
      .map((pattern) => `-${pattern.slice(1)}`);
    patterns.push(DISABLED_SENTINEL, hasField ? DISABLED_PRESENT_MARKER : DISABLED_MISSING_MARKER, ...forceExcludes);
    next[key] = patterns;
  }
  return next;
}

/** Read-only native-pattern projection; persisted user/CLI arrays stay intact. */
export function applyPackageParentCaps(packages: readonly PackageSource[]): PackageSource[] {
  return packages.map((entry) => isDisabledPackage(entry) ? setPackageEntryDisabled(entry, true) : entry);
}
