// Image-generation settings sections (Reader local patch).
// Rendered inside the ModelsConfig panel tabs; also wrapped by ImageGenConfig
// as a standalone modal. Most changes auto-save; output-directory edits use
// explicit Save/Cancel so changing scope cannot be swallowed by input blur.
// onChanged fires after each successful write so the hosting panel can show a
// "saved" toast on close.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Eye, EyeOff, FolderOpen, Image as ImageIcon, ImagePlus, Pencil, Plus, Server, Trash2, Undo2, X } from "lucide-react";
import { useI18n } from "@/hooks/useI18n";
import { ConfigButton, ConfigScopeTag } from "./SettingsUi";
import { ImageGenerationPrice } from "./ImageGenerationPrice";
import type { GenCapability } from "@/lib/gen-capabilities";

function apiFor(peer: string | undefined, path: string): string {
  if (!peer) return `/api/${path}`;
  const [route, query] = path.split("?", 2);
  return `/api/remote/${route}?${query ? query + "&" : ""}peer=${peer}`;
}

interface ImageGenState {
  enabled: boolean;
  genProvider: string | null;
  genModelId: string | null;
  genBackend: string;
  genVersion?: "flare" | "sunburst" | null;
  /** True when generation is enabled but the effective model can't work. */
  genInvalid?: boolean;
  outputDir: string;
  outputDirGlobal: string;
  outputDirProject: string | null;
  outputDirScope: "project" | "global";
  providers: Record<string, {
    models: string[];
    baseUrl?: string;
    apiKey?: string;
    apiKeyConfigured?: boolean;
    backend?: "sync" | "async-task" | "chat-completions";
  }>;
  /** Per-model size/quality options and provider-specific notes. */
  capabilities?: Record<string, GenCapability>;
}

type OutputDirScope = "project" | "global";

export const GEN_CONFIG_CHANGED_EVENT = "pi-web:image-gen-config-changed";

const SECTION_TITLE: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 6,
  padding: "12px 18px 7px",
  fontSize: 11,
  fontWeight: 600,
  color: "var(--text-dim)",
  textTransform: "uppercase",
  letterSpacing: "0.07em",
  borderTop: "1px solid var(--border)",
  marginTop: 8,
};

const inputStyle: React.CSSProperties = {
  flex: 1, minWidth: 0, fontSize: 12, fontFamily: "var(--font-mono)",
  padding: "4px 8px", border: "1px solid var(--border)", borderRadius: 4,
  background: "var(--bg)", color: "var(--text)",
};

