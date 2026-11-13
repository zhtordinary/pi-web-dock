/**
 * Edit Pi `enabledModels` without inferring a complete catalog from models
 * currently available on this device. Preserve unrelated patterns, order and
 * thinking pins; use negated literals for safe edits from an unbounded scope
 * and refuse edits that require narrowing an unknown positive pattern.
 * Matching is delegated to the SDK via `enabled-models-runtime.ts`.
 */

/** How one configured pattern resolves against the available models. */
export interface PatternResolution {
  /** The pattern exactly as stored in settings. */
  pattern: string;
  /** `provider/modelId` references the pattern matches, in resolver order. */
  matched: string[];
  /** Thinking level pinned by a `:level` suffix, when the pattern carries one. */
  pin?: string;
  /** The SDK could not resolve the pattern, so its meaning is unknown. */
  unverified?: boolean;
}

export interface EnabledModelsInput {
  /** `enabledModels` as stored; `undefined` means every model is enabled. */
  patterns: string[] | undefined;
  /** Every available `provider/modelId`, grouped by provider in display order. */
  availableRefs: readonly string[];
  /** Resolution of each entry of `patterns`, index-aligned. */
  resolutions: readonly PatternResolution[];
}

export interface EnabledModelsState {
  /** True when no pattern narrows the list, so the selector shows everything. */
  allEnabled: boolean;
  /** Enabled references, restricted to what is available right now. */
  enabled: string[];
  /** `provider/modelId` → thinking level pinned by a `:level` pattern. */
  pins: Record<string, string>;
  /**
   * Patterns that match no available model, so nothing here can tell what they
   * were for — a provider without a usable credential, a renamed or deleted
   * model, a typo, another machine's config. Preserved by every edit.
   */
  stalePatterns: string[];
}

export interface EnabledModelsModelView {
  id: string;
  name: string;
  /** `provider/modelId`, the reference used by every edit. */
  ref: string;
  enabled: boolean;
  /** Thinking level pinned by a `:level` pattern; read-only in pi-web. */
  thinkingPin?: string;
  contextWindow?: number;
}

export interface EnabledModelsProviderView {
  id: string;
  name: string;
  /**
   * `builtin` covers pi's own providers and any provider an extension
   * registered; both own their model lists, so individual models can only be
   * hidden through `enabledModels`. `custom` providers come from models.json,
   * where a model can simply be deleted, so they are switched as a whole.
   */
  kind: "builtin" | "custom";
  enabledCount: number;
  models: EnabledModelsModelView[];
}

/** Payload of `GET`/`PUT /api/models/enabled`, shared with the browser. */
export interface EnabledModelsView {
  /** True when nothing narrows the model list. */
  allEnabled: boolean;
  patterns: string[] | null;
  /** Configured patterns that match no available model; every edit keeps them. */
  stalePatterns: string[];
  enabledTotal: number;
  availableTotal: number;
  providers: EnabledModelsProviderView[];
  /** Which settings file the effective value comes from. */
  scope: "global" | "project";
  /** That file's path, shortened for display, e.g. `~/.pi/agent/settings.json`. */
  settingsPath: string;
  /** False when project settings shadow the global value pi-web can write. */
  editable: boolean;
  modelError?: string;
}

export type EnabledModelsEdit =
  | { ok: true; patterns: string[] | undefined; changed: boolean }
  | { ok: false; reason: "last-model" | "unverified-models" | "unsafe-scope" | "unrestricted-scope" };

/** Provider id of a `provider/modelId` reference (model ids may contain `/`). */
export function modelRefProvider(ref: string): string {
  const slash = ref.indexOf("/");
  return slash < 0 ? ref : ref.slice(0, slash);
}

/** Working copy of one configured pattern. */
interface Entry {
  pattern: string;
  matched: string[];
  pin?: string;
  unverified?: boolean;
}

