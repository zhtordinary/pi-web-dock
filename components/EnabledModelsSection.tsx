"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { EnabledModelsView } from "@/lib/enabled-models";
import {
  enabledModelsBulkActions,
  enabledModelsProviderToggle,
  filterEnabledModels,
  findProviderView,
  isLastEnabledModel,
} from "./enabled-models-helpers";
import { ConfigButton, ConfigSwitch } from "./SettingsUi";
import { ModelContextWindow, type ModelContextSettings } from "./ModelContextWindow";

function apiFor(peer: string | undefined, path: string): string {
  if (!peer) return `/api/${path}`;
  const [route, query] = path.split("?", 2);
  return `/api/remote/${route}?${query ? query + "&" : ""}peer=${peer}`;
}

/**
 * Model switches backed by pi's `enabledModels` setting.
 *
 * Every switch writes through `/api/models/enabled` right away, like the login
 * controls in the same panel and unlike the models.json editor around them,
 * which buffers until Save. Requests are serialized: each one is a
 * read-modify-write of one settings key, so overlapping edits from the same
 * panel could otherwise lose one of them.
 */

/** Shape of `POST /api/models/refresh`, mirroring `CatalogRefreshResult`. */
interface CatalogRefreshResponse {
  completed?: boolean;
  changed?: boolean;
  reason?: "offline" | "runtime";
  error?: string;
}

interface Failure {
  /** Translation key for a known refusal. */
  messageKey?: string;
  /** Raw server text for everything else. */
  message?: string;
}

export interface EnabledModelsController {
  view: EnabledModelsView | null;
  loading: boolean;
  /** Control currently waiting on the server, or null when idle. */
  pending: string | null;
  failure: Failure | null;
  setModels: (key: string, refs: string[], enabled: boolean) => void;
  setProvider: (providerId: string, enabled: boolean) => void;
  clearScope: () => void;
  /** Re-read the current model scope after authentication or catalog changes. */
  refresh: () => void;
}

type MutationBody =
  | { op: "models"; refs: string[]; enabled: boolean }
  | { op: "provider"; provider: string; enabled: boolean }
  | { op: "clear" };

const FAILURE_KEYS: Record<string, string> = {
  "last-model": "models.enabledLastModel",
  "project-scope": "models.enabledProjectScope",
  "unverified-models": "models.enabledStaleHint",
  "unsafe-scope": "models.enabledUnsafeScope",
  "revision-conflict": "models.enabledRevisionConflict",
};

