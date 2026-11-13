"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { parseCompactionModel, parseCompactionThinking, type CompactionModelSelection } from "@/lib/compaction-model";
import { getThinkingChoices, type ThinkingSelection } from "@/lib/thinking-level";
import type { PluginModelSettingsRow } from "@/lib/plugin-model-settings";
import { ReaderFloatingSelect } from "./ReaderFloatingSelect";
import { ConfigButton, ConfigDetailStack, ConfigDetailTitle, ConfigNotice } from "./SettingsUi";
import { readApiJson } from "./models-config-helpers";
import type { SettingsPanelController } from "./UnifiedSettingsModal";
import { useHiddenModelProviders } from "@/hooks/useHiddenModelProviders";
import { filterHiddenProviderNames } from "@/lib/model-visibility-preference";

interface AvailableModel extends CompactionModelSelection {
  name: string;
  contextWindow: number;
  thinkingLevels?: string[];
  thinkingLevelMap?: Record<string, string | null>;
}
type PluginError = { id: string; label: string; error: string };
type Rows = { compaction: CompactionModelSelection | null; compactionThinking: ThinkingSelection | null; plugins: PluginModelSettingsRow[] };
const MIXED = "__mixed__";
const UNRESOLVED = "__unresolved__";
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function apiFor(peer: string | undefined, name: string) {
  if (!peer) return `/api/${name}`;
  const [route, query] = name.split("?", 2);
  return `/api/remote/${route}?${query ? `${query}&` : ""}peer=${encodeURIComponent(peer)}`;
}

