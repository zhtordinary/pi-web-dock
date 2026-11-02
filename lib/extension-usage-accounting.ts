import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { DefaultPackageManager, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { BillingUsageInput, ReaderUsageRecord } from "./billing";

export const EXTENSION_USAGE_ENTRY = "pi-extension-usage";

interface LegacyDescriptor {
  id: string;
  directory: string;
  customType: string;
  stats: string[];
}

type Document = Record<string, unknown>;
const isRecord = (value: unknown): value is Document => !!value && typeof value === "object" && !Array.isArray(value);
const validName = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && value !== "." && value !== "..";
const validCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function legacyDescriptor(id: string, legacy: unknown): LegacyDescriptor | undefined {
  if (!validName(id) || !isRecord(legacy) || legacy.layout !== "project-session-v1" || !validName(legacy.directory)
      || !validName(legacy.customType) || !Array.isArray(legacy.stats) || legacy.stats.length === 0 || legacy.stats.length > 4
      || !legacy.stats.every(validName) || new Set(legacy.stats).size !== legacy.stats.length) return undefined;
  return { id, directory: legacy.directory, customType: legacy.customType, stats: legacy.stats as string[] };
}

/** Only configured user packages may declare a bounded data-only legacy locator. */
export function discoverLegacyExtensionUsage(agentDir = getAgentDir()): LegacyDescriptor[] {
  const cwd = process.cwd();
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
  const found = new Map<string, LegacyDescriptor>();
  for (const item of manager.listConfiguredPackages()) {
    if (item.scope !== "user" || !item.installedPath) continue;
    try {
      const file = join(item.installedPath, "package.json");
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let manifest: unknown;
      try {
        const info = fstatSync(fd);
        if (!info.isFile() || info.nlink !== 1 || info.size > 256 * 1024) continue;
        manifest = JSON.parse(readFileSync(fd, "utf8"));
      } finally { closeSync(fd); }
      if (!isRecord(manifest) || !validName(manifest.name) || !isRecord(manifest.piWeb)
          || !isRecord(manifest.piWeb.usageAccounting) || manifest.piWeb.usageAccounting.version !== 1
          || !isRecord(manifest.piWeb.usageAccounting.legacy)) continue;
      const descriptor = legacyDescriptor(manifest.name, manifest.piWeb.usageAccounting.legacy);
      if (descriptor) found.set(manifest.name, descriptor);
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  return [...found.values()];
}

function sessionKey(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

function projectKey(cwd: string): string {
  let canonical: string;
  try { canonical = realpathSync(cwd); } catch { canonical = resolve(cwd); }
  const name = (basename(canonical) || "root").trim().replace(/[^A-Za-z0-9._-]/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "project";
  return `${name}-${createHash("sha256").update(canonical).digest("hex").slice(0, 12)}`;
}

function legacyPath(agent: string, descriptor: LegacyDescriptor, sessionId: string, cwd: string): string | undefined {
  const id = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  if (!id || id === "." || id === ".." || !cwd) return undefined;
  return join(agent, descriptor.directory, "projects", projectKey(cwd), "sessions", id, "usage.json");
}

async function physicalParents(root: string, file: string): Promise<"ok" | "missing" | "unsafe"> {
  const relative = file.slice(root.length + 1).split("/");
  let current = root;
  for (const part of relative.slice(0, -1)) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(current) !== current) return "unsafe";
    } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unsafe"; }
  }
  return "ok";
}

async function readBoundedJson(root: string, file: string): Promise<{ value?: unknown; state: "ok" | "missing" | "invalid" }> {
  const parents = await physicalParents(root, file);
  if (parents !== "ok") return { state: parents === "missing" ? "missing" : "invalid" };
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024) return { state: "invalid" };
      return { state: "ok", value: JSON.parse(await handle.readFile("utf8")) };
    } finally { await handle.close(); }
  } catch (error) { return { state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "invalid" }; }
}