export function useEnabledModels(cwd?: string | null, peer?: string): EnabledModelsController {
  const workspaceRef = useRef({ cwd, peer, generation: 0 });
  if (workspaceRef.current.cwd !== cwd || workspaceRef.current.peer !== peer) {
    workspaceRef.current = { cwd, peer, generation: workspaceRef.current.generation + 1 };
  }
  const generation = workspaceRef.current.generation;
  const [snapshot, setSnapshot] = useState<{
    generation: number; view: EnabledModelsView | null; loading: boolean; failure: Failure | null;
  }>({ generation, view: null, loading: true, failure: null });
  const { view, loading, failure } = snapshot.generation === generation
    ? snapshot : { view: null, loading: true, failure: null };
  const [pendingState, setPendingState] = useState<{ generation: number; key: string } | null>(null);
  const pending = pendingState?.generation === generation ? pendingState.key : null;
  const pendingRef = useRef<{ generation: number; key: string } | null>(null);
  const queuedRef = useRef<{ generation: number; key: string; body: MutationBody } | null>(null);
  const mutateRef = useRef<((key: string, body: MutationBody) => void) | null>(null);
  const requestVersionRef = useRef(0);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const requestVersion = ++requestVersionRef.current;
    const isCurrent = () => !controller.signal.aborted
      && workspaceRef.current.generation === generation && requestVersionRef.current === requestVersion;
    setSnapshot((previous) => previous.generation === generation
      ? { ...previous, loading: true }
      : { generation, view: null, loading: true, failure: null });
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    fetch(apiFor(peer, `models/enabled${query}`), { signal: controller.signal })
      .then(async (res) => {
        const data = await res.json() as EnabledModelsView & { error?: string };
        if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
        if (isCurrent()) setSnapshot((previous) => previous.generation === generation
          ? { ...previous, view: data, failure: previous.failure?.messageKey === "models.enabledRevisionConflict" ? previous.failure : null } : previous);
      })
      .catch((error: unknown) => {
        if (isCurrent()) setSnapshot((previous) => previous.generation === generation
          ? { ...previous, failure: { message: error instanceof Error ? error.message : String(error) } } : previous);
      })
      .finally(() => {
        if (isCurrent()) setSnapshot((previous) => previous.generation === generation
          ? { ...previous, loading: false } : previous);
      });
    return () => controller.abort();
  }, [cwd, peer, reloadKey, generation]);

  const mutate = useCallback((key: string, body: MutationBody) => {
    const isCurrent = () => workspaceRef.current.generation === generation;
    if (!isCurrent()) return;
    if (pendingRef.current?.generation === generation) {
      queuedRef.current = { generation, key, body };
      return;
    }
    queuedRef.current = null;
    const request = { generation, key };
    pendingRef.current = request;
    setPendingState(request);
    requestVersionRef.current += 1;
    setSnapshot((previous) => previous.generation === generation
      ? { ...previous, loading: false, failure: null } : previous);
    let succeeded = false;
    void (async () => {
      try {
        const res = await fetch(apiFor(peer, "models/enabled"), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, ...(cwd ? { cwd } : {}) }),
        });
        const data = await res.json() as EnabledModelsView & { error?: string; reason?: string };
        if (!isCurrent()) return;
        requestVersionRef.current += 1;
        if (!res.ok || data.error) {
          const messageKey = data.reason ? FAILURE_KEYS[data.reason] : undefined;
          const failure = messageKey ? { messageKey } : { message: data.error ?? `HTTP ${res.status}` };
          setSnapshot((previous) => previous.generation === generation
            ? { ...previous, loading: false, failure } : previous);
          if (data.reason === "revision-conflict") setReloadKey((value) => value + 1);
          return;
        }
        succeeded = true;
        setSnapshot((previous) => previous.generation === generation
          ? { ...previous, view: data, loading: false, failure: null } : previous);
      } catch (error) {
        if (isCurrent()) {
          requestVersionRef.current += 1;
          setSnapshot((previous) => previous.generation === generation
            ? { ...previous, loading: false, failure: { message: error instanceof Error ? error.message : String(error) } } : previous);
        }
      } finally {
        if (pendingRef.current === request) {
          pendingRef.current = null;
          setPendingState((previous) => previous === request ? null : previous);
          const queued = queuedRef.current;
          if (queued?.generation === generation) {
            queuedRef.current = null;
            if (succeeded && isCurrent()) mutateRef.current?.(queued.key, queued.body);
          }
        }
      }
    })();
  }, [cwd, peer, generation]);

  mutateRef.current = mutate;

  const setModels = useCallback((key: string, refs: string[], enabled: boolean) => {
    mutate(key, { op: "models", refs, enabled });
  }, [mutate]);

  const setProvider = useCallback((providerId: string, enabled: boolean) => {
    mutate(`provider:${providerId}`, { op: "provider", provider: providerId, enabled });
  }, [mutate]);

  const clearScope = useCallback(() => mutate("clear", { op: "clear" }), [mutate]);
  const refresh = useCallback(() => setReloadKey((key) => key + 1), []);

  return { view, loading, pending, failure, setModels, setProvider, clearScope, refresh };
}