function toEntries(resolutions: readonly PatternResolution[]): Entry[] {
  return resolutions.map((resolution) => ({
    pattern: resolution.pattern,
    matched: [...resolution.matched],
    ...(resolution.pin ? { pin: resolution.pin } : {}),
    ...(resolution.unverified ? { unverified: true } : {}),
  }));
}

function enabledRefs(entries: readonly Entry[]): string[] {
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const entry of entries) {
    for (const ref of entry.matched) {
      if (seen.has(ref)) continue;
      seen.add(ref);
      refs.push(ref);
    }
  }
  return refs;
}

function formatEntry(ref: string, pin?: string): string {
  return pin ? `${ref}:${pin}` : ref;
}

/** Escape a literal reference for minimatch's negated pattern syntax. */
function escapePatternLiteral(ref: string): string {
  return ref.replace(/[\\*?\[\]{}!,()@+]/g, "\\$&");
}

function splitPatternAlternatives(body: string): string[] | null {
  const parts: string[] = [];
  let part = "";
  let escaped = false;
  for (const character of body) {
    if (character === "," && !escaped) {
      parts.push(part);
      part = "";
      continue;
    }
    part += character;
    if (character === "\\" && !escaped) escaped = true;
    else escaped = false;
  }
  parts.push(part);
  return parts;
}

interface PatternLiteral {
  value: string;
  bare: boolean;
}

function parsePatternLiteral(part: string): PatternLiteral | null {
  if (part.startsWith("@(") && part.endsWith(")")) {
    const value = part.slice(2, -1).replace(/\\([\\*?\[\]{}!,()@+])/g, "$1");
    return `@(${escapePatternLiteral(value)})` === part ? { value, bare: true } : null;
  }
  const close = part.indexOf("]");
  if (part.startsWith("[") && close > 1) {
    const first = part.slice(1, close).replace(/\\([\\*?\[\]{}!,()@+])/g, "$1");
    const rest = part.slice(close + 1).replace(/\\([\\*?\[\]{}!,()@+])/g, "$1");
    const value = first + rest;
    return formatPatternLiteral(value) === part ? { value, bare: false } : null;
  }
  const value = part.replace(/\\([\\*?\[\]{}!,()@+])/g, "$1");
  return escapePatternLiteral(value) === part ? { value, bare: false } : null;
}

/** Parse only the literal negative patterns emitted by this editor. */
function parseLiteralExclusionPattern(pattern: string): string[] | null {
  if (!pattern.startsWith("!")) return null;
  const body = pattern.slice(1);
  const parts = body.startsWith("{") && body.endsWith("}")
    ? splitPatternAlternatives(body.slice(1, -1))
    : [body];
  if (!parts || parts.some((part) => !part)) return null;
  const literals = parts.map(parsePatternLiteral);
  if (literals.some((literal) => literal === null)) return null;
  const values = literals as PatternLiteral[];
  const bare = new Set(values.filter((literal) => literal.bare).map((literal) => literal.value));
  const refs = values.filter((literal) => !literal.bare).map((literal) => literal.value);
  if (bare.size > 0) {
    const paired = refs.filter((ref) => bare.has(ref.slice(ref.indexOf("/") + 1)));
    return paired.length === refs.length ? paired : null;
  }
  return refs;
}

function formatPatternLiteral(ref: string): string {
  const first = escapePatternLiteral(ref.slice(0, 1));
  return `[${first}]${escapePatternLiteral(ref.slice(1))}`;
}

function formatExclusionPattern(refs: readonly string[]): string {
  const literals = refs.flatMap((ref) => [
    formatPatternLiteral(ref),
    `@(${escapePatternLiteral(ref.slice(ref.indexOf("/") + 1))})`,
  ]);
  return `!{${literals.join(",")}}`;
}

interface GeneratedExclusion {
  index: number;
  refs: string[];
}