type Totals = { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };
const zeroTotals = (): Totals => ({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
const totalFields = ["calls", "input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
// User-approved API-equivalent attribution for this extension's aggregate-only legacy counters.
const LEGACY_ESTIMATE_MODELS: Record<string, { provider: string; model: string }> = {
  "pi-prompt-suggester": { provider: "CPA GPT", model: "gpt-5.6-luna" },
};

function readTotals(value: unknown): Totals | undefined {
  if (!isRecord(value) || !totalFields.every((field) => validCount(value[field]))) return undefined;
  return { calls: value.calls as number, input: value.input as number, output: value.output as number,
    cacheRead: value.cacheRead as number, cacheWrite: value.cacheWrite as number, totalTokens: value.totalTokens as number };
}

function legacyTotals(value: unknown, stats: readonly string[]): Totals | undefined {
  if (!isRecord(value)) return undefined;
  const total = zeroTotals();
  for (const key of stats) {
    const item = value[key];
    if (!isRecord(item)) return undefined;
    const next = readTotals({ calls: item.calls, input: item.inputTokens, output: item.outputTokens,
      cacheRead: item.cacheReadTokens, cacheWrite: item.cacheWriteTokens, totalTokens: item.totalTokens });
    if (!next) return undefined;
    for (const field of totalFields) { total[field] += next[field]; if (!validCount(total[field])) return undefined; }
  }
  return total;
}

function boundaryTotals(value: unknown, id: string): Totals | undefined {
  if (!isRecord(value) || value.version !== 1 || value.extensionId !== id) return undefined;
  return readTotals(value.legacy);
}

function extensionIdFromFile(name: string, suffix: string): string | undefined {
  if (!name.endsWith(suffix)) return undefined;
  const id = name.slice(0, -suffix.length);
  return validName(id) ? id : undefined;
}

export async function extensionAccountingRevision(sessionId: string, cwd: string, descriptors: readonly LegacyDescriptor[], agentDir = getAgentDir()): Promise<string> {
  const agent = await realpath(agentDir).catch(() => resolve(agentDir));
  const dir = join(agent, "session-extension-usage", sessionKey(sessionId));
  const paths = [dir];
  const knownDescriptors = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  try {
    if (await physicalParents(agent, join(dir, "file")) === "ok") {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (extensionIdFromFile(entry.name, ".jsonl") || extensionIdFromFile(entry.name, ".legacy.json")) paths.push(join(dir, entry.name));
        const id = extensionIdFromFile(entry.name, ".legacy.json");
        if (id && !knownDescriptors.has(id)) {
          const boundary = await readBoundedJson(agent, join(dir, entry.name));
          const descriptor = isRecord(boundary.value) ? legacyDescriptor(id, boundary.value.legacyLocator) : undefined;
          if (descriptor) knownDescriptors.set(id, descriptor);
        }
      }
    }
  } catch { /* missing or unsafe state is reflected by directory metadata */ }
  for (const descriptor of knownDescriptors.values()) {
    const legacy = legacyPath(agent, descriptor, sessionId, cwd);
    if (legacy) paths.push(legacy);
  }
  const signatures = await Promise.all(paths.sort().map(async (file) => {
    const parents = await physicalParents(agent, file);
    if (parents !== "ok") return `${file}\0${parents}`;
    try { const info = await lstat(file); return `${file}\0${info.mtimeMs}\0${info.size}\0${info.isSymbolicLink() ? "link" : "physical"}`; }
    catch { return `${file}\0missing`; }
  }));
  return `${JSON.stringify(descriptors)}\n${signatures.join("\n")}`;
}

function unknownRecord(sessionId: string, id: string, historical: boolean): ReaderUsageRecord {
  const eventId = createHash("sha256").update(`${sessionId}\0${id}\0${historical ? "historical" : "invalid"}`).digest("hex");
  return { entryType: "extension", entryId: "", sessionId, timestamp: "", provider: "unknown", model: "unknown",
    usage: { provider: "unknown", model: "unknown", usageAvailable: false }, usageKind: "extension", extensionId: id,
    usageEventId: `extension-unavailable:${eventId}`, ...(historical ? { historicalIncomplete: true } : {}) };
}

function attributedLegacyTotals(
  baseline: Totals | undefined,
  current: Totals | undefined,
  covered: Totals,
): { totals: Totals; reconciled: boolean } | undefined {
  if (!baseline) return undefined;
  const base = baseline;
  if (!current) return { totals: base, reconciled: false };
  const delta = {} as Totals;
  for (const field of totalFields) {
    delta[field] = current[field] - base[field] - covered[field];
    if (delta[field] < 0) return baseline ? { totals: base, reconciled: false } : undefined;
  }
  const totals = { ...base };
  for (const field of totalFields) {
    totals[field] += delta[field];
    if (!validCount(totals[field])) return undefined;
  }
  return { totals, reconciled: true };
}

function estimatedLegacyRecord(
  sessionId: string,
  extensionId: string,
  totals: Totals,
  timestamp: string,
  attribution: { provider: string; model: string },
): ReaderUsageRecord {
  const id = createHash("sha256").update(`${sessionId}\0${extensionId}\0legacy-estimate`).digest("hex");
  const usage: BillingUsageInput = { ...attribution, timestamp, input: totals.input, output: totals.output,
    cacheRead: totals.cacheRead, cacheWrite: totals.cacheWrite, totalTokens: totals.totalTokens, usageAvailable: true };
  return { entryType: "extension", entryId: "", sessionId, timestamp, ...attribution, usage, usageKind: "extension", extensionId,
    usageEventId: `extension-legacy-estimate:${id}`, historicalIncomplete: true, historicalEstimated: true };
}

function parseEvent(raw: unknown, sessionId: string, expectedId?: string): { status: string; record: ReaderUsageRecord } | undefined {
  if (!isRecord(raw) || raw.version !== 1 || !validName(raw.extensionId) || !validName(raw.kind) || (expectedId && raw.extensionId !== expectedId)
      || !["started", "settled", "not_sent", "unknown"].includes(String(raw.status)) || !isRecord(raw.usageEvent)
      || raw.usageEvent.version !== 1 || typeof raw.usageEvent.id !== "string" || !raw.usageEvent.id.trim()
      || raw.usageEvent.id.length > 200 || !["origin", "copy", "replace"].includes(String(raw.usageEvent.relation))) return undefined;
  const provider = typeof raw.provider === "string" && raw.provider.trim() ? raw.provider.trim() : "unknown";
  const model = typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : "unknown";
  const timestamp = typeof raw.timestamp === "string" && Number.isFinite(Date.parse(raw.timestamp)) ? raw.timestamp : "";
  const serviceTier = raw.serviceTierSource === "response" && typeof raw.serviceTier === "string" && raw.serviceTier.trim() ? raw.serviceTier.trim().toLowerCase() : "";
  const value = isRecord(raw.usage) ? raw.usage : {};
  const complete = raw.status === "settled" && provider !== "unknown" && model !== "unknown" && !!timestamp && value.usageAvailable === true
    && [value.input, value.output, value.cacheRead, value.cacheWrite, value.totalTokens].every(validCount)
    && (value.totalTokens as number) > 0
    && (Number(value.input) + Number(value.output) + Number(value.cacheRead) + Number(value.cacheWrite)) > 0
    && (value.cacheWrite1h === undefined || (validCount(value.cacheWrite1h) && value.cacheWrite1h <= (value.cacheWrite as number)))
    && (value.reasoning === undefined || (validCount(value.reasoning) && value.reasoning <= (value.output as number)));
  const usage: BillingUsageInput = { provider, model, timestamp, ...(serviceTier ? { serviceTier } : {}), usageAvailable: complete,
    ...(complete ? { input: value.input as number, output: value.output as number, cacheRead: value.cacheRead as number,
      cacheWrite: value.cacheWrite as number, totalTokens: value.totalTokens as number,
      ...(typeof value.cacheWrite1h === "number" ? { cacheWrite1h: value.cacheWrite1h } : {}),
      ...(typeof value.reasoning === "number" ? { reasoning: value.reasoning } : {}) } : {}) };
  return { status: String(raw.status), record: { entryType: "extension", entryId: "", sessionId, timestamp, provider, model, usage,
    usageKind: "extension", extensionId: raw.extensionId, extensionCallKind: raw.kind, ...(serviceTier ? { serviceTier } : {}), usageEventId: `extension:${raw.extensionId}:${raw.usageEvent.id.trim()}`,
    ...(typeof raw.usageEvent.sourceSessionId === "string" ? { sourceSessionId: raw.usageEvent.sourceSessionId } : {}),
    ...(typeof raw.usageEvent.sourceEntryId === "string" ? { sourceEntryId: raw.usageEvent.sourceEntryId } : {}) } };
}

interface Coverage { id: string; extensionId: string; kind: string; eventIds: string[]; totals: Totals }

function parseCoverage(raw: unknown, expectedId: string): Coverage | undefined {
  if (!isRecord(raw) || raw.version !== 1 || raw.type !== "aggregate_coverage" || raw.extensionId !== expectedId
      || typeof raw.id !== "string" || !raw.id.trim() || raw.id.length > 200 || !validName(raw.kind)
      || !Array.isArray(raw.eventIds) || raw.eventIds.length === 0 || raw.eventIds.length > 1000
      || !raw.eventIds.every((id) => typeof id === "string" && !!id.trim() && id.length <= 200)
      || new Set(raw.eventIds).size !== raw.eventIds.length || !isRecord(raw.usage)) return undefined;
  const totals = readTotals({ ...raw.usage, calls: 1 });
  return totals ? { id: raw.id, extensionId: expectedId, kind: raw.kind, eventIds: raw.eventIds as string[], totals } : undefined;
}

async function readJournal(root: string, file: string): Promise<{ values: unknown[]; invalid: boolean }> {
  if (await physicalParents(root, file) !== "ok") return { values: [], invalid: true };
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1) return { values: [], invalid: true };
      const values: unknown[] = [];
      let pending = "", invalid = false;
      const parse = (line: string) => {
        if (!line.trim()) return;
        try { values.push(JSON.parse(line)); } catch { invalid = true; }
      };
      for await (const chunk of handle.createReadStream({ encoding: "utf8", autoClose: false })) {
        pending += chunk;
        let newline = pending.indexOf("\n");
        while (newline !== -1) { const line = pending.slice(0, newline); pending = pending.slice(newline + 1); if (line.length > 16384) invalid = true; else parse(line); newline = pending.indexOf("\n"); }
        if (pending.length > 16384) return { values, invalid: true };
      }
      if (pending) invalid = true;
      return { values, invalid };
    } finally { await handle.close(); }
  } catch { return { values: [], invalid: true }; }
}