/** Panel-wide note shown while `enabledModels` narrows the selector. */
export function EnabledModelsBanner({ controller }: { controller: EnabledModelsController }) {
  const { t } = useI18n();
  const { view, pending } = controller;
  if (!view) return null;
  const scoped = !view.allEnabled;
  const stale = view.stalePatterns.length;
  if (!scoped && stale === 0) return null;

  return (
    <div className="enabled-models-banner">
      <span
        className="enabled-models-banner-text"
        {...(stale > 0 ? { title: t("models.enabledStaleHint") } : {})}
      >
        {/* Name the setting and the file that holds it: the count alone left
            the user guessing where the panel wrote, and both read the same in
            every language. A long path is what gets cut, never the numbers. */}
        <code className="enabled-models-banner-key" title={view.settingsPath}>
          {view.settingsPath}
        </code>
        <code className="enabled-models-banner-facts">
          {`· enabledModels ${view.enabledTotal}/${view.availableTotal}`}
          {stale > 0 && ` · ${t("models.enabledStale", { count: stale })}`}
        </code>
      </span>
      {view.editable && scoped && (
        <ConfigButton
          size="small"
          onClick={controller.clearScope}
          disabled={pending !== null}
          title={t("models.enabledClearHint")}
        >
          {t("models.enabledClear")}
        </ConfigButton>
      )}
    </div>
  );
}

/**
 * The single switch a models.json provider gets, for its detail header next to
 * the provider's own buttons.
 *
 * Such a provider has no rows of its own — the panel edits its models directly
 * — so this switch is the whole control, and it is checked only while every one
 * of those models is enabled. Why it cannot move is the note under the detail
 * header (`EnabledModelsProviderSwitchNote`), which the switch points at: a
 * tooltip alone never shows on a touch screen.
 */
export function EnabledModelsProviderSwitch({
  providerId,
  controller,
  noteId,
}: {
  providerId: string;
  controller: EnabledModelsController;
  /** The id `EnabledModelsProviderSwitchNote` renders under the header. */
  noteId: string;
}) {
  const { t } = useI18n();
  const { view, loading, pending, failure } = controller;
  const provider = findProviderView(view, providerId);
  const message = failure ? (failure.messageKey ? t(failure.messageKey) : failure.message) : null;
  const describedBy = providerSwitchBlockKey(controller, providerId) ? noteId : undefined;

  if (loading && !view) return null;
  if (!provider) {
    return (
      <ConfigSwitch
        checked={false}
        disabled
        label={t("models.enabledProviderToggle", { provider: providerId })}
        describedBy={describedBy}
        onChange={() => {}}
      />
    );
  }

  const toggle = enabledModelsProviderToggle(view, provider);
  return (
    <>
      {message && <span role="alert" className="enabled-models-switch-error">{message}</span>}
      <ConfigSwitch
        checked={toggle.checked}
        loading={pending === `provider:${provider.id}`}
        disabled={pending !== null || toggle.blocked}
        label={t("models.enabledProviderToggle", { provider: provider.name })}
        describedBy={describedBy}
        onChange={(checked) => controller.setProvider(provider.id, checked)}
      />
    </>
  );
}

/** Why a models.json provider's switch cannot move, as a message key, or null while it can or is not shown. */
function providerSwitchBlockKey(controller: EnabledModelsController, providerId: string): string | null {
  const { view, loading } = controller;
  if (loading && !view) return null;
  const provider = findProviderView(view, providerId);
  // Missing from the runtime: edits not saved yet, no models, or a key that
  // does not work — never a sign-in, so do not send the user looking for one.
  if (!provider) return "models.enabledCustomEmpty";
  const { reason } = enabledModelsProviderToggle(view, provider);
  return reason ? FAILURE_KEYS[reason] : null;
}

/** The note under a models.json provider's detail header saying why its switch cannot move. */
export function EnabledModelsProviderSwitchNote({
  providerId,
  controller,
  id,
}: {
  providerId: string;
  controller: EnabledModelsController;
  id: string;
}) {
  const { t } = useI18n();
  const key = providerSwitchBlockKey(controller, providerId);
  return key ? <div id={id} className="config-detail-heading-note">{t(key)}</div> : null;
}

