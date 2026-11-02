"use client";

import { useCallback, useMemo, useState } from "react";
import { copyText } from "@/lib/clipboard";
import type {
  PromptRange,
  RuntimeContextSource,
  RuntimeExtensionInspection,
  RuntimeInspection,
  RuntimeSkillInspection,
  RuntimeToolInspection,
} from "@/lib/runtime-inspection";
import { useI18n } from "@/hooks/useI18n";
import { extensionDisplayName, pluginNameFromSource, pluginSourceKind } from "@/lib/plugin-source";
import type { ToolEntry } from "@/lib/tool-presets";

interface Props {
  prompt: string | null;
  inspection: RuntimeInspection | null;
  /** Fallback live declarations for SDK snapshots that do not carry tools. */
  tools?: ToolEntry[] | null;
}

type InspectorTab = "prompt" | "context" | "tools" | "skills" | "extensions";

const TABS: Array<{ id: InspectorTab; key: string }> = [
  { id: "prompt", key: "system.inspection.prompt" },
  { id: "context", key: "system.inspection.context" },
  { id: "tools", key: "system.inspection.tools" },
  { id: "skills", key: "system.inspection.skills" },
  { id: "extensions", key: "system.inspection.extensions" },
];

function rangeLabel(range: PromptRange | undefined, t: (key: string, params?: Record<string, string | number>) => string): string | null {
  if (!range) return null;
  return t("system.inspection.promptLine", { start: range.startLine, end: range.endLine });
}

function hashLabel(hash: string | undefined): string | null {
  return hash ? `${hash.slice(0, 12)}…` : null;
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return "[unserializable]";
  }
}

function sourceText(source: { source: string; scope: string; origin: string } | null, unknownLabel: string): string {
  if (!source) return unknownLabel;
  return `${source.source} · ${source.scope} · ${source.origin}`;
}

function StatusPill({ children, tone = "muted" }: { children: React.ReactNode; tone?: "good" | "warn" | "muted" | "project" }) {
  const colors = {
    good: { color: "#166534", background: "rgba(34,197,94,0.10)", border: "rgba(34,197,94,0.22)" },
    warn: { color: "#9a3412", background: "rgba(249,115,22,0.10)", border: "rgba(249,115,22,0.24)" },
    muted: { color: "var(--text-muted)", background: "var(--bg-hover)", border: "var(--border)" },
    project: { color: "rgba(67,56,202,0.92)", background: "rgba(99,102,241,0.12)", border: "rgba(99,102,241,0.24)" },
  }[tone];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", minHeight: 20, padding: "1px 7px", border: `1px solid ${colors.border}`, borderRadius: 5, color: colors.color, background: colors.background, fontSize: 10, lineHeight: 1.2, whiteSpace: "nowrap" }}>
      {children}
    </span>
  );
}

type RuntimeSource = NonNullable<RuntimeSkillInspection["sourceInfo"]>;
type RuntimeResourceKind = "skill" | "extension";

function runtimeSourceLabel(
  source: RuntimeSource,
  resourceKind: RuntimeResourceKind,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const kindKey = pluginSourceKind(source.source) === "npm"
    ? "system.inspection.sourceNpm"
    : pluginSourceKind(source.source) === "git"
      ? "system.inspection.sourceGit"
      : "system.inspection.sourceLocal";
  const kindLabel = t(kindKey);
  if (resourceKind === "skill" && source.origin !== "package") return t("system.inspection.localSkill");
  if (resourceKind === "skill" && source.origin === "package") {
    const pluginName = pluginNameFromSource(source.source);
    const normalizedName = pluginName.trim().toLowerCase();
    if (pluginName && !["local", "auto", "user", "project", "cli"].includes(normalizedName)) {
      return `${kindLabel} · ${pluginName}`;
    }
  }
  return kindLabel;
}

function runtimeScopeLabel(
  source: RuntimeSource,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  return source.scope === "project"
    ? t("system.inspection.scopeProject")
    : source.scope === "temporary"
      ? t("system.inspection.scopeTemporary")
      : t("system.inspection.scopeGlobal");
}