/** Find an exclusion pattern whose complement is exactly this device's catalog. */
function findGeneratedExclusion(
  entries: readonly Entry[],
  availableRefs: readonly string[],
): GeneratedExclusion | null {
  const available = new Set(availableRefs);
  for (let index = 0; index < entries.length; index += 1) {
    const refs = parseLiteralExclusionPattern(entries[index].pattern);
    if (!refs || refs.some((ref) => !available.has(ref))) continue;
    const excluded = new Set(refs);
    const expected = availableRefs.filter((ref) => !excluded.has(ref));
    const matched = entries[index].matched;
    if (matched.length !== expected.length || matched.some((ref, offset) => ref !== expected[offset])) continue;
    return { index, refs };
  }
  return null;
}

function providerOrder(availableRefs: readonly string[]): string[] {
  const providers: string[] = [];
  for (const ref of availableRefs) {
    const provider = modelRefProvider(ref);
    if (!providers.includes(provider)) providers.push(provider);
  }
  return providers;
}

function isExactEntry(entry: Entry, ref: string): boolean {
  return entry.matched.length === 1 && entry.matched[0] === ref
    && entry.pattern.toLowerCase() === formatEntry(ref, entry.pin).toLowerCase();
}

/** Current selection derived from the configured patterns. */
export function computeEnabledModelsState(input: EnabledModelsInput): EnabledModelsState {
  const entries = toEntries(input.resolutions);
  const enabled = enabledRefs(entries);
  const pins: Record<string, string> = {};
  const seen = new Set<string>();
  for (const entry of entries) {
    // The resolver keeps the first occurrence, even when it has no pin.
    for (const ref of entry.matched) {
      if (seen.has(ref)) continue;
      seen.add(ref);
      if (entry.pin) pins[ref] = entry.pin;
    }
  }
  // pi falls back to every available model when the patterns resolve to
  // nothing, so a fully stale list reads as "all enabled" here too.
  const allEnabled = enabled.length === 0;
  return {
    allEnabled,
    enabled: allEnabled ? [...input.availableRefs] : enabled,
    pins,
    stalePatterns: entries.filter((entry) => entry.matched.length === 0).map((entry) => entry.pattern),
  };
}

/** Edit explicit references without rewriting the remaining model scope. */
export function setModelsEnabled(
  input: EnabledModelsInput,
  refs: readonly string[],
  enabled: boolean,
): EnabledModelsEdit {
  const available = new Set(input.availableRefs);
  const targets = [...new Set(refs.filter((ref) => available.has(ref)))];
  const entries = toEntries(input.resolutions);
  const resolved = enabledRefs(entries);
  const current = new Set(resolved.length > 0 ? resolved : input.availableRefs);
  const changedRefs = targets.filter((ref) => current.has(ref) !== enabled);
  if (changedRefs.length === 0) return { ok: true, patterns: input.patterns, changed: false };
  if (entries.some((entry) => entry.unverified)) return { ok: false, reason: "unsafe-scope" };

  const generated = findGeneratedExclusion(entries, input.availableRefs);
  if (enabled) {
    if (!generated) {
      return { ok: true, patterns: [...(input.patterns ?? []), ...changedRefs], changed: true };
    }
    const remaining = generated.refs.filter((ref) => !changedRefs.includes(ref));
    const patterns = input.patterns!.filter((_, index) => index !== generated.index);
    if (remaining.length > 0) patterns.splice(Math.min(generated.index, patterns.length), 0, formatExclusionPattern(remaining));
    return { ok: true, patterns: patterns.length > 0 ? patterns : undefined, changed: true };
  }

  const removed = new Set(changedRefs);
  if (![...current].some((ref) => !removed.has(ref))) return { ok: false, reason: "last-model" };

  if (input.patterns === undefined) {
    // A negated pattern preserves every model not explicitly hidden, including
    // models that are absent from this device's current catalog.
    return { ok: true, patterns: [formatExclusionPattern(changedRefs)], changed: true };
  }

  if (generated) {
    const oldExcluded = new Set(generated.refs);
    for (const [index, entry] of entries.entries()) {
      if (index === generated.index) continue;
      const affected = entry.matched.find((ref) => removed.has(ref));
      if (affected && (!isExactEntry(entry, affected) || !oldExcluded.has(affected))) {
        return { ok: false, reason: "unsafe-scope" };
      }
    }
    const excluded = input.availableRefs.filter((ref) => !current.has(ref) || removed.has(ref));
    const patterns = entries.flatMap((entry, index) => {
      if (index === generated.index) return [];
      const first = entry.matched[0] ?? "";
      return removed.has(first) && oldExcluded.has(first) && isExactEntry(entry, first) ? [] : [entry.pattern];
    });
    if (excluded.length > 0) patterns.splice(Math.min(generated.index, patterns.length), 0, formatExclusionPattern(excluded));
    return { ok: true, patterns: patterns.length > 0 ? patterns : undefined, changed: true };
  }

  if (resolved.length === 0) return { ok: false, reason: "unsafe-scope" };
  for (const entry of entries) {
    const affected = entry.matched.find((ref) => removed.has(ref));
    if (affected && !isExactEntry(entry, affected)) return { ok: false, reason: "unsafe-scope" };
  }
  return {
    ok: true,
    patterns: entries.filter((entry) => !entry.matched.some((ref) => removed.has(ref))).map((entry) => entry.pattern),
    changed: true,
  };
}

