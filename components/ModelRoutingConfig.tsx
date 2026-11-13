"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ChevronDown, ChevronUp, GitFork, GripVertical, Loader2, Plus, Trash2, X, Zap } from "lucide-react";
import { useI18n } from "@/hooks/useI18n";
import { sendAgentCommand } from "@/lib/agent-client";
import {
  DEFAULT_ROUTE_MAX_ATTEMPTS,
  MAX_ROUTE_MAX_ATTEMPTS,
  normalizeRouteMaxAttempts,
} from "@/lib/model-routing-shared";
import type { ModelRouteItem, ModelRoutingConfig } from "@/lib/model-routing";
import type { SessionActivityResponse } from "@/lib/session-activity-types";
import type { SettingsPanelController } from "./UnifiedSettingsModal";
import { ReaderFloatingSelect } from "./ReaderFloatingSelect";
import { ConfigButton, ConfigSwitch } from "./SettingsUi";
import { useHiddenModelProviders } from "@/hooks/useHiddenModelProviders";
import { filterHiddenProviderNames } from "@/lib/model-visibility-preference";

function apiFor(peer: string | undefined, path: string): string {
  if (!peer) return `/api/${path}`;
  const [route, query] = path.split("?", 2);
  return `/api/remote/${route}?${query ? query + "&" : ""}peer=${peer}`;
}

export interface ModelRoutingConfigProps {
  remotePeer?: string;
  providers: Record<string, { models?: Array<{ id: string; name?: string }> | string[] }>;
  availableModels?: Array<{ id: string; provider: string }>;
  onClose: () => void;
  onSaved?: () => void;
  controllerRef?: React.MutableRefObject<SettingsPanelController | null>;
}

export function getRoutingProviderNames(
  providers: ModelRoutingConfigProps["providers"],
  availableModels: readonly { id: string; provider: string }[] = [],
): string[] {
  const names = new Set(Object.keys(providers ?? {}));
  for (const model of availableModels) {
    if (model.provider) names.add(model.provider);
  }
  return [...names];
}

export function getRoutingModelIds(
  providerName: string,
  provider: ModelRoutingConfigProps["providers"][string] | undefined,
  availableModels: readonly { id: string; provider: string }[] = [],
): string[] {
  const configuredModels = Array.isArray(provider?.models)
    ? provider.models.map((model) => (typeof model === "string" ? model : model.id))
    : [];
  const discoveredModels = availableModels
    .filter((model) => model.provider === providerName)
    .map((model) => model.id);
  return [...new Set([...configuredModels, ...discoveredModels])];
}

const THINKING_LEVEL_OPTIONS: Array<{ value: string; labelKey: string }> = [
  { value: "max", labelKey: "thinkingLevel.max" },
  { value: "xhigh", labelKey: "thinkingLevel.xhigh" },
  { value: "high", labelKey: "thinkingLevel.high" },
  { value: "medium", labelKey: "thinkingLevel.medium" },
  { value: "low", labelKey: "thinkingLevel.low" },
  { value: "minimal", labelKey: "thinkingLevel.minimal" },
  { value: "off", labelKey: "thinkingLevel.off" },
];

const ROUTE_FIELD_STYLE: CSSProperties = {
  boxSizing: "border-box",
  width: "100%",
  minWidth: 0,
  height: 30,
  fontFamily: "inherit",
  fontSize: 12,
  lineHeight: "18px",
  padding: "5px 8px",
  borderRadius: 5,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--text)",
};
const ROUTE_DRAG_TYPE = "application/x-reader-model-route";

export function reorderModelRoutes(
  routes: ModelRouteItem[],
  draggedId: string,
  targetId: string,
  before: boolean,
): ModelRouteItem[] {
  const sourceIndex = routes.findIndex((route) => route.id === draggedId);
  if (sourceIndex < 0 || draggedId === targetId || !routes.some((route) => route.id === targetId)) return routes;
  const next = [...routes];
  const [moved] = next.splice(sourceIndex, 1);
  const targetIndex = next.findIndex((route) => route.id === targetId);
  next.splice(targetIndex + (before ? 0 : 1), 0, moved);
  return next.every((route, index) => route === routes[index]) ? routes : next;
}