function RuntimeSourceTags({
  source,
  resourceKind,
  t,
}: {
  source: RuntimeSource | null;
  resourceKind: RuntimeResourceKind;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  if (!source) return <StatusPill>{t("system.inspection.unknownSource")}</StatusPill>;
  return (
    <>
      <StatusPill>{runtimeSourceLabel(source, resourceKind, t)}</StatusPill>
      <StatusPill tone={source.scope === "project" ? "project" : "muted"}>{runtimeScopeLabel(source, t)}</StatusPill>
    </>
  );
}

function SourceMeta({ source, unknownLabel }: { source: { source: string; scope: string; origin: string } | null; unknownLabel: string }) {
  return <span style={{ color: "var(--text-dim)", overflowWrap: "anywhere" }}>{sourceText(source, unknownLabel)}</span>;
}

function PromptRangeMeta({ range, t }: { range?: PromptRange; t: (key: string, params?: Record<string, string | number>) => string }) {
  const label = rangeLabel(range, t);
  return label ? <span style={{ color: "var(--accent)" }}>{label}</span> : null;
}

function SectionEmpty({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: "24px 16px", color: "var(--text-muted)", fontSize: 12, textAlign: "center", fontStyle: "italic" }}>{children}</div>;
}

function ContextSourceRow({ item, t }: { item: RuntimeContextSource; t: (key: string, params?: Record<string, string | number>) => string }) {
  const kindKey = item.kind === "agent-file"
    ? "system.inspection.agentFile"
    : item.kind === "system-prompt-file"
      ? "system.inspection.systemPromptFile"
      : "system.inspection.appendPrompt";
  const stateLabel = item.inSystemPrompt ? t("system.inspection.inPrompt") : t("system.inspection.notInPrompt");
  return (
    <div style={{ padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, color: "var(--text)", fontSize: 12 }}>
            <strong>{t(kindKey)}</strong>
            <StatusPill tone={item.inSystemPrompt ? "good" : "muted"}>{stateLabel}</StatusPill>
          </div>
          <div style={{ marginTop: 4, color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 11, overflowWrap: "anywhere" }}>{item.path}</div>
        </div>
        <div style={{ flexShrink: 0, color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 10, textAlign: "right" }}>
          {item.characters ?? 0} {t("system.inspection.characters")}
          {item.sha256 && <div title={item.sha256}>SHA {hashLabel(item.sha256)}</div>}
        </div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 5, fontSize: 10 }}>
        <PromptRangeMeta range={item.promptRange} t={t} />
        {!item.promptRange && <span style={{ color: "var(--text-dim)" }}>{t("system.inspection.noPromptRange")}</span>}
      </div>
    </div>
  );
}