export interface ProviderRename {
  from: string;
  to: string;
}

/** Recognized thinking suffixes carried over during a rename. */
const THINKING_LEVEL_SUFFIXES = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * Point renamed models' entries at their new reference.
 *
 * A model renamed in the panel is a known fact, not the kind of mismatch worth
 * preserving: leaving `stepfun/ddd` behind after it became `stepfun/ddd1` loses
 * the selection, and when it was the only entry the whole scope resolves to
 * nothing — which pi reads as "no scope", silently enabling every model.
 *
 * Applied before the provider rewrite, so `from` is the reference as the
 * settings file still spells it and `to` is where it ends up.
 */
export function renameModelPatterns(
  patterns: string[] | undefined,
  renames: readonly ProviderRename[],
): string[] | undefined {
  if (!patterns) return patterns;
  const applicable = renames.filter((rename) => rename.from && rename.to && rename.from !== rename.to);
  if (applicable.length === 0) return patterns;
  return patterns.map((pattern) => {
    const exclusions = parseLiteralExclusionPattern(pattern);
    if (exclusions) {
      return formatExclusionPattern(exclusions.map((ref) => {
        for (const { from, to } of applicable) {
          if (ref === from) return to;
          if (ref.startsWith(`${from}:`) && THINKING_LEVEL_SUFFIXES.has(ref.slice(from.length + 1))) {
            return `${to}:${ref.slice(from.length + 1)}`;
          }
        }
        return ref;
      }));
    }
    for (const { from, to } of applicable) {
      if (pattern === from) return to;
      // Model ids may contain colons, so only a known level is a pin suffix.
      if (!pattern.startsWith(`${from}:`)) continue;
      const suffix = pattern.slice(from.length + 1);
      if (THINKING_LEVEL_SUFFIXES.has(suffix)) return `${to}:${suffix}`;
    }
    return pattern;
  });
}

/**
 * Point a renamed provider's entries at its new id.
 *
 * A pure prefix rewrite, so a `:thinkingLevel` suffix and entry order survive.
 * The caller validates the old and new references before storing the result.
 */
/** Remove provider-qualified scope entries after that provider is disconnected. */
export function removeProviderPatterns(
  patterns: string[] | undefined,
  provider: string,
): string[] | undefined {
  if (!patterns) return patterns;
  const prefix = `${provider}/`;
  let changed = false;
  const remaining: string[] = [];
  for (const pattern of patterns) {
    const exclusions = parseLiteralExclusionPattern(pattern);
    if (exclusions) {
      const kept = exclusions.filter((ref) => !ref.startsWith(prefix));
      if (kept.length !== exclusions.length) changed = true;
      if (kept.length > 0) remaining.push(kept.length === exclusions.length ? pattern : formatExclusionPattern(kept));
      continue;
    }
    const candidate = pattern.startsWith("!") ? pattern.slice(1) : pattern;
    if (candidate.startsWith(prefix)) changed = true;
    else remaining.push(pattern);
  }
  if (!changed) return patterns;
  return remaining.length > 0 ? remaining : undefined;
}