export function ModelRoutingConfig({
  remotePeer,
  providers,
  availableModels,
  onClose,
  onSaved,
  controllerRef,
}: ModelRoutingConfigProps) {
  const { t } = useI18n();
  const hiddenModelProviders = useHiddenModelProviders();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [enabled, setEnabled] = useState(false);
  const [routes, setRoutes] = useState<ModelRouteItem[]>([]);
  const savedSnapshotRef = useRef<{ enabled: boolean; routes: ModelRouteItem[] } | null>(null);
  const draggedRouteRef = useRef<{ id: string; peer: string | undefined } | null>(null);
  const [routeDropTarget, setRouteDropTarget] = useState<{ id: string; before: boolean } | null>(null);

  useEffect(() => {
    draggedRouteRef.current = null;
    setRouteDropTarget(null);
  }, [loading, remotePeer, saving]);

  const [nonIdleCount, setNonIdleCount] = useState<number | null>(null);
  const [switchingRouteId, setSwitchingRouteId] = useState<string | null>(null);
  const [switchProgress, setSwitchProgress] = useState<string | null>(null);
  const [switchResult, setSwitchResult] = useState<{ type: "success" | "warning" | "error"; message: string } | null>(null);

  const refreshNonIdleCount = useCallback(async () => {
    try {
      const res = await fetch("/api/session-runs?scope=all", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as SessionActivityResponse;
      if (Array.isArray(data.sessions)) {
        const count = data.sessions.filter((s) => s.status && s.status !== "idle").length;
        setNonIdleCount(count);
      }
    } catch {
      // non-critical
    }
  }, []);

  useEffect(() => {
    void refreshNonIdleCount();
  }, [refreshNonIdleCount]);

  const handleSwitchNonIdleSessions = useCallback(
    async (route: ModelRouteItem) => {
      if (!route.provider || !route.model) {
        setSwitchResult({
          type: "error",
          message: t("modelRouting.incompleteRoute"),
        });
        return;
      }
      const routeKey = route.id || `${route.provider}-${route.model}`;
      setSwitchingRouteId(routeKey);
      setSwitchProgress(t("modelRouting.scanning"));
      setSwitchResult(null);

      try {
        const res = await fetch("/api/session-runs?scope=all", { cache: "no-store" });
        if (!res.ok) throw new Error(t("modelRouting.listFailed", { status: res.status }));
        const data = (await res.json()) as SessionActivityResponse;
        const allSessions = data.sessions ?? [];
        const localDeviceId = data.device?.id;

        const targetSessions = allSessions.filter((s) => s.status && s.status !== "idle");
        if (targetSessions.length === 0) {
          setNonIdleCount(0);
          setSwitchResult({
            type: "warning",
            message: t("modelRouting.noNonIdle"),
          });
          return;
        }

        setNonIdleCount(targetSessions.length);
        let succeeded = 0;
        let failed = 0;

        for (let i = 0; i < targetSessions.length; i++) {
          const item = targetSessions[i];
          setSwitchProgress(t("modelRouting.switchingProgress", { current: i + 1, total: targetSessions.length }));
          const isLocal = !item.device?.id || item.device.id === localDeviceId;
          const peer = isLocal ? undefined : item.device?.id;

          try {
            await sendAgentCommand(
              item.session.id,
              {
                type: "set_model",
                provider: route.provider,
                modelId: route.model,
                thinkingLevel: route.thinkingLevel || undefined,
              },
              peer,
            );
            if (route.thinkingLevel) {
              try {
                await sendAgentCommand(
                  item.session.id,
                  { type: "set_thinking_level", level: route.thinkingLevel },
                  peer,
                );
              } catch {
                // ignore thinking level failure if unsupported
              }
            }
            succeeded++;
          } catch (err) {
            console.error(`Failed to switch model for session ${item.session.id}:`, err);
            failed++;
          }
        }

        void refreshNonIdleCount();

        if (failed === 0) {
          setSwitchResult({
            type: "success",
            message: t("modelRouting.switchSucceeded", { count: succeeded, provider: route.provider, model: route.model, thinking: route.thinkingLevel || t("modelRouting.defaultThinking") }),
          });
        } else {
          setSwitchResult({
            type: "warning",
            message: t("modelRouting.switchPartial", { succeeded, failed, provider: route.provider, model: route.model }),
          });
        }
      } catch (err) {
        setSwitchResult({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setSwitchingRouteId(null);
        setSwitchProgress(null);
      }
    },
    [refreshNonIdleCount, t],
  );

  const providerNames = useMemo(
    () => getRoutingProviderNames(providers ?? {}, availableModels ?? []),
    [availableModels, providers],
  );
  const selectableProviderNames = useMemo(
    () => filterHiddenProviderNames(providerNames, hiddenModelProviders),
    [hiddenModelProviders, providerNames],
  );

  const getModelsForProvider = useCallback(
    (providerName: string): string[] => getRoutingModelIds(providerName, providers?.[providerName], availableModels ?? []),
    [availableModels, providers],
  );

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const res = await fetch(apiFor(remotePeer, "model-routing"));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as ModelRoutingConfig;
        if (!cancelled) {
          const nextSnapshot = {
            enabled: Boolean(data.enabled),
            routes: Array.isArray(data.routes)
              ? data.routes.map((route) => ({
                  ...route,
                  maxAttempts: normalizeRouteMaxAttempts(route.maxAttempts),
                }))
              : [],
          };
          savedSnapshotRef.current = nextSnapshot;
          setEnabled(nextSnapshot.enabled);
          setRoutes(nextSnapshot.routes);
        }
      } catch (err) {
        if (!cancelled) {
          setSaveError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [remotePeer]);

  const handleAddRoute = useCallback(() => {
    const firstProv = selectableProviderNames[0] || "";
    const models = getModelsForProvider(firstProv);
    const firstModel = models[0] || "";
    const newRoute: ModelRouteItem = {
      id: `route-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      provider: firstProv,
      model: firstModel,
      thinkingLevel: "max",
      maxAttempts: DEFAULT_ROUTE_MAX_ATTEMPTS,
    };
    setRoutes((prev) => [...prev, newRoute]);
  }, [getModelsForProvider, selectableProviderNames]);

  const handleUpdateRoute = useCallback(
    (index: number, patch: Partial<ModelRouteItem>) => {
      setRoutes((prev) => {
        const next = [...prev];
        const current = next[index];
        if (!current) return prev;
        const updated = {
          ...current,
          ...patch,
          ...(patch.maxAttempts !== undefined
            ? { maxAttempts: normalizeRouteMaxAttempts(patch.maxAttempts) }
            : {}),
        };
        if (patch.provider && patch.provider !== current.provider) {
          const available = getModelsForProvider(patch.provider);
          if (!available.includes(updated.model)) {
            updated.model = available[0] || "";
          }
        }
        next[index] = updated;
        return next;
      });
    },
    [getModelsForProvider],
  );

  const handleDeleteRoute = useCallback((index: number) => {
    setRoutes((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleMoveRoute = useCallback((index: number, delta: number) => {
    setRoutes((prev) => {
      const source = prev[index];
      const target = prev[index + delta];
      return source && target ? reorderModelRoutes(prev, source.id, target.id, delta < 0) : prev;
    });
  }, []);

  const handleRouteDrop = useCallback((event: React.DragEvent<HTMLDivElement>, targetId: string) => {
    const dragged = draggedRouteRef.current;
    draggedRouteRef.current = null;
    setRouteDropTarget(null);
    if (loading || saving || !dragged || dragged.peer !== remotePeer
      || event.dataTransfer.getData(ROUTE_DRAG_TYPE) !== dragged.id) return;
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const before = event.clientY < bounds.top + bounds.height / 2;
    setRoutes((current) => reorderModelRoutes(current, dragged.id, targetId, before));
  }, [loading, remotePeer, saving]);

  const isDirty = useCallback(() => {
    if (!savedSnapshotRef.current) return false;
    if (enabled !== savedSnapshotRef.current.enabled) return true;
    return JSON.stringify(routes) !== JSON.stringify(savedSnapshotRef.current.routes);
  }, [enabled, routes]);

  const discard = useCallback(() => {
    if (!savedSnapshotRef.current) return;
    setEnabled(savedSnapshotRef.current.enabled);
    try {
      setRoutes(JSON.parse(JSON.stringify(savedSnapshotRef.current.routes)));
    } catch {
      setRoutes([...savedSnapshotRef.current.routes]);
    }
    setSaveError(null);
  }, []);

  const handleSave = useCallback(async (): Promise<boolean> => {
    setSaving(true);
    setSaveError(null);
    setSavedOk(false);
    try {
      const res = await fetch(apiFor(remotePeer, "model-routing"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, routes }),
      });
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || data.error) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const normalizedRoutes = routes.map((route) => ({
        ...route,
        maxAttempts: normalizeRouteMaxAttempts(route.maxAttempts),
      }));
      savedSnapshotRef.current = { enabled, routes: JSON.parse(JSON.stringify(normalizedRoutes)) };
      setRoutes(normalizedRoutes);
      setSavedOk(true);
      onSaved?.();
      setTimeout(() => setSavedOk(false), 2000);
      return true;
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSaving(false);
    }
  }, [enabled, routes, remotePeer, onSaved]);

  useEffect(() => {
    if (!controllerRef) return;
    controllerRef.current = {
      isDirty,
      save: handleSave,
      discard,
    };
    return () => {
      controllerRef.current = null;
    };
  }, [controllerRef, isDirty, handleSave, discard]);

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
      {/* Scrollable content area */}
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
        {/* Switch Card */}
        <div
          style={{
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "14px 16px",
            marginBottom: 16,
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 16,
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <GitFork size={16} strokeWidth={2} style={{ color: "var(--accent)" }} />
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
                {t("modelRouting.enable")}
              </span>
            </div>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5, whiteSpace: "pre-line" }}>
              {t("modelRouting.desc")}
            </p>
          </div>
          <ConfigSwitch
            checked={enabled}
            label={t("modelRouting.enable")}
            onChange={setEnabled}
          />
        </div>

        {/* Section title */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              {t("modelRouting.priorityList")}
            </span>
            {nonIdleCount !== null && (
              <span
                style={{
                  fontSize: 11,
                  padding: "1px 6px",
                  borderRadius: 10,
                  background: nonIdleCount > 0 ? "rgba(234, 179, 8, 0.12)" : "var(--bg-panel)",
                  color: nonIdleCount > 0 ? "#ca8a04" : "var(--text-muted)",
                  border: `1px solid ${nonIdleCount > 0 ? "rgba(234, 179, 8, 0.3)" : "var(--border)"}`,
                }}
                title={t("modelRouting.nonIdleCountTitle")}
              >
                {t("modelRouting.nonIdleCount", { count: nonIdleCount })}
              </span>
            )}
          </div>
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
            {t("modelRouting.routeCount", { count: routes.length })}
          </span>
        </div>

        {/* Switch result alert */}
        {switchResult && (
          <div
            style={{
              background:
                switchResult.type === "success"
                  ? "rgba(22, 163, 74, 0.12)"
                  : switchResult.type === "warning"
                    ? "rgba(234, 179, 8, 0.12)"
                    : "rgba(239, 68, 68, 0.12)",
              border: `1px solid ${
                switchResult.type === "success"
                  ? "rgba(22, 163, 74, 0.35)"
                  : switchResult.type === "warning"
                    ? "rgba(234, 179, 8, 0.35)"
                    : "rgba(239, 68, 68, 0.35)"
              }`,
              borderRadius: 6,
              padding: "8px 12px",
              marginBottom: 12,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              fontSize: 12,
              color:
                switchResult.type === "success"
                  ? "#16a34a"
                  : switchResult.type === "warning"
                    ? "#ca8a04"
                    : "#dc2626",
            }}
          >
            <span style={{ flex: 1 }}>{switchResult.message}</span>
            <button
              type="button"
              onClick={() => setSwitchResult(null)}
              style={{
                background: "none",
                border: "none",
                padding: 2,
                cursor: "pointer",
                color: "inherit",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
              title={t("modelRouting.dismissNotice")}
            >
              <X size={14} />
            </button>
          </div>
        )}

        {/* Routes list */}
        {loading ? (
          <div style={{ padding: "30px 0", textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
            {t("i18n.loading")}
          </div>
        ) : routes.length === 0 ? (
          <div
            style={{
              border: "1px dashed var(--border)",
              borderRadius: 8,
              padding: "28px 20px",
              textAlign: "center",
              color: "var(--text-muted)",
              fontSize: 13,
              marginBottom: 16,
            }}
          >
            {t("modelRouting.empty")}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
            {routes.map((route, index) => {
              const currentModels = getModelsForProvider(route.provider);
              const routeProviderNames = filterHiddenProviderNames(providerNames, hiddenModelProviders, route.provider);
              const routeProviderOptions = [
                ...routeProviderNames.map((provider) => ({ value: provider, label: provider })),
                ...(route.provider && !routeProviderNames.includes(route.provider)
                  ? [{ value: route.provider, label: route.provider }]
                  : []),
              ];
              return (
                <div
                  key={route.id || index}
                  onDragOver={(event) => {
                    const dragged = draggedRouteRef.current;
                    if (loading || saving || !dragged || dragged.peer !== remotePeer || dragged.id === route.id
                      || !Array.from(event.dataTransfer.types).includes(ROUTE_DRAG_TYPE)) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    const bounds = event.currentTarget.getBoundingClientRect();
                    const before = event.clientY < bounds.top + bounds.height / 2;
                    setRouteDropTarget((current) => current?.id === route.id && current.before === before ? current : { id: route.id, before });
                  }}
                  onDragLeave={(event) => {
                    if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setRouteDropTarget(null);
                  }}
                  onDrop={(event) => handleRouteDrop(event, route.id)}
                  style={{
                    background: "var(--bg-panel)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    padding: "12px 14px",
                    display: "flex",
                    flexDirection: "column",
                    gap: 10,
                    boxShadow: routeDropTarget?.id === route.id
                      ? `inset 0 ${routeDropTarget.before ? "2px" : "-2px"} 0 var(--accent)`
                      : undefined,
                  }}
                >
                  {/* Top bar of item */}
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                    <div
                      draggable={!saving}
                      title={t("modelRouting.dragToReorder")}
                      onDragStart={(event) => {
                        if (saving || loading) { event.preventDefault(); return; }
                        draggedRouteRef.current = { id: route.id, peer: remotePeer };
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData(ROUTE_DRAG_TYPE, route.id);
                      }}
                      onDragEnd={() => { draggedRouteRef.current = null; setRouteDropTarget(null); }}
                      style={{ display: "flex", alignItems: "center", gap: 8, cursor: saving ? "default" : "grab" }}
                    >
                      <GripVertical size={14} aria-hidden="true" style={{ color: "var(--text-dim)" }} />
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          padding: "2px 7px",
                          borderRadius: 4,
                          background: "var(--border)",
                          color: "var(--text-muted)",
                        }}
                      >
                        {t("modelRouting.routeIndex", { index: index + 1 })}
                      </span>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                        {route.provider || t("modelRouting.noProviderSelected")}
                      </span>
                    </div>
                    {/* Action buttons: Switch non-idle sessions, Up, Down, Delete */}
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <ConfigButton size="small"
                        type="button"
                        disabled={switchingRouteId !== null || !route.provider || !route.model}
                        onClick={() => void handleSwitchNonIdleSessions(route)}
                        title={t("modelRouting.applyToNonIdleHint")}
                      >
                        {(route.id === switchingRouteId || `${route.provider}-${route.model}` === switchingRouteId) ? (
                          <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} />
                        ) : (
                          <Zap size={12} strokeWidth={2.2} />
                        )}
                        <span>
                          {(route.id === switchingRouteId || `${route.provider}-${route.model}` === switchingRouteId)
                            ? (switchProgress || t("modelRouting.switching"))
                            : t("modelRouting.applyToNonIdle")}
                        </span>
                      </ConfigButton>
                      <ConfigButton size="small" className="config-button-icon"
                        type="button"
                        disabled={index === 0}
                        onClick={() => handleMoveRoute(index, -1)}
                        title={t("chat.moveUp")}
                      >
                        <ChevronUp size={13} strokeWidth={2} />
                      </ConfigButton>
                      <ConfigButton size="small" className="config-button-icon"
                        type="button"
                        disabled={index === routes.length - 1}
                        onClick={() => handleMoveRoute(index, 1)}
                        title={t("chat.moveDown")}
                      >
                        <ChevronDown size={13} strokeWidth={2} />
                      </ConfigButton>
                      <ConfigButton variant="danger" size="small" className="config-button-icon"
                        type="button"
                        onClick={() => handleDeleteRoute(index)}
                        title={t("i18n.delete")}
                      >
                        <Trash2 size={13} strokeWidth={2} />
                      </ConfigButton>
                    </div>
                  </div>

                  {/* Form fields */}
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                      gap: 10,
                    }}
                  >
                    {/* Provider Select */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <label style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("modelRouting.provider") || "Provider"}</label>
                      <ReaderFloatingSelect
                        value={route.provider}
                        onChange={(val) => handleUpdateRoute(index, { provider: val })}
                        options={
                          routeProviderOptions.length === 0
                            ? [{ value: "", label: t("modelRouting.noProvider") }]
                            : routeProviderOptions
                        }
                        ariaLabel={t("modelRouting.provider") || "Provider"}
                        placement="below"
                        containerStyle={{ width: "100%" }}
                        triggerStyle={{
                          ...ROUTE_FIELD_STYLE,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 6,
                          cursor: "pointer",
                          boxSizing: "border-box",
                        }}
                      />
                    </div>

                    {/* Model Select */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <label style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("modelRouting.model")}</label>
                      <ReaderFloatingSelect
                        value={route.model}
                        onChange={(val) => handleUpdateRoute(index, { model: val })}
                        options={
                          currentModels.length === 0
                            ? [{ value: "", label: route.model || t("modelRouting.noModel") }]
                            : [
                                ...currentModels.map((m) => ({ value: m, label: m })),
                                ...(route.model && !currentModels.includes(route.model)
                                  ? [{ value: route.model, label: route.model }]
                                  : []),
                              ]
                        }
                        ariaLabel={t("modelRouting.model")}
                        placement="below"
                        containerStyle={{ width: "100%" }}
                        triggerStyle={{
                          ...ROUTE_FIELD_STYLE,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 6,
                          cursor: "pointer",
                          boxSizing: "border-box",
                        }}
                      />
                    </div>

                    {/* Thinking Level Select */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <label style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("modelRouting.thinkingLevel")}</label>
                      <ReaderFloatingSelect
                        value={route.thinkingLevel}
                        onChange={(val) => handleUpdateRoute(index, { thinkingLevel: val })}
                        options={THINKING_LEVEL_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
                        ariaLabel={t("modelRouting.thinkingLevel")}
                        placement="below"
                        containerStyle={{ width: "100%" }}
                        triggerStyle={{
                          ...ROUTE_FIELD_STYLE,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 6,
                          cursor: "pointer",
                          boxSizing: "border-box",
                        }}
                      />
                    </div>

                    {/* Retry attempts before moving to the next route */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <label style={{ fontSize: 11, color: "var(--text-dim)" }}>
                        {t("modelRouting.attempts")}
                      </label>
                      <input
                        type="number"
                        min={1}
                        max={MAX_ROUTE_MAX_ATTEMPTS}
                        step={1}
                        value={route.maxAttempts ?? DEFAULT_ROUTE_MAX_ATTEMPTS}
                        onChange={(e) => handleUpdateRoute(index, { maxAttempts: Number(e.target.value) })}
                        title={t("modelRouting.attemptsHint")}
                        style={ROUTE_FIELD_STYLE}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Add route button */}
        <ConfigButton className="config-button-add"
          type="button"
          onClick={handleAddRoute}
        >
          <Plus size={13} strokeWidth={2} />
          <span>{t("modelRouting.addRoute")}</span>
        </ConfigButton>
      </div>

      {/* Bottom Footer */}
      <div className="settings-form-footer">
        {saveError && <span style={{ minWidth: 0, flex: 1, overflowWrap: "anywhere", fontSize: 12, color: "#f87171" }}>{saveError}</span>}
        <ConfigButton
          type="button"
          onClick={() => {
            discard();
            onClose();
          }}
          title={t("settings.discardUnsavedHint")}
        >
          {t("settings.discardUnsaved")}
        </ConfigButton>
        <ConfigButton className={savedOk ? "is-success" : undefined} variant="primary"
          type="button"
          onClick={handleSave}
          disabled={saving || savedOk}
        >
          {savedOk && (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ strokeDasharray: 18, animation: "saved-check-draw 0.35s ease forwards", flexShrink: 0 }}
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
          <span>{savedOk ? t("i18n.saved") : saving ? t("i18n.saving") : t("i18n.save")}</span>
        </ConfigButton>
      </div>
    </div>
  );
}