/** Per-model switches for a provider that owns its own model list. */
/**
 * State for the "refresh catalog" button.
 *
 * pi's built-in model lists are frozen at the SDK version pi-web pins, so a
 * model a provider shipped after that release only appears once the pi.dev
 * catalog overlay has been fetched — see `lib/model-catalog-refresh.ts` (#914).
 * The button is the whole feature: nothing refreshes catalogs on its own.
 */
function useCatalogRefresh(providerId: string, onChanged: () => void, peer?: string) {
  const [refreshing, setRefreshing] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // A note describes the provider it was produced for, never the next one.
  useEffect(() => setNote(null), [providerId]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    setNote(null);
    void (async () => {
      try {
        const res = await fetch(apiFor(peer, "models/refresh"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: providerId }),
        });
        const data = await res.json() as CatalogRefreshResponse;
        if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
        if (data.reason === "offline") setNote("models.catalogOffline");
        else if (!data.completed) setNote("models.catalogUnreachable");
        else setNote(data.changed ? "models.catalogUpdated" : "models.catalogUnchanged");
        // Reload even when nothing moved for this provider: the pass may have
        // updated another one, and a stale panel is worse than a second read.
        if (data.changed) onChanged();
      } catch {
        setNote("models.catalogUnreachable");
      } finally {
        setRefreshing(false);
      }
    })();
  }, [providerId, onChanged, peer]);

  return { refreshing, note, refresh };
}