export function renameProviderPatterns(
  patterns: string[] | undefined,
  renames: readonly ProviderRename[],
): string[] | undefined {
  if (!patterns) return patterns;
  const applicable = renames.filter((rename) => rename.from && rename.to && rename.from !== rename.to);
  if (applicable.length === 0) return patterns;
  return patterns.map((pattern) => {
    const exclusions = parseLiteralExclusionPattern(pattern);
    if (exclusions) {
      return formatExclusionPattern(exclusions.map((ref) => {
        const rename = applicable.find((candidate) => ref.startsWith(`${candidate.from}/`));
        return rename ? `${rename.to}${ref.slice(rename.from.length)}` : ref;
      }));
    }
    const rename = applicable.find((candidate) => pattern.startsWith(`${candidate.from}/`));
    return rename ? `${rename.to}${pattern.slice(rename.from.length)}` : pattern;
  });
}

/** Renames may rewrite only references resolved exactly on both sides. */
export function validateEnabledModelsRename(before: EnabledModelsInput, after: EnabledModelsInput): EnabledModelsEdit {
  const original = before.patterns;
  const renamed = after.patterns;
  if (original === undefined || renamed === undefined || original.length !== renamed.length) {
    return original === renamed
      ? { ok: true, patterns: original, changed: false }
      : { ok: false, reason: "unsafe-scope" };
  }
  const oldEntries = toEntries(before.resolutions);
  const newEntries = toEntries(after.resolutions);
  const oldGenerated = findGeneratedExclusion(oldEntries, before.availableRefs);
  const newGenerated = findGeneratedExclusion(newEntries, after.availableRefs);
  let changed = false;
  for (let index = 0; index < original.length; index += 1) {
    if (original[index] === renamed[index]) continue;
    changed = true;
    if (oldGenerated?.index === index && newGenerated?.index === index
      && oldGenerated.refs.length === newGenerated.refs.length) continue;
    const oldEntry = oldEntries[index], newEntry = newEntries[index];
    const oldRef = oldEntry?.matched[0], newRef = newEntry?.matched[0];
    if (!oldRef || !newRef || oldEntry.unverified || newEntry.unverified
      || !isExactEntry(oldEntry, oldRef) || !isExactEntry(newEntry, newRef)) {
      return { ok: false, reason: "unsafe-scope" };
    }
  }
  return { ok: true, patterns: changed ? renamed : original, changed };
}

/** Refuse to narrow a cross-provider pattern from an incomplete catalog. */
export function validateProviderEntries(input: EnabledModelsInput): EnabledModelsEdit {
  const providers = new Set(providerOrder(input.availableRefs));
  for (const entry of toEntries(input.resolutions)) {
    const slash = entry.pattern.indexOf("/");
    const prefix = slash > 0 ? entry.pattern.slice(0, slash) : "";
    const inside = providers.has(prefix)
      ? entry.matched.filter((ref) => modelRefProvider(ref) === prefix)
      : [];
    if (inside.length > 0 && inside.length !== entry.matched.length) {
      return { ok: false, reason: "unsafe-scope" };
    }
  }
  return { ok: true, patterns: input.patterns, changed: false };
}

/** Unmatched entries may belong to a signed-out provider or another device. */
export function pruneStaleEnabledModels(input: EnabledModelsInput): EnabledModelsEdit {
  if (input.resolutions.some((entry) => entry.matched.length === 0)) {
    return { ok: false, reason: "unverified-models" };
  }
  return { ok: true, patterns: input.patterns, changed: false };
}

/** An explicit clear restores Pi's unrestricted scope. */
export function clearEnabledModels(input: EnabledModelsInput): EnabledModelsEdit {
  return { ok: true, patterns: undefined, changed: input.patterns !== undefined };
}