export function ImageGenSections({
  sessionFile,
  cwd,
  onChanged,
  remotePeer,
}: {
  sessionFile?: string;
  cwd?: string;
  onChanged?: () => void;
  remotePeer?: string;
}) {
  const { t } = useI18n();
  const [gen, setGen] = useState<ImageGenState | null>(null);
  const [editingDir, setEditingDir] = useState(false);
  const [dirDraft, setDirDraft] = useState("");
  // Scope shown in the read-only view. Null follows the effective config on
  // first load or when the active project changes; choosing a scope never writes.
  const [selectedDirScope, setSelectedDirScope] = useState<OutputDirScope | null>(null);
  // Scope applied on the next output-dir save.
  const [dirScope, setDirScope] = useState<OutputDirScope>("global");
  const [editingProvider, setEditingProvider] = useState<string | null>(null); // provider name being edited, or "__new__"
  const [collapsedProviders, setCollapsedProviders] = useState<Record<string, boolean>>({});
  const [showApiKey, setShowApiKey] = useState(false);
  const [provDraft, setProvDraft] = useState<{ name: string; baseUrl: string; apiKey: string; models: string }>({ name: "", baseUrl: "", apiKey: "", models: "" });
  const providerDialogId = useId();

  const refresh = useCallback(async () => {
    const path = sessionFile
      ? `image-gen?sessionFile=${encodeURIComponent(sessionFile)}${cwd ? `&cwd=${encodeURIComponent(cwd)}` : ""}&includeProviderKeys=1`
      : `image-gen?${cwd ? `cwd=${encodeURIComponent(cwd)}&` : ""}includeProviderKeys=1`;
    try {
      const r = await fetch(apiFor(remotePeer, path));
      const data = await r.json() as Partial<ImageGenState> & { error?: string };
      if (!r.ok || data.error) throw new Error(data.error ?? `HTTP ${r.status}`);
      const providers = data.providers && typeof data.providers === "object" ? data.providers : {};
      setGen({ ...data, providers } as ImageGenState);
    } catch { /* keep */ }
  }, [sessionFile, cwd, remotePeer]);

  useEffect(() => { void refresh(); }, [refresh]);

  const writeQueue = useRef(Promise.resolve());

  const post = useCallback((body: Record<string, unknown>) => {
    const run = writeQueue.current.then(async () => {
      try {
        const r = await fetch(apiFor(remotePeer, "image-gen"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(sessionFile ? { ...body, sessionFile } : body),
        });
        const d = await r.json();
        if (!r.ok || !d.ok) return null;
        await refresh();
        onChanged?.();
        window.dispatchEvent(new Event(GEN_CONFIG_CHANGED_EVENT));
        return d;
      } catch { return null; }
    });
    writeQueue.current = run.then(() => undefined, () => undefined);
    return run;
  }, [sessionFile, refresh, onChanged, remotePeer]);

  const apply = (body: Record<string, unknown>, optimistic: (g: ImageGenState) => ImageGenState) => {
    setGen((g) => (g ? optimistic(g) : g));
    void post(body);
  };

  const rowStyle = (active: boolean): React.CSSProperties => ({
    display: "flex", alignItems: "center", gap: 8, width: "100%", minWidth: 0,
    padding: "6px 12px", flexWrap: "wrap", background: active ? "var(--bg-selected)" : "none",
    border: "none", color: active ? "var(--text)" : "var(--text-muted)",
    cursor: "pointer", fontSize: 12, textAlign: "left",
    fontWeight: active ? 600 : 400, whiteSpace: "nowrap",
  });

  const startEditProvider = (name: string | null) => {
    if (name) {
      const p = gen?.providers?.[name];
      setProvDraft({ name, baseUrl: p?.baseUrl ?? "", apiKey: p?.apiKey ?? "", models: (p?.models ?? []).join(", ") });
    } else {
      setProvDraft({ name: "", baseUrl: "", apiKey: "", models: "" });
    }
    setShowApiKey(false);
    setEditingProvider(name ?? "__new__");
  };

  const saveProvider = () => {
    const name = provDraft.name.trim();
    if (!name) return;
    void post({
      action: "saveGenProvider",
      providerName: name,
      provider: {
        baseUrl: provDraft.baseUrl.trim(),
        apiKey: provDraft.apiKey.trim(),
        models: provDraft.models.split(",").map((s) => s.trim()).filter(Boolean),
      },
    });
    setEditingProvider(null);
  };

  const deleteProvider = (name: string) => {
    void post({ action: "deleteGenProvider", providerName: name });
  };

  useEffect(() => { setSelectedDirScope(null); setEditingDir(false); }, [cwd]);

  const activeDirScope: OutputDirScope = selectedDirScope ?? gen?.outputDirScope ?? "global";
  const activeOutputDir = gen
    ? activeDirScope === "project" ? (gen.outputDirProject ?? gen.outputDirGlobal) : gen.outputDirGlobal
    : "";

  const beginDirEdit = (scope: OutputDirScope = activeDirScope) => {
    if (!gen) return;
    const targetDir = scope === "project" ? (gen.outputDirProject ?? gen.outputDirGlobal) : gen.outputDirGlobal;
    setSelectedDirScope(scope);
    setDirScope(scope);
    setDirDraft(targetDir);
    setEditingDir(true);
  };

  const selectEditScope = (scope: OutputDirScope) => {
    if (!gen) return;
    setSelectedDirScope(scope);
    setDirScope(scope);
    setDirDraft(scope === "project" ? (gen.outputDirProject ?? gen.outputDirGlobal) : gen.outputDirGlobal);
  };

  const cancelDirEdit = () => setEditingDir(false);

  const saveDir = () => {
    if (!gen) return;
    const d = dirDraft.trim();
    const scope = cwd ? dirScope : "global";
    const effectiveDir = scope === "project" ? (gen.outputDirProject ?? gen.outputDirGlobal) : gen.outputDirGlobal;
    setEditingDir(false);
    if (!d || d === effectiveDir) return;
    void post({ action: "setOutputDir", outputDir: d, scope, ...(scope === "project" ? { cwd } : {}) });
  };

  return (
    <div style={{ padding: "4px 0 16px" }}>
      {!gen ? (
        <div style={{ padding: "14px 18px", fontSize: 12, color: "var(--text-muted)" }}>{t("i18n.loading")}</div>
      ) : (
        <>
          {gen.enabled && gen.genInvalid && (
            <div style={{ padding: "4px 18px 0", fontSize: 11, lineHeight: 1.4, color: "#f87171" }}>
              {t("chat.genNoValidModelTitle")}
            </div>
          )}

          {/* ── Output dir ── */}
          <div
            style={{
              margin: "8px 18px 16px",
              padding: "14px 16px",
              border: "1px solid var(--border)",
              borderRadius: 8,
              background: "var(--bg-panel)",
            }}
          >
            <div className="image-gen-output-header" style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <FolderOpen size={16} strokeWidth={2} style={{ color: "var(--text-muted)" }} />
                <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{t("chat.genOutputDir")}</span>
              </span>
              {cwd ? (
                <span style={{ display: "inline-flex", gap: 4 }}>
                  <ConfigButton className="image-gen-output-scope-button" size="small" type="button" aria-pressed={(editingDir ? dirScope : activeDirScope) === "project"} onClick={() => editingDir ? selectEditScope("project") : setSelectedDirScope("project")}>{t("chat.genOutputDirScopeProject")}</ConfigButton>
                  <ConfigButton className="image-gen-output-scope-button" size="small" type="button" aria-pressed={(editingDir ? dirScope : activeDirScope) === "global"} onClick={() => editingDir ? selectEditScope("global") : setSelectedDirScope("global")}>{t("chat.genOutputDirScopeGlobal")}</ConfigButton>
                </span>
              ) : (
                <span style={{ fontSize: 11, color: "var(--text-muted)", border: "1px solid var(--border)", borderRadius: 4, padding: "1px 6px", flexShrink: 0 }}>{t("chat.genOutputDirScopeGlobal")}</span>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, paddingTop: 10, flexWrap: "wrap" }}>
              {editingDir ? (
                <>
                  <input autoFocus value={dirDraft} onChange={(e) => setDirDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); saveDir(); }
                      if (e.key === "Escape") { e.preventDefault(); cancelDirEdit(); }
                    }}
                    style={inputStyle} />
                  <span style={{ display: "inline-flex", gap: 4 }}>
                    <ConfigButton size="small" type="button" onClick={cancelDirEdit}><X size={12} strokeWidth={1.8} /><span>{t("i18n.cancel")}</span></ConfigButton>
                    <ConfigButton variant="primary" size="small" type="button" onClick={saveDir}><Check size={12} strokeWidth={1.9} /><span>{t("i18n.save")}</span></ConfigButton>
                  </span>
                </>
              ) : (
                <>
                  <code style={{ flex: 1, minWidth: 0, fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{activeOutputDir}</code>
                  {activeDirScope === "project" && gen.outputDirProject === null ? (
                    <ConfigScopeTag scope="global">{t("chat.genOutputDirInherited")}</ConfigScopeTag>
                  ) : null}
                  {activeDirScope === "project" && gen.outputDirProject !== null ? (
                    <ConfigButton size="small" type="button" onClick={() => { void post({ action: "clearProjectOutputDir", cwd }); }}>
                      <Undo2 size={12} strokeWidth={1.8} />
                      <span>{t("chat.genOutputDirRestoreGlobal")}</span>
                    </ConfigButton>
                  ) : null}
                  <ConfigButton size="small" type="button" onClick={() => beginDirEdit(activeDirScope)}>
                    <Pencil size={12} strokeWidth={1.8} />
                    <span>{t("chat.genOutputDirEdit")}</span>
                  </ConfigButton>
                </>
              )}
            </div>
          </div>

          {/* ── Generation providers ── */}
              <div style={{ ...SECTION_TITLE, justifyContent: "space-between" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <ImageIcon size={14} strokeWidth={1.8} />
                  <span>{t("chat.genModels")}</span>
                </span>
                <ConfigButton size="small"
                  onClick={() => startEditProvider(null)}
                >
                  <Plus size={13} strokeWidth={1.9} />
                  <span>{t("chat.genAddProvider")}</span>
                </ConfigButton>
              </div>
              {Object.entries(gen.providers ?? {}).length === 0 && editingProvider !== "__new__" ? (
                <div style={{ padding: "6px 18px", fontSize: 11, color: "var(--text-dim)" }}>
                  {t("chat.genNoProviders")} — ~/.pi/agent/image-generation.json
                </div>
              ) : Object.entries(gen.providers ?? {}).map(([provider, p], index) => {
                const collapsed = collapsedProviders[provider] === true;
                const providerPanelId = `${providerDialogId}-provider-${index}`;
                return (
                <div key={`gen-${provider}`}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 12px 2px 18px" }}>
                    <button
                      type="button"
                      aria-expanded={!collapsed}
                      aria-controls={providerPanelId}
                      onClick={() => setCollapsedProviders((current) => ({ ...current, [provider]: !collapsed }))}
                      style={{
                        display: "inline-flex", alignItems: "center", gap: 5, flex: 1, minWidth: 0,
                        padding: "5px 4px", border: "none", background: "none", color: "var(--accent)",
                        cursor: "pointer", fontSize: 10, fontWeight: 600, textTransform: "uppercase",
                        letterSpacing: "0.05em", fontFamily: "var(--font-mono)", textAlign: "left",
                      }}
                    >
                      {collapsed ? <ChevronRight size={13} strokeWidth={2} /> : <ChevronDown size={13} strokeWidth={2} />}
                      <Server size={12} strokeWidth={1.8} />
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{provider}</span>
                    </button>
                    <ConfigButton size="small" onClick={() => startEditProvider(provider)}>
                      <Pencil size={12} strokeWidth={1.8} />
                      <span>{t("chat.genEditProvider")}</span>
                    </ConfigButton>
                    <ConfigButton variant="danger" size="small" className="config-button-icon" onClick={() => deleteProvider(provider)} aria-label={t("chat.genDeleteProvider")} title={t("chat.genDeleteProvider")}>
                      <Trash2 size={13} strokeWidth={1.8} />
                    </ConfigButton>
                  </div>
                  {!collapsed && (
                    <div id={providerPanelId}>
                      {p.models.map((modelId) => {
                      const active = gen.genProvider === provider && gen.genModelId === modelId;
                      const cap = gen.capabilities?.[modelId];
                      const resText = cap?.resolutions?.length
                        ? (cap.resolutions.length === 1 ? cap.resolutions[0] : cap.resolutions.join("/"))
                        : "";
                      return (
                        <div
                          key={`gen-${provider}:${modelId}`}
                          style={{
                            margin: "6px 18px",
                            borderRadius: 8,
                            border: active ? "1px solid var(--accent, #6366f1)" : "1px solid var(--border)",
                            background: active ? "var(--bg-selected, rgba(99,102,241,0.04))" : "var(--bg-panel, var(--bg))",
                            boxShadow: active ? "0 1px 3px rgba(0,0,0,0.06)" : "none",
                            transition: "border-color 0.15s, background-color 0.15s",
                            overflow: "hidden",
                          }}
                        >
                          <button
                            type="button"
                            onClick={() => apply({ action: "setModel", provider, modelId }, (g) => ({ ...g, genProvider: provider, genModelId: modelId, genBackend: provider.toLowerCase() === "apimart" ? "apimart" : "registry" }))}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 10,
                              width: "100%",
                              padding: "9px 12px",
                              background: "none",
                              border: "none",
                              cursor: "pointer",
                              textAlign: "left",
                              color: "var(--text)",
                            }}
                            onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--bg-hover)"; }}
                            onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "none"; }}
                          >
                            <span
                              style={{
                                width: 14,
                                height: 14,
                                borderRadius: "50%",
                                border: active ? "4.5px solid var(--accent, #6366f1)" : "1.5px solid var(--border)",
                                background: "var(--bg)",
                                flexShrink: 0,
                                display: "inline-block",
                                boxSizing: "border-box",
                              }}
                            />
                            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: active ? 600 : 500, color: "var(--text)" }}>
                                  {modelId}
                                </span>
                                {provider.toLowerCase() === "apimart" && (
                                  <span style={{ display: "inline-flex", alignItems: "center", lineHeight: 1, fontSize: 9, padding: "1px 5px", background: "rgba(99,102,241,0.12)", color: "rgba(99,102,241,0.85)", borderRadius: 3, fontWeight: 500, whiteSpace: "nowrap" }}>
                                    async
                                  </span>
                                )}
                                {!active && (
                                  <ImageGenerationPrice provider={provider} model={modelId} remotePeer={remotePeer} capability={cap} compact active={false} />
                                )}
                              </div>
                              <div style={{ fontSize: 11, color: "var(--text-dim)", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                {cap?.ratios?.length ? <span>{t("chat.genCapRatios", { n: cap.ratios.length })}</span> : null}
                                {resText ? <span>· {resText}</span> : null}
                                {!active && cap?.note ? (
                                  <span style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-muted)" }}>
                                    {cap.note}
                                  </span>
                                ) : null}
                              </div>
                            </div>
                          </button>
                          {active && (
                            <div style={{ padding: "0 12px 10px 36px" }}>
                              {cap?.versions && cap.versions.length > 0 && (
                                <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "4px 0 8px" }}>
                                  <span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 500 }}>
                                    {t("chat.genVersion")}:
                                  </span>
                                  <div style={{ display: "inline-flex", padding: 2, background: "var(--bg-subtle, rgba(127,127,127,0.1))", borderRadius: 6, border: "1px solid var(--border)" }}>
                                    {cap.versions.map((version) => {
                                      const isSelected = (gen.genVersion ?? "flare") === version;
                                      return (
                                        <button
                                          key={version}
                                          type="button"
                                          aria-pressed={isSelected}
                                          onClick={() => { void post({ action: "setGenOptions", version }); }}
                                          style={{
                                            padding: "3px 12px",
                                            fontSize: 11,
                                            borderRadius: 4,
                                            border: "none",
                                            background: isSelected ? "var(--bg)" : "transparent",
                                            color: isSelected ? "var(--text)" : "var(--text-muted)",
                                            boxShadow: isSelected ? "0 1px 2px rgba(0,0,0,0.12)" : "none",
                                            fontWeight: isSelected ? 600 : 400,
                                            cursor: "pointer",
                                          }}
                                        >
                                          {version}
                                        </button>
                                      );
                                    })}
                                  </div>
                                </div>
                              )}
                              {cap?.note && (
                                <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6, lineHeight: 1.4 }}>
                                  {cap.note}
                                </div>
                              )}
                            </div>
                          )}
                          {active && (
                            <div style={{ padding: "0 12px 10px 36px" }}>
                              <ImageGenerationPrice provider={provider} model={modelId} remotePeer={remotePeer} capability={cap} compact active />
                            </div>
                          )}
                        </div>
                      );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
              {editingProvider !== null && (
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby={`${providerDialogId}-title`}
                  aria-describedby={`${providerDialogId}-hint`}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return;
                    event.preventDefault();
                    event.stopPropagation();
                    setEditingProvider(null);
                  }}
                  onClick={(event) => {
                    if (event.target === event.currentTarget) setEditingProvider(null);
                  }}
                  style={{
                    position: "fixed", inset: 0, zIndex: 1100, padding: 16,
                    background: "rgba(0,0,0,0.35)", display: "flex",
                    alignItems: "center", justifyContent: "center",
                  }}
                >
                  <form
                    onSubmit={(event) => { event.preventDefault(); saveProvider(); }}
                    style={{
                      width: "min(520px, calc(100vw - 32px))", maxHeight: "calc(100dvh - 32px)",
                      overflowY: "auto", padding: 18, border: "1px solid var(--border)",
                      borderRadius: 8, background: "var(--bg)",
                      boxShadow: "0 12px 36px rgba(0,0,0,0.24)",
                      display: "flex", flexDirection: "column", gap: 12,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div id={`${providerDialogId}-title`} style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>
                          {editingProvider === "__new__" ? t("chat.genAddProvider") : t("chat.genEditProvider")}
                        </div>
                        <div style={{ marginTop: 3, fontSize: 11, color: "var(--text-muted)" }}>
                          {t("chat.genModels")}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setEditingProvider(null)}
                        aria-label={t("i18n.cancel")}
                        title={t("i18n.cancel")}
                        style={{
                          display: "inline-flex", alignItems: "center", justifyContent: "center",
                          padding: 4, border: 0, borderRadius: 5, background: "transparent",
                          color: "var(--text-muted)", cursor: "pointer",
                        }}
                      >
                        <X size={17} strokeWidth={1.8} />
                      </button>
                    </div>
                    <label htmlFor={`${providerDialogId}-name`} style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 11, color: "var(--text-dim)" }}>
                      {t("chat.genProviderName")}
                      <input
                        id={`${providerDialogId}-name`}
                        autoFocus
                        value={provDraft.name}
                        onChange={(event) => setProvDraft((draft) => ({ ...draft, name: event.target.value }))}
                        placeholder="my-gateway"
                        style={inputStyle}
                      />
                    </label>
                    <label htmlFor={`${providerDialogId}-base-url`} style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 11, color: "var(--text-dim)" }}>
                      {t("chat.genProviderBaseUrl")}
                      <input
                        id={`${providerDialogId}-base-url`}
                        value={provDraft.baseUrl}
                        onChange={(event) => setProvDraft((draft) => ({ ...draft, baseUrl: event.target.value }))}
                        placeholder="https://api.example.com/v1"
                        style={inputStyle}
                      />
                    </label>
                    <label htmlFor={`${providerDialogId}-api-key`} style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 11, color: "var(--text-dim)" }}>
                      {t("chat.genProviderApiKey")}
                      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <input
                          id={`${providerDialogId}-api-key`}
                          type={showApiKey ? "text" : "password"}
                          value={provDraft.apiKey}
                          onChange={(event) => setProvDraft((draft) => ({ ...draft, apiKey: event.target.value }))}
                          placeholder="sk-…"
                          autoComplete="off"
                          style={{ ...inputStyle, minWidth: 0 }}
                        />
                        <ConfigButton
                          type="button"
                          variant="ghost"
                          size="small"
                          className="config-button-icon"
                          onClick={() => setShowApiKey((visible) => !visible)}
                          aria-label={showApiKey ? t("chat.genProviderKeyHide") : t("chat.genProviderKeyShow")}
                          title={showApiKey ? t("chat.genProviderKeyHide") : t("chat.genProviderKeyShow")}
                        >
                          {showApiKey ? <EyeOff size={14} strokeWidth={1.8} /> : <Eye size={14} strokeWidth={1.8} />}
                        </ConfigButton>
                      </span>
                    </label>
                    <label htmlFor={`${providerDialogId}-models`} style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 11, color: "var(--text-dim)" }}>
                      {t("chat.genProviderModels")}
                      <input
                        id={`${providerDialogId}-models`}
                        value={provDraft.models}
                        onChange={(event) => setProvDraft((draft) => ({ ...draft, models: event.target.value }))}
                        placeholder="gpt-image-2.5-sunburst, gpt-image-2.5-flare"
                        style={inputStyle}
                      />
                    </label>
                    <div id={`${providerDialogId}-hint`} style={{ fontSize: 10, lineHeight: 1.4, color: "var(--text-dim)" }}>
                      {t("chat.genProviderKeyHint")}
                    </div>
                    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 2 }}>
                      <ConfigButton type="button" size="small" onClick={() => setEditingProvider(null)}>
                        <X size={13} strokeWidth={1.8} />
                        <span>{t("i18n.cancel")}</span>
                      </ConfigButton>
                      <ConfigButton variant="primary" type="submit" size="small" disabled={!provDraft.name.trim()}>
                        <Check size={13} strokeWidth={1.9} />
                        <span>{t("i18n.save")}</span>
                      </ConfigButton>
                    </div>
                  </form>
                </div>
              )}
        </>
      )}
    </div>
  );
}