export function EnabledModelsSection({
  providerId,
  controller,
  peer,
  contextSettings,
  onImportModels,
  importingModels,
  importError,
  importedModelsCount,
}: {
  providerId: string;
  controller: EnabledModelsController;
  peer?: string;
  contextSettings?: ModelContextSettings;
  onImportModels?: () => void;
  importingModels?: boolean;
  importError?: string | null;
  importedModelsCount?: number | null;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const { view, loading, pending, failure } = controller;
  const provider = findProviderView(view, providerId);
  const catalog = useCatalogRefresh(providerId, controller.refresh, peer);
  const noteId = useId();

  useEffect(() => setQuery(""), [providerId]);

  if (loading && !view) {
    return <div className="enabled-models-empty">{t("agents.modelsLoading")}</div>;
  }
  if (!provider) {
    return failure?.message
      ? <div className="enabled-models-error">{failure.message}</div>
      : <div className="enabled-models-empty">{t("models.enabledUnavailable")}</div>;
  }

  const shown = filterEnabledModels(provider.models, query);
  const bulk = enabledModelsBulkActions(view, shown);
  const filtered = shown.length !== provider.models.length;
  const busy = pending !== null;
  const bulkKey = `provider:${provider.id}`;
  // Why switches cannot move is visible text they point at: a tooltip never shows on a touch screen.
  const editable = view?.editable === true;
  const scopeNoteId = `${noteId}-scope`;
  const lastModelNoteId = `${noteId}-last`;
  const contextNoteId = `${noteId}-context`;
  const disableBlockedByLastModel = editable && !bulk.canDisable && bulk.disableRefs.length > 0;
  const showLastModelNote = disableBlockedByLastModel || (editable && shown.some((model) => isLastEnabledModel(view, model)));
  // A provider-wide action is resolved server-side so models the browser has
  // not seen yet follow it too; a filtered action names its rows explicitly.
  const runBulk = (enabled: boolean, refs: string[]) => {
    if (filtered) controller.setModels(bulkKey, refs, enabled);
    else controller.setProvider(provider.id, enabled);
  };

  return (
    <div className="enabled-models-section">
      <div className="enabled-models-header">
        <span className="enabled-models-title">{t("models.enabledSection")}</span>
        <span className="enabled-models-count">
          {t("models.enabledCount", { enabled: provider.enabledCount, total: provider.models.length })}
        </span>
        <ConfigButton
          size="small"
          disabled={busy || !bulk.canEnable}
          aria-describedby={editable ? undefined : scopeNoteId}
          onClick={() => runBulk(true, bulk.enableRefs)}
        >
          {filtered ? t("models.enableShown") : t("models.enableAll")}
        </ConfigButton>
        <ConfigButton
          size="small"
          disabled={busy || !bulk.canDisable}
          aria-describedby={!editable ? scopeNoteId : disableBlockedByLastModel ? lastModelNoteId : undefined}
          onClick={() => runBulk(false, bulk.disableRefs)}
        >
          {filtered ? t("models.disableShown") : t("models.disableAll")}
        </ConfigButton>
        {onImportModels && (
          <ConfigButton
            size="small"
            disabled={busy || importingModels || catalog.refreshing}
            onClick={onImportModels}
          >
            {importingModels ? t("models.managedRefreshing") : t("models.managedRefresh")}
          </ConfigButton>
        )}
        <ConfigButton
          size="small"
          disabled={busy || catalog.refreshing || importingModels}
          title={t("models.refreshCatalogHint")}
          onClick={catalog.refresh}
        >
          {catalog.refreshing ? t("models.refreshingCatalog") : t("models.refreshCatalog")}
        </ConfigButton>
      </div>

      {catalog.note && <div className="enabled-models-note">{t(catalog.note)}</div>}
      {importError && <div className="enabled-models-error">{importError}</div>}
      {importedModelsCount !== undefined && importedModelsCount !== null ? (
        <div className="enabled-models-note">{t("models.managedImported", { count: importedModelsCount })}</div>
      ) : null}

      {!editable && <div id={scopeNoteId} className="enabled-models-note">{t("models.enabledProjectScope")}</div>}
      {showLastModelNote && <div id={lastModelNoteId} className="enabled-models-note">{t("models.enabledLastModel")}</div>}
      {failure && (
        <div role="alert" className="enabled-models-error">
          {failure.messageKey ? t(failure.messageKey) : failure.message}
        </div>
      )}

      {provider.models.length > 8 && (
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("models.enabledFilterPlaceholder", { count: provider.models.length })}
          aria-label={t("models.enabledFilter")}
          className="enabled-models-filter"
        />
      )}
      {contextSettings && <div id={contextNoteId} className="enabled-models-note">{t("models.contextOverrideHelp")}</div>}
      <div className="enabled-models-list">
        {shown.length === 0 ? (
          <div className="enabled-models-empty">{t("models.enabledNoMatches")}</div>
        ) : shown.map((model) => {
          const lastOne = isLastEnabledModel(view, model);
          const override = contextSettings?.overrides?.[model.id];
          const contextValue = override && typeof override === "object" && !Array.isArray(override)
            ? (override as Record<string, unknown>).contextWindow : undefined;
          return (
            <div key={model.ref} className="enabled-models-row">
              <span className="enabled-models-row-text">
                <span className="enabled-models-row-name" title={model.name}>{model.name}</span>
                {model.name !== model.id && (
                  <code className="enabled-models-row-id" title={model.id}>{model.id}</code>
                )}
              </span>
              {model.thinkingPin && (
                <span className="enabled-models-pin" title={t("models.enabledPinHint")}>
                  {model.thinkingPin}
                </span>
              )}
              {contextSettings && (
                <ModelContextWindow
                  modelName={model.name}
                  effective={model.contextWindow}
                  value={contextValue}
                  disabled={contextSettings.disabled}
                  describedBy={contextNoteId}
                  onChange={(value) => contextSettings.onChange(model.id, value)}
                />
              )}
              <ConfigSwitch
                checked={model.enabled}
                loading={pending === model.ref}
                disabled={busy || !view?.editable || lastOne}
                label={t("models.enabledToggle", { model: model.name })}
                describedBy={!editable ? scopeNoteId : lastOne ? lastModelNoteId : undefined}
                onChange={(checked) => controller.setModels(model.ref, [model.ref], checked)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