function ToolDescription({
  description,
  expandLabel,
  collapseLabel,
}: {
  description: string;
  expandLabel: string;
  collapseLabel: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const isLong = description.length > 180;
  return (
    <div style={{ marginTop: 4, color: "var(--text-muted)", fontSize: 11, lineHeight: 1.45 }}>
      <div style={!expanded && isLong ? { display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" } : undefined}>
        {description}
      </div>
      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          style={{ background: "none", border: "none", padding: 0, color: "var(--accent)", fontSize: 10, cursor: "pointer", marginTop: 2 }}
        >
          {expanded ? collapseLabel : expandLabel}
        </button>
      )}
    </div>
  );
}

function ToolRow({ item, t }: { item: RuntimeToolInspection; t: (key: string, params?: Record<string, string | number>) => string }) {
  return (
    <div style={{ padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
            <strong style={{ color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 12 }}>{item.name}</strong>
            <StatusPill tone={item.active ? "good" : "muted"}>{item.active ? t("system.inspection.active") : t("system.inspection.inactive")}</StatusPill>
            {item.promptGuidelines.length > 0 && (
              <StatusPill tone="muted">{t("system.inspection.hasGuidelines", { count: item.promptGuidelines.length })}</StatusPill>
            )}
          </div>
          <ToolDescription description={item.description} expandLabel={t("system.inspection.expandDesc")} collapseLabel={t("system.inspection.collapseDesc")} />
          <div style={{ marginTop: 4, fontSize: 10 }}><SourceMeta source={item.sourceInfo} unknownLabel={t("system.inspection.unknownSource")} /></div>
        </div>
      </div>
      <details style={{ marginTop: 7, color: "var(--text-muted)", fontSize: 10 }}>
        <summary style={{ cursor: "pointer", color: "var(--text-muted)" }}>{t("system.inspection.parameters")}</summary>
        <pre style={{ maxHeight: 220, margin: "7px 0 0", padding: 8, overflow: "auto", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 10, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{jsonText(item.parameters)}</pre>
      </details>
      {item.promptGuidelines.length > 0 && (
        <details style={{ marginTop: 5, color: "var(--text-muted)", fontSize: 10 }}>
          <summary style={{ cursor: "pointer" }}>{t("system.inspection.guidelines")}</summary>
          <ul style={{ margin: "5px 0 0 18px", padding: 0 }}>{item.promptGuidelines.map((guideline) => <li key={guideline}>{guideline}</li>)}</ul>
        </details>
      )}
    </div>
  );
}

function SkillRow({ item, t }: { item: RuntimeSkillInspection; t: (key: string, params?: Record<string, string | number>) => string }) {
  const invocationMode = item.invocationMode ?? (item.disableModelInvocation ? "explicit-only" : "automatic");
  const resourceState = item.resourceState ?? "enabled";
  const availability = item.availability ?? "available";
  return (
    <div style={{ padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
            <strong style={{ color: "var(--text)", fontSize: 12 }}>{item.name}</strong>
            <StatusPill tone={item.promptVisible ? "good" : "muted"}>{item.promptVisible ? t("system.inspection.promptVisible") : t("system.inspection.loaderOnly")}</StatusPill>
            <StatusPill tone={resourceState === "enabled" ? "good" : "warn"}>Resource: {resourceState}</StatusPill>
            <StatusPill tone={invocationMode === "explicit-only" ? "warn" : "good"}>Invocation: {invocationMode}</StatusPill>
            {availability !== "available" && <StatusPill tone="warn">Availability: {availability}</StatusPill>}
            <RuntimeSourceTags source={item.sourceInfo} resourceKind="skill" t={t} />
          </div>
          <ToolDescription description={item.description} expandLabel={t("system.inspection.expandDesc")} collapseLabel={t("system.inspection.collapseDesc")} />
          <div style={{ marginTop: 4, color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 10, overflowWrap: "anywhere" }}>{item.filePath}</div>
          <div style={{ marginTop: 4, fontSize: 10 }}><SourceMeta source={item.sourceInfo} unknownLabel={t("system.inspection.unknownSource")} /></div>
        </div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 5, fontSize: 10 }}>
        <PromptRangeMeta range={item.promptRange} t={t} />
        {!item.promptRange && <span style={{ color: "var(--text-dim)" }}>{t("system.inspection.noPromptRange")}</span>}
      </div>
    </div>
  );
}

function ExtensionRow({ item, t }: { item: RuntimeExtensionInspection; t: (key: string, params?: Record<string, string | number>) => string }) {
  return (
    <div style={{ padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
            <strong style={{ color: "var(--text)", fontSize: 12 }} title={item.path}>{extensionDisplayName(item.path, item.sourceInfo, item.resolvedPath)}</strong>
            <StatusPill tone={item.status === "loaded" ? "good" : "warn"}>{item.status === "loaded" ? t("system.inspection.loaded") : t("system.inspection.failed")}</StatusPill>
            <RuntimeSourceTags source={item.sourceInfo} resourceKind="extension" t={t} />
          </div>
          <div style={{ marginTop: 4, color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 10, overflowWrap: "anywhere" }}>{item.path}</div>
          {item.resolvedPath && item.resolvedPath !== item.path && <div style={{ marginTop: 4, color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 10, overflowWrap: "anywhere" }}>{item.resolvedPath}</div>}
          <div style={{ marginTop: 4, fontSize: 10 }}><SourceMeta source={item.sourceInfo} unknownLabel={t("system.inspection.unknownSource")} /></div>
        </div>
      </div>
      {item.status === "loaded" ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 6, color: "var(--text-muted)", fontSize: 10 }}>
          <span>{t("system.inspection.registeredTools")}: {item.registeredTools.length ? item.registeredTools.join(", ") : t("system.inspection.none")}</span>
          <span>{t("system.inspection.registeredCommands")}: {item.registeredCommands.length ? item.registeredCommands.join(", ") : t("system.inspection.none")}</span>
        </div>
      ) : item.error ? (
        <div role="alert" style={{ marginTop: 6, color: "#b91c1c", fontSize: 11, overflowWrap: "anywhere" }}>{item.error}</div>
      ) : null}
    </div>
  );
}

function FilterBar<T extends string>({
  options,
  selected,
  onSelect,
}: {
  options: Array<{ id: T; label: string; count: number }>;
  selected: T;
  onSelect: (id: T) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Filter"
      style={{
        position: "sticky",
        top: 0,
        zIndex: 2,
        background: "var(--bg-panel)",
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "8px 0 6px",
        marginBottom: 6,
        borderBottom: "1px solid var(--border)",
        overflowX: "auto",
      }}
    >
      {options.map((opt) => {
        const isCurrent = opt.id === selected;
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onSelect(opt.id)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "2px 7px",
              borderRadius: 4,
              border: isCurrent ? "1px solid var(--accent)" : "1px solid var(--border)",
              background: isCurrent ? "rgba(37,99,235,0.12)" : "none",
              color: isCurrent ? "var(--accent)" : "var(--text-muted)",
              fontSize: 10,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            <span>{opt.label}</span>
            <span style={{ fontFamily: "var(--font-mono)", opacity: 0.85 }}>({opt.count})</span>
          </button>
        );
      })}
    </div>
  );
}

export function SystemPromptInspector({ prompt, inspection, tools }: Props) {
  const { t, locale } = useI18n();
  const [tab, setTab] = useState<InspectorTab>("prompt");
  const [copied, setCopied] = useState(false);
  const copyPrompt = useCallback(() => {
    if (prompt === null) return;
    void copyText(prompt).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  }, [prompt]);
  const displayInspection = useMemo(() => {
    if (!inspection || inspection.tools.length > 0 || !tools?.length) return inspection;
    return {
      ...inspection,
      tools: tools.map((tool): RuntimeToolInspection => ({
        name: tool.name,
        description: tool.description,
        active: tool.active,
        mentionedInSystemPrompt: false,
        parameters: tool.parameters ?? {},
        promptGuidelines: tool.promptGuidelines ?? [],
        sourceInfo: null,
      })),
    };
  }, [inspection, tools]);
  const activeTools = useMemo(() => displayInspection?.tools.filter((item) => item.active).length ?? 0, [displayInspection]);
  const loadedExtensions = useMemo(() => displayInspection?.extensions.filter((item) => item.status === "loaded").length ?? 0, [displayInspection]);
  const failedExtensions = useMemo(() => displayInspection?.extensions.filter((item) => item.status === "failed").length ?? 0, [displayInspection]);

  type SkillFilter = "all" | "in-prompt" | "explicit-only" | "not-in-prompt";
  type ToolFilter = "all" | "active" | "inactive";
  type ExtensionFilter = "all" | "loaded" | "failed";
  type ContextFilter = "all" | "in-prompt" | "not-in-prompt";

  const [skillFilter, setSkillFilter] = useState<SkillFilter>("all");
  const [toolFilter, setToolFilter] = useState<ToolFilter>("all");
  const [extensionFilter, setExtensionFilter] = useState<ExtensionFilter>("all");
  const [contextFilter, setContextFilter] = useState<ContextFilter>("all");

  const allSkills = useMemo(() => displayInspection?.skills ?? [], [displayInspection]);
  const skillOptions = useMemo(() => [
    { id: "all" as const, label: t("system.inspection.filterAll"), count: allSkills.length },
    { id: "in-prompt" as const, label: t("system.inspection.filterInPrompt"), count: allSkills.filter((s) => s.promptVisible).length },
    { id: "explicit-only" as const, label: t("system.inspection.filterExplicitOnly"), count: allSkills.filter((s) => (s.invocationMode ?? (s.disableModelInvocation ? "explicit-only" : "automatic")) === "explicit-only").length },
    { id: "not-in-prompt" as const, label: t("system.inspection.filterNotInPrompt"), count: allSkills.filter((s) => !s.promptVisible).length },
  ], [allSkills, t]);
  const filteredSkills = useMemo(() => {
    if (skillFilter === "in-prompt") return allSkills.filter((s) => s.promptVisible);
    if (skillFilter === "explicit-only") return allSkills.filter((s) => (s.invocationMode ?? (s.disableModelInvocation ? "explicit-only" : "automatic")) === "explicit-only");
    if (skillFilter === "not-in-prompt") return allSkills.filter((s) => !s.promptVisible);
    return allSkills;
  }, [allSkills, skillFilter]);

  const allTools = useMemo(() => displayInspection?.tools ?? [], [displayInspection]);
  const toolOptions = useMemo(() => [
    { id: "all" as const, label: t("system.inspection.filterAll"), count: allTools.length },
    { id: "active" as const, label: t("system.inspection.filterActive"), count: allTools.filter((item) => item.active).length },
    { id: "inactive" as const, label: t("system.inspection.filterInactive"), count: allTools.filter((item) => !item.active).length },
  ], [allTools, t]);
  const filteredTools = useMemo(() => {
    if (toolFilter === "active") return allTools.filter((item) => item.active);
    if (toolFilter === "inactive") return allTools.filter((item) => !item.active);
    return allTools;
  }, [allTools, toolFilter]);

  const allExtensions = useMemo(() => displayInspection?.extensions ?? [], [displayInspection]);
  const extensionOptions = useMemo(() => [
    { id: "all" as const, label: t("system.inspection.filterAll"), count: allExtensions.length },
    { id: "loaded" as const, label: t("system.inspection.filterLoaded"), count: allExtensions.filter((item) => item.status === "loaded").length },
    { id: "failed" as const, label: t("system.inspection.filterFailed"), count: allExtensions.filter((item) => item.status === "failed").length },
  ], [allExtensions, t]);
  const filteredExtensions = useMemo(() => {
    if (extensionFilter === "loaded") return allExtensions.filter((item) => item.status === "loaded");
    if (extensionFilter === "failed") return allExtensions.filter((item) => item.status === "failed");
    return allExtensions;
  }, [allExtensions, extensionFilter]);

  const allContextSources = useMemo(() => displayInspection?.contextSources ?? [], [displayInspection]);
  const contextOptions = useMemo(() => [
    { id: "all" as const, label: t("system.inspection.filterAll"), count: allContextSources.length },
    { id: "in-prompt" as const, label: t("system.inspection.filterLocated"), count: allContextSources.filter((item) => item.inSystemPrompt).length },
    { id: "not-in-prompt" as const, label: t("system.inspection.filterUnlocated"), count: allContextSources.filter((item) => !item.inSystemPrompt).length },
  ], [allContextSources, t]);
  const filteredContextSources = useMemo(() => {
    if (contextFilter === "in-prompt") return allContextSources.filter((item) => item.inSystemPrompt);
    if (contextFilter === "not-in-prompt") return allContextSources.filter((item) => !item.inSystemPrompt);
    return allContextSources;
  }, [allContextSources, contextFilter]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "min(680px, 78vh)", maxHeight: "min(680px, 78vh)", background: "var(--bg-panel)", borderBottom: "1px solid var(--border)" }}>
      <div style={{ flex: "0 0 auto", padding: "11px 14px 10px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 }}>
            <span style={{ color: "var(--text)", fontSize: 13, fontWeight: 650 }}>{t("system.inspection.title")}</span>
            {inspection && <StatusPill tone="good">{t("system.inspection.snapshot")}</StatusPill>}
            {inspection && (
              <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
                {inspection.systemPrompt.characters.toLocaleString(locale)} {t("system.inspection.characters")} · {inspection.systemPrompt.lines.toLocaleString(locale)} {t("system.inspection.lines")} · {t("system.inspection.promptTokens", { count: (inspection.systemPrompt.estimatedTokens ?? Math.ceil((prompt ?? "").length / 4)).toLocaleString(locale) })}
              </span>
            )}
          </div>
          {prompt !== null && (
            <button
              type="button"
              onClick={copyPrompt}
              title={t("system.inspection.copy")}
              style={{
                flexShrink: 0,
                padding: "3px 8px",
                border: "1px solid var(--border)",
                borderRadius: 5,
                background: "none",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 10,
              }}
            >
              {copied ? t("system.inspection.copied") : t("system.inspection.copy")}
            </button>
          )}
        </div>
        {inspection && (
          <div style={{ marginTop: 6, color: "var(--text-muted)", fontSize: 11, lineHeight: 1.45 }}>
            {t("system.inspection.sourceExplanation")}
          </div>
        )}
        {inspection && inspection.errors.length > 0 && (
          <div role="alert" style={{ marginTop: 7, padding: "6px 8px", border: "1px solid rgba(249,115,22,0.25)", borderRadius: 5, color: "#9a3412", background: "rgba(249,115,22,0.08)", fontSize: 10 }}>
            {t("system.inspection.partial")}: {inspection.errors.join("; ")}
          </div>
        )}
      </div>

      <div role="tablist" aria-label={t("system.inspection.title")} style={{ flex: "0 0 auto", display: "flex", gap: 2, padding: "7px 10px 0", overflowX: "auto", borderBottom: "1px solid var(--border)" }}>
        {TABS.map((item) => {
          const selected = item.id === tab;
          const count = item.id === "tools"
            ? `${activeTools}/${inspection?.tools.length ?? 0}`
            : item.id === "skills"
              ? String(inspection?.skills.length ?? 0)
              : item.id === "extensions"
                ? `${loadedExtensions}${failedExtensions ? `+${failedExtensions}` : ""}`
                : null;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setTab(item.id)}
              style={{ display: "inline-flex", alignItems: "center", gap: 5, minHeight: 28, padding: "4px 9px", border: 0, borderBottom: selected ? "2px solid var(--accent)" : "2px solid transparent", background: selected ? "var(--bg-selected)" : "none", color: selected ? "var(--text)" : "var(--text-muted)", cursor: "pointer", fontSize: 10, whiteSpace: "nowrap" }}
            >
              {t(item.key)}{count !== null && <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{count}</span>}
            </button>
          );
        })}
      </div>

      <div role="tabpanel" style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: "0 14px 12px" }}>
        {tab === "prompt" && (
          prompt === null ? (
            <SectionEmpty>{t("system.load")}</SectionEmpty>
          ) : prompt === "" ? (
            <SectionEmpty>{t("system.empty")}</SectionEmpty>
          ) : (
            <pre style={{ margin: 0, padding: "12px 2px 4px", color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.6, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{prompt}</pre>
          )
        )}

        {tab === "context" && (
          !allContextSources.length ? (
            <SectionEmpty>{t("system.inspection.noContext")}</SectionEmpty>
          ) : (
            <>
              <FilterBar options={contextOptions} selected={contextFilter} onSelect={setContextFilter} />
              {filteredContextSources.length ? (
                filteredContextSources.map((item) => <ContextSourceRow key={`${item.kind}:${item.path}`} item={item} t={t} />)
              ) : (
                <SectionEmpty>{t("system.inspection.noFilteredItems")}</SectionEmpty>
              )}
            </>
          )
        )}

        {tab === "tools" && (
          !allTools.length ? (
            <SectionEmpty>{t("system.inspection.noTools")}</SectionEmpty>
          ) : (
            <>
              <FilterBar options={toolOptions} selected={toolFilter} onSelect={setToolFilter} />
              {filteredTools.length ? (
                filteredTools.map((item) => <ToolRow key={item.name} item={item} t={t} />)
              ) : (
                <SectionEmpty>{t("system.inspection.noFilteredItems")}</SectionEmpty>
              )}
            </>
          )
        )}

        {tab === "skills" && (
          !allSkills.length ? (
            <SectionEmpty>{t("system.inspection.noSkills")}</SectionEmpty>
          ) : (
            <>
              <FilterBar options={skillOptions} selected={skillFilter} onSelect={setSkillFilter} />
              {filteredSkills.length ? (
                filteredSkills.map((item) => <SkillRow key={`${item.name}:${item.filePath}`} item={item} t={t} />)
              ) : (
                <SectionEmpty>{t("system.inspection.noFilteredItems")}</SectionEmpty>
              )}
            </>
          )
        )}

        {tab === "extensions" && (
          !allExtensions.length ? (
            <SectionEmpty>{t("system.inspection.noExtensions")}</SectionEmpty>
          ) : (
            <>
              <FilterBar options={extensionOptions} selected={extensionFilter} onSelect={setExtensionFilter} />
              {filteredExtensions.length ? (
                filteredExtensions.map((item) => <ExtensionRow key={`${item.status}:${item.path}`} item={item} t={t} />)
              ) : (
                <SectionEmpty>{t("system.inspection.noFilteredItems")}</SectionEmpty>
              )}
            </>
          )
        )}
      </div>
    </div>
  );
}