export function PluginModelConfig({ cwd, remotePeer, onClose, controllerRef }: {
  cwd?: string;
  remotePeer?: string;
  onClose: () => void;
  controllerRef?: React.MutableRefObject<SettingsPanelController | null>;
}) {
  const { t } = useI18n();
  const mobile = useIsMobile();
  const hiddenModelProviders = useHiddenModelProviders();
  const [rows, setRows] = useState<Rows>({ compaction: null, compactionThinking: null, plugins: [] });
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [pluginErrors, setPluginErrors] = useState<PluginError[]>([]);
  const [pluginLoadError, setPluginLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const snapshot = useRef<Rows | undefined>(undefined);
  const requestScope = useRef<AbortController | null>(null);

  useEffect(() => {
    const scope = new AbortController();
    requestScope.current = scope;
    snapshot.current = undefined;
    setLoading(true); setError(null); setPluginLoadError(null); setSavedOk(false);
    setRows({ compaction: null, compactionThinking: null, plugins: [] }); setModels([]); setPluginErrors([]);
    void (async () => {
      try {
        const response = await fetch(apiFor(remotePeer, `compaction-model${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`), { signal: scope.signal, cache: "no-store" });
        const data = await readApiJson<{ model?: unknown; thinkingLevel?: unknown; models?: AvailableModel[]; error?: string }>(response);
        if (!response.ok || data.error || !("model" in data) || !Array.isArray(data.models)) throw new Error(data.error ?? `HTTP ${response.status}`);
        const initial: Rows = { compaction: parseCompactionModel(data.model), compactionThinking: parseCompactionThinking(data.thinkingLevel), plugins: [] };
        try {
          const pluginResponse = await fetch(apiFor(remotePeer, "plugin-models"), { signal: scope.signal, cache: "no-store" });
          const pluginData = await readApiJson<{ rows?: Array<PluginModelSettingsRow | PluginError>; error?: string }>(pluginResponse);
          if (!pluginResponse.ok || pluginData.error || !Array.isArray(pluginData.rows)) throw new Error(pluginData.error ?? `HTTP ${pluginResponse.status}`);
          initial.plugins = pluginData.rows.filter((item): item is PluginModelSettingsRow => !("error" in item));
          if (!scope.signal.aborted) setPluginErrors(pluginData.rows.filter((item): item is PluginError => "error" in item));
        } catch (cause) {
          if (!scope.signal.aborted) setPluginLoadError(cause instanceof Error ? cause.message : String(cause));
        }
        if (scope.signal.aborted) return;
        snapshot.current = initial;
        setRows(initial); setModels(data.models);
      } catch (cause) {
        if (!scope.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      } finally { if (!scope.signal.aborted) setLoading(false); }
    })();
    return () => scope.abort();
  }, [cwd, remotePeer, revision]);

  const isDirty = useCallback(() => {
    const saved = snapshot.current;
    return !!saved && (!same(rows.compaction, saved.compaction) || rows.compactionThinking !== saved.compactionThinking || rows.plugins.some((row) => {
      const before = saved.plugins.find((item) => item.id === row.id);
      return before && (!same(row.model, before.model) || row.thinking !== before.thinking);
    }));
  }, [rows]);
  const discard = useCallback(() => {
    if (!snapshot.current) return;
    setRows(snapshot.current); setError(null); setSavedOk(false);
  }, []);
  const save = useCallback(async (): Promise<boolean> => {
    const scope = requestScope.current;
    const before = snapshot.current;
    if (!scope || scope.signal.aborted || loading || saving || !before) return false;
    setSaving(true); setError(null); setSavedOk(false);
    let saved = { compaction: before.compaction, compactionThinking: before.compactionThinking, plugins: [...before.plugins] };
    try {
      if (!same(rows.compaction, saved.compaction) || rows.compactionThinking !== saved.compactionThinking) {
        const response = await fetch(apiFor(remotePeer, "compaction-model"), { method: "PUT",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: rows.compaction, thinkingLevel: rows.compactionThinking,
            expected: { model: before.compaction, thinkingLevel: before.compactionThinking }, ...(cwd ? { cwd } : {}) }), signal: scope.signal });
        const data = await readApiJson<{ model?: unknown; thinkingLevel?: unknown; error?: string }>(response);
        if (!response.ok || data.error || !("model" in data) || !("thinkingLevel" in data)) throw new Error(data.error ?? `HTTP ${response.status}`);
        saved = { ...saved, compaction: parseCompactionModel(data.model), compactionThinking: parseCompactionThinking(data.thinkingLevel) };
        snapshot.current = saved;
      }
      for (const row of rows.plugins) {
        const old = saved.plugins.find((item) => item.id === row.id);
        if (!old) continue;
        const modelChanged = !same(row.model, old.model), thinkingChanged = row.thinking !== old.thinking;
        if (!modelChanged && !thinkingChanged) continue;
        const response = await fetch(apiFor(remotePeer, "plugin-models"), { method: "PUT",
          headers: { "Content-Type": "application/json" }, signal: scope.signal,
          body: JSON.stringify({ id: row.id, revision: old.revision,
            ...(modelChanged ? { model: row.model } : {}), ...(thinkingChanged ? { thinking: row.thinking } : {}) }) });
        const data = await readApiJson<{ row?: PluginModelSettingsRow; error?: string }>(response);
        if (!response.ok || data.error || !data.row) throw new Error(data.error ?? `HTTP ${response.status}`);
        saved = { ...saved, plugins: saved.plugins.map((item) => item.id === row.id ? data.row! : item) };
        snapshot.current = saved;
      }
      if (scope.signal.aborted) return false;
      setRows(saved); setSavedOk(true); return true;
    } catch (cause) {
      if (!scope.signal.aborted) setError(`${t("pluginModels.saveFailed")}: ${cause instanceof Error ? cause.message : String(cause)}`);
      return false;
    } finally { if (!scope.signal.aborted) setSaving(false); }
  }, [cwd, loading, saving, rows, remotePeer, t]);

  useEffect(() => {
    if (!controllerRef) return;
    controllerRef.current = { isDirty, save, discard };
    return () => { controllerRef.current = null; };
  }, [controllerRef, isDirty, save, discard]);

  const disabled = loading || saving || snapshot.current === undefined;
  const updateRow = (id: string, patch: Partial<PluginModelSettingsRow>) => {
    setRows((current) => ({ ...current, plugins: current.plugins.map((row) => row.id === id ? { ...row, ...patch } : row) }));
    setSavedOk(false); setError(null);
  };
  const changeCompaction = (next: CompactionModelSelection | null) => {
    setRows((current) => ({ ...current, compaction: next })); setSavedOk(false); setError(null);
  };
  const renderModelRow = (label: string, model: CompactionModelSelection | null | "mixed", thinking: string,
    options: string[], onModel: (next: CompactionModelSelection | null) => void, onThinking?: (next: string) => void,
    autoBehavior?: "model" | "session") => {
    const selected = model && model !== "mixed" ? model : null;
    const providers = [...new Set(models.map((item) => item.provider))].sort();
    if (selected?.provider && !providers.includes(selected.provider)) providers.push(selected.provider);
    const visibleProviders = filterHiddenProviderNames(providers, hiddenModelProviders, selected?.provider);
    const choices = models.filter((item) => item.provider === selected?.provider);
    const current = choices.find((item) => item.modelId === selected?.modelId);
    const unavailable = !!selected && !current;
    const levels = current?.thinkingLevels;
    const thinkingOptions = [
      ...(options.includes("session-default") ? ["session-default"] : []),
      ...(options.includes("auto") ? ["auto"] : []),
      ...(levels ? getThinkingChoices(levels).filter((level) => level !== "auto") : ["off"]),
    ];
    const unsupported = !thinkingOptions.includes(thinking);
    if (unsupported) thinkingOptions.unshift(thinking);
    const changeModel = (next: CompactionModelSelection | null) => {
      onModel(next);
      if (!onThinking || thinking === "mixed") return;
      const fallback = options.includes("session-default") ? "session-default" : options.includes("auto") ? "auto" : "off";
      if (!next) { if (thinking !== fallback) onThinking(fallback); return; }
      const nextModel = models.find((item) => item.provider === next.provider && item.modelId === next.modelId);
      if (!nextModel?.thinkingLevels) return;
      const allowed = thinking === "session-default" || thinking === "auto" || nextModel.thinkingLevels.includes(thinking);
      if (!allowed) onThinking(options.includes("auto") ? "auto" : fallback);
    };
    return (
      <div key={label} style={{ display: "grid", gridTemplateColumns: mobile ? "repeat(2, minmax(0, 1fr))" : "minmax(100px, 0.8fr) minmax(120px, 1fr) minmax(180px, 1.5fr) minmax(112px, 0.75fr)", gap: 8, alignItems: "center", padding: "9px 0", borderBottom: "1px solid var(--border)" }}>
        <span style={{ gridColumn: mobile ? "1 / -1" : undefined, fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{label}</span>
        <ReaderFloatingSelect appearance="field" ariaLabel={`${label} ${t("modelRouting.provider")}`} containerStyle={{ minWidth: 0, width: "100%" }}
          value={model === "mixed" ? MIXED : selected && !selected.provider ? UNRESOLVED : selected?.provider ?? ""} disabled={disabled}
          options={[
            ...(model === "mixed" ? [{ value: MIXED, label: t("pluginModels.mixed"), disabled: true }] : []),
            ...(selected && !selected.provider ? [{ value: UNRESOLVED, label: t("pluginModels.unknownProvider"), disabled: true }] : []),
            { value: "", label: t("compactionModel.follow") },
            ...visibleProviders.map((provider) => ({ value: provider, label: provider })),
          ]}
          onChange={(provider) => changeModel(provider ? { provider, modelId: models.find((item) => item.provider === provider)?.modelId ?? "" } : null)} />
        <ReaderFloatingSelect appearance="field" ariaLabel={`${label} ${t("modelRouting.model")}`} containerStyle={{ minWidth: 0, width: "100%" }}
          title={current ? `${t("models.contextWindow")}: ${current.contextWindow.toLocaleString()}` : undefined}
          value={selected?.modelId ?? ""} disabled={disabled || !selected}
          options={selected ? [
            ...choices.map((item) => ({ value: item.modelId, label: item.name === item.modelId ? item.modelId : `${item.name} · ${item.modelId}` })),
            ...(unavailable ? [{ value: selected.modelId, label: selected.modelId }] : []),
          ] : [{ value: "", label: model === "mixed" ? t("pluginModels.mixed") : t("compactionModel.follow") }]}
          onChange={(modelId) => selected && changeModel({ ...selected, modelId })} />
        <ReaderFloatingSelect appearance="field" ariaLabel={`${label} ${t("pluginModels.thinking")}`} containerStyle={{ minWidth: 0, width: "100%", gridColumn: mobile ? "1 / -1" : undefined }}
          value={thinking} disabled={disabled || !onThinking || model === "mixed"}
          options={thinkingOptions.map((level) => {
            const mapped = current?.thinkingLevelMap?.[level];
            const label = level === "mixed" ? t("pluginModels.mixed")
              : level === "session-default" ? `session-default (${t("pluginModels.followSession")})`
              : level === "auto" && autoBehavior ? `auto (${t(autoBehavior === "model" ? "pluginModels.modelDefault" : "pluginModels.followSession")})`
              : mapped && mapped !== level ? `${mapped} (${level})` : level;
            return { value: level, label, disabled: level === "mixed" || (unsupported && level === thinking) };
          })}
          onChange={(level) => onThinking?.(level)} />
        {unavailable && <div style={{ gridColumn: "1 / -1" }}><ConfigNotice>{t(onThinking ? "pluginModels.modelUnavailable" : "compactionModel.unavailable")}</ConfigNotice></div>}
      </div>
    );
  };
  const isUnavailable = (model: CompactionModelSelection | null | "mixed") => !!model && model !== "mixed"
    && !models.some((item) => item.provider === model.provider && item.modelId === model.modelId);
  const compactionModel = rows.compaction && models.find((item) => item.provider === rows.compaction?.provider && item.modelId === rows.compaction?.modelId);
  const inheritedCompactionThinking = rows.compaction ? compactionModel?.thinkingLevels?.[0] ?? "off" : "session-default";
  const invalid = !!snapshot.current && (((!same(rows.compaction, snapshot.current.compaction) || rows.compactionThinking !== snapshot.current.compactionThinking) && isUnavailable(rows.compaction))
    || rows.plugins.some((row) => {
      const before = snapshot.current?.plugins.find((item) => item.id === row.id);
      return !!before && (!same(row.model, before.model) || row.thinking !== before.thinking) && isUnavailable(row.model);
    }));

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" }}>
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
        <ConfigDetailStack>
          <ConfigDetailTitle>{t("models.tabPluginModels")}</ConfigDetailTitle>
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>{t("pluginModels.description")}</p>
          {loading ? <ConfigNotice>{t("i18n.loading")}</ConfigNotice> : snapshot.current && <>
            {!mobile && <div aria-hidden="true" style={{ display: "grid", gridTemplateColumns: "minmax(100px, 0.8fr) minmax(120px, 1fr) minmax(180px, 1.5fr) minmax(112px, 0.75fr)", gap: 8, fontSize: 11, color: "var(--text-dim)" }}><span>{t("pluginModels.plugin")}</span><span>{t("modelRouting.provider")}</span><span>{t("modelRouting.model")}</span><span>{t("pluginModels.thinking")}</span></div>}
            {renderModelRow(t("compactionModel.name"), rows.compaction, rows.compactionThinking ?? inheritedCompactionThinking,
              [...(!rows.compaction ? ["session-default"] : []), ...(rows.compaction ? getThinkingChoices(undefined) : ["auto", "off"])], changeCompaction,
              (thinking) => { setRows((current) => ({ ...current, compactionThinking: thinking === "session-default" ? null : thinking as ThinkingSelection })); setSavedOk(false); setError(null); }, "model")}
            {rows.plugins.map((row) => renderModelRow(row.label, row.model, row.thinking, row.thinkingOptions,
              (model) => updateRow(row.id, { model }), (thinking) => updateRow(row.id, { thinking }), row.thinkingAutoBehavior))}
            {pluginErrors.map((row) => <div key={row.id} role="alert"><strong>{row.label}</strong>: {row.error}</div>)}
            {pluginLoadError && <ConfigNotice>{t("pluginModels.unavailable")}: {pluginLoadError}</ConfigNotice>}
            <ConfigNotice>{t("pluginModels.scope")}</ConfigNotice>
            <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>{t("compactionModel.cache")}</p>
          </>}
          {error && <div role="alert" className="config-add-source-error">{error}</div>}
          {!loading && (!snapshot.current || pluginLoadError || pluginErrors.length > 0) && <div><ConfigButton onClick={() => setRevision((value) => value + 1)}>{t("compactionModel.retry")}</ConfigButton></div>}
        </ConfigDetailStack>
      </div>
      <div className="settings-form-footer">
        <ConfigButton disabled={saving} onClick={() => { discard(); onClose(); }}>{t("settings.discardUnsaved")}</ConfigButton>
        <ConfigButton variant="primary" className={savedOk ? "is-success" : undefined}
          disabled={disabled || !isDirty() || invalid} onClick={() => void save()}>
          {savedOk ? t("i18n.saved") : saving ? t("i18n.saving") : t("i18n.save")}
        </ConfigButton>
      </div>
    </div>
  );
}