export function ImageGenConfig({
  sessionFile,
  cwd,
  onClose,
  onChanged,
  remotePeer,
}: {
  sessionFile?: string;
  cwd?: string;
  onClose: () => void;
  onChanged?: () => void;
  remotePeer?: string;
}) {
  const { t } = useI18n();
  const isMobile = typeof window !== "undefined" && window.innerWidth < 640;
  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        width: isMobile ? "calc(100vw - 16px)" : 640,
        maxWidth: "calc(100vw - 16px)",
        height: isMobile ? "calc(100dvh - 16px)" : "78vh",
        maxHeight: "calc(100dvh - 16px)",
        background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10,
        display: "flex", flexDirection: "column",
        boxShadow: "0 8px 32px rgba(0,0,0,0.18)", overflow: "hidden",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 18px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{t("chat.genModels")}</span>
            <code style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>~/.pi/agent/image-generation.json</code>
          </div>
          <button onClick={onClose} aria-label="Close" title="Close" style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "4px 6px" }}><X size={17} strokeWidth={1.8} /></button>
        </div>
        <div style={{ flex: 1, overflowY: "auto" }}>
          <ImageGenSections sessionFile={sessionFile} cwd={cwd} onChanged={onChanged} remotePeer={remotePeer} />
        </div>
      </div>
    </div>
  );
}