/** Combines copied session entries and per-session journals using stable request identities. */
export async function readExtensionAccounting(sessionId: string, cwd: string, customEvents: unknown[], legacyTypes: Set<string>, descriptors: readonly LegacyDescriptor[], sessionTimestamp = "", agentDir = getAgentDir()): Promise<ReaderUsageRecord[]> {
  let agent: string;
  try { agent = await realpath(agentDir); } catch { return customEvents.length || legacyTypes.size ? [unknownRecord(sessionId, "extension-usage", legacyTypes.size > 0)] : []; }
  const dir = join(agent, "session-extension-usage", sessionKey(sessionId));
  const events = new Map<string, { status: string; record: ReaderUsageRecord }>();
  const invalid = new Set<string>();
  const boundaries = new Map<string, string>();
  const coverages = new Map<string, Coverage>();
  const add = (raw: unknown, expectedId?: string) => {
    const parsed = parseEvent(raw, sessionId, expectedId);
    if (!parsed) { invalid.add(expectedId ?? (isRecord(raw) && validName(raw.extensionId) ? raw.extensionId : "extension-usage")); return; }
    const id = parsed.record.usageEventId!;
    const previous = events.get(id);
    if (previous?.status === "settled" && parsed.status === "settled"
        && JSON.stringify([previous.record.provider, previous.record.model, previous.record.usage]) !== JSON.stringify([parsed.record.provider, parsed.record.model, parsed.record.usage])) {
      invalid.add(parsed.record.extensionId!);
      events.set(id, { ...previous, record: { ...previous.record, usage: { ...previous.record.usage, usageAvailable: false } } });
    } else if ((previous?.status === "settled" && parsed.status === "not_sent")
        || (previous?.status === "not_sent" && parsed.status === "settled")) {
      invalid.add(parsed.record.extensionId!);
      if (previous.status === "not_sent") events.set(id, parsed);
    } else if (!previous || previous.status === "started" || previous.status === parsed.status
        || (previous.status === "unknown" && parsed.status !== "started")) events.set(id, parsed);
  };
  for (const event of customEvents) add(event);
  try {
    const directoryState = await physicalParents(agent, join(dir, "file"));
    if (directoryState === "unsafe") invalid.add("extension-usage");
    if (directoryState === "ok") {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const journalId = extensionIdFromFile(entry.name, ".jsonl");
        const boundaryId = extensionIdFromFile(entry.name, ".legacy.json");
        if (boundaryId) boundaries.set(boundaryId, join(dir, entry.name));
        if (!journalId) continue;
        if (!entry.isFile() || entry.isSymbolicLink()) { invalid.add(journalId); continue; }
        const journal = await readJournal(agent, join(dir, entry.name));
        if (journal.invalid) invalid.add(journalId);
        for (const value of journal.values) {
          if (isRecord(value) && value.type === "aggregate_coverage") {
            const coverage = parseCoverage(value, journalId);
            if (!coverage || coverages.has(`${journalId}:${coverage.id}`)) invalid.add(journalId);
            else coverages.set(`${journalId}:${coverage.id}`, coverage);
          } else add(value, journalId);
        }
      }
    }
  } catch { invalid.add("extension-usage"); }
  const covered = new Map<string, Totals>();
  const usedEvents = new Set<string>();
  for (const coverage of coverages.values()) {
    const keys = coverage.eventIds.map((id) => `extension:${coverage.extensionId}:${id}`);
    const matched = keys.map((key) => events.get(key));
    if (keys.some((key) => usedEvents.has(key)) || matched.some((event) => !event || event.status === "not_sent" || event.record.extensionCallKind !== coverage.kind)) {
      invalid.add(coverage.extensionId); continue;
    }
    const sum = zeroTotals();
    for (const event of matched) {
      const usage = event!.record.usage;
      sum.input += usage.input ?? 0; sum.output += usage.output ?? 0; sum.cacheRead += usage.cacheRead ?? 0;
      sum.cacheWrite += usage.cacheWrite ?? 0; sum.totalTokens += usage.totalTokens ?? 0;
    }
    if (totalFields.filter((field) => field !== "calls").some((field) => sum[field] !== coverage.totals[field])) {
      invalid.add(coverage.extensionId); continue;
    }
    keys.forEach((key) => usedEvents.add(key));
    const total = covered.get(coverage.extensionId) ?? zeroTotals();
    for (const field of totalFields) total[field] += coverage.totals[field];
    covered.set(coverage.extensionId, total);
  }
  const historical = new Set<string>();
  const baselines = new Map<string, Totals>();
  const legacyStats = new Map<string, Totals>();
  const invalidLegacy = new Set<string>();
  const knownDescriptors = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  for (const [id, boundary] of boundaries) {
    const data = await readBoundedJson(agent, boundary);
    const totals = data.state === "ok" ? boundaryTotals(data.value, id) : undefined;
    if (!totals || (totals.calls > 0 && totals.totalTokens > 0)) historical.add(id);
    if (totals) baselines.set(id, totals);
    if (!knownDescriptors.has(id) && isRecord(data.value)) {
      const descriptor = legacyDescriptor(id, data.value.legacyLocator);
      if (descriptor) knownDescriptors.set(id, descriptor);
    }
  }
  for (const type of legacyTypes) {
    if (![...knownDescriptors.values()].some((descriptor) => descriptor.customType === type)) historical.add("extension-usage");
  }
  for (const descriptor of knownDescriptors.values()) {
    if (legacyTypes.has(descriptor.customType)) historical.add(descriptor.id);
    const file = legacyPath(agent, descriptor, sessionId, cwd);
    const legacy = file ? await readBoundedJson(agent, file) : { state: "missing" as const };
    if (legacy.state === "invalid") { historical.add(descriptor.id); invalidLegacy.add(descriptor.id); continue; }
    if (legacy.state !== "ok") continue;
    const totals = legacyTotals(legacy.value, descriptor.stats);
    if (!totals) { historical.add(descriptor.id); invalidLegacy.add(descriptor.id); continue; }
    legacyStats.set(descriptor.id, totals);
    const baseline = baselines.get(descriptor.id) ?? zeroTotals();
    const coverage = covered.get(descriptor.id) ?? zeroTotals();
    const hasUncoveredTokens = totalFields.filter((field) => field !== "calls").some((field) => totals[field] > baseline[field] + coverage[field]);
    if (hasUncoveredTokens || (totals.calls > baseline.calls + coverage.calls && totals.totalTokens > baseline.totalTokens + coverage.totalTokens)) historical.add(descriptor.id);
  }
  const estimates: ReaderUsageRecord[] = [];
  const estimatedIds = new Set<string>();
  const zeroTokenIds = new Set<string>();
  const unresolvedEstimates = new Set<string>();
  if (Number.isFinite(Date.parse(sessionTimestamp))) {
    for (const id of historical) {
      const attribution = LEGACY_ESTIMATE_MODELS[id];
      if (!attribution || invalid.has(id)) continue;
      const estimate = attributedLegacyTotals(baselines.get(id), legacyStats.get(id), covered.get(id) ?? zeroTotals());
      if (estimate && (estimate.totals.calls === 0
          || estimate.totals.input + estimate.totals.output + estimate.totals.cacheRead + estimate.totals.cacheWrite === 0)) {
        zeroTokenIds.add(id);
        continue;
      }
      if (!estimate) continue;
      estimates.push(estimatedLegacyRecord(sessionId, id, estimate.totals, sessionTimestamp, attribution));
      estimatedIds.add(id);
      if (!estimate.reconciled || invalidLegacy.has(id)) unresolvedEstimates.add(id);
    }
  }
  return [
    ...[...events.values()].filter((event) => event.status !== "not_sent").map((event) => event.record),
    ...estimates,
    ...[...invalid].map((id) => unknownRecord(sessionId, id, false)),
    ...[...historical].filter((id) => (!estimatedIds.has(id) && !zeroTokenIds.has(id)) || unresolvedEstimates.has(id)).map((id) => unknownRecord(sessionId, id, true)),
  ];
}
