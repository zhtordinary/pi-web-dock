"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { apiPathForPeer } from "@/lib/file-api";
import { ConfigButton } from "./SettingsUi";
import type { SettingsPanelController } from "./UnifiedSettingsModal";

type Lists = { read: string[]; write: string[] };
type Snapshot = { policy: Lists & { previous?: Lists }; revision: string; path: string };
type View = { snapshot: Snapshot | null; draft: Lists; loading: boolean; saving: boolean; dirty: boolean; stale: boolean; error: string | null; notice: string | null };
const emptyView = (): View => ({ snapshot: null, draft: { read: [], write: [] }, loading: true, saving: false, dirty: false, stale: false, error: null, notice: null });

function validSnapshot(value: unknown): value is Snapshot {
  if (!value || typeof value !== "object") return false;
  const item = value as Snapshot;
  return typeof item.path === "string" && typeof item.revision === "string" && /^[a-f0-9]{64}$/.test(item.revision)
    && !!item.policy && Array.isArray(item.policy.read) && Array.isArray(item.policy.write)
    && [...item.policy.read, ...item.policy.write].every((path) => typeof path === "string");
}

export function FilePermissionsConfig({ remotePeer, controllerRef }: { remotePeer?: string; controllerRef?: React.MutableRefObject<SettingsPanelController | null> }) {
  const { t } = useI18n();
  const peerKey = remotePeer ? `peer:${remotePeer}` : "local";
  const [views, setViews] = useState<Record<string, View>>({});
  const view = views[peerKey] ?? emptyView();
  const generation = useRef(0);
  const loadAbort = useRef<AbortController | null>(null);
  const inFlight = useRef(new Set<string>());
  const update = useCallback((key: string, change: (current: View) => View) => {
    setViews((previous) => ({ ...previous, [key]: change(previous[key] ?? emptyView()) }));
  }, []);

  const load = useCallback(async (discard = false) => {
    const key = peerKey;
    loadAbort.current?.abort();
    const controller = new AbortController();
    loadAbort.current = controller;
    const request = ++generation.current;
    update(key, (current) => ({ ...current, loading: true, saving: false, error: null, notice: null }));
    try {
      const response = await fetch(apiPathForPeer(remotePeer, "settings/file-permissions"), { signal: controller.signal });
      const data: unknown = await response.json();
      if (!response.ok || !validSnapshot(data)) {
        throw new Error(typeof data === "object" && data && "error" in data ? String(data.error) : `HTTP ${response.status}`);
      }
      if (generation.current !== request) return;
      update(key, (current) => {
        if (!discard && current.dirty && current.snapshot) {
          const stale = current.snapshot.revision !== data.revision;
          return { ...current, loading: false, stale, error: stale ? t("settings.filePermissionsConflict") : null };
        }
        return { ...emptyView(), snapshot: data, draft: { read: [...data.policy.read], write: [...data.policy.write] }, loading: false };
      });
    } catch (error) {
      if (generation.current === request) update(key, (current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : String(error) }));
    } finally {
      if (loadAbort.current === controller) loadAbort.current = null;
    }
  }, [peerKey, remotePeer, t, update]);

  useEffect(() => {
    void load();
    return () => { generation.current++; loadAbort.current?.abort(); };
  }, [load]);

  const changeList = (access: keyof Lists, index: number, value: string | null) => {
    update(peerKey, (current) => {
      const list = [...current.draft[access]];
      if (index === -1) list.push("");
      else if (value === null) list.splice(index, 1);
      else list[index] = value;
      const draft = { ...current.draft, [access]: list };
      const saved = current.snapshot?.policy;
      const dirty = !saved || JSON.stringify(draft) !== JSON.stringify({ read: saved.read, write: saved.write });
      return { ...current, draft, dirty, error: current.stale ? t("settings.filePermissionsConflict") : null, notice: null };
    });
  };

  const save = useCallback(async (action: "save" | "restore"): Promise<boolean> => {
    if (!view.snapshot || view.saving || view.stale || view.loading || inFlight.current.has(peerKey)) return false;
    if (action === "save" && [...view.draft.read, ...view.draft.write].some((root) => !root.trim())) {
      update(peerKey, (current) => ({ ...current, error: t("settings.filePermissionsInvalid") }));
      return false;
    }
    if (action === "restore" && !window.confirm(t("settings.filePermissionsRestoreConfirm"))) return false;
    if (action === "save" && view.draft.write.some((root) => /^(?:~[\\/]?|[\\/]|[a-z]:[\\/]?)$/i.test(root.trim()))
      && !window.confirm(t("settings.filePermissionsBroadConfirm"))) return false;
    const request = generation.current;
    const key = peerKey;
    inFlight.current.add(key);
    update(key, (current) => ({ ...current, saving: true, error: null, notice: null }));
    try {
      const response = await fetch(apiPathForPeer(remotePeer, "settings/file-permissions"), {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, revision: view.snapshot.revision, ...(action === "save" ? view.draft : {}) }),
      });
      const data: unknown = await response.json();
      if (!response.ok || !validSnapshot(data)) {
        if (response.status === 409) {
          if (generation.current === request) update(key, (current) => ({ ...current, stale: true, error: t("settings.filePermissionsConflict") }));
          return false;
        }
        if (typeof data === "object" && data && "code" in data && data.code === "invalid_permissions") {
          throw new Error(t("settings.filePermissionsInvalid"));
        }
        throw new Error(typeof data === "object" && data && "error" in data ? String(data.error) : `HTTP ${response.status}`);
      }
      if (generation.current !== request) return false;
      update(key, () => ({ ...emptyView(), snapshot: data, draft: { read: [...data.policy.read], write: [...data.policy.write] }, loading: false, notice: t("settings.filePermissionsSaved") }));
      return true;
    } catch (error) {
      if (generation.current === request) update(key, (current) => ({ ...current, error: error instanceof Error ? error.message : String(error) }));
      return false;
    } finally {
      inFlight.current.delete(key);
      if (generation.current === request) update(key, (current) => ({ ...current, saving: false }));
    }
  }, [peerKey, remotePeer, t, update, view]);

  useEffect(() => {
    if (!controllerRef) return;
    controllerRef.current = {
      isDirty: () => Object.values(views).some((item) => item.dirty || item.saving),
      save: async () => {
        if (Object.entries(views).some(([key, item]) => key !== peerKey && item.dirty)) {
          update(peerKey, (current) => ({ ...current, error: t("settings.filePermissionsOtherDevice") }));
          return false;
        }
        return view.dirty ? save("save") : !view.saving;
      },
      discard: () => setViews((current) => Object.fromEntries(Object.entries(current).map(([key, item]) => [key,
        item.snapshot ? { ...item, draft: { read: [...item.snapshot.policy.read], write: [...item.snapshot.policy.write] }, dirty: false } : item,
      ]))),
    };
    return () => { controllerRef.current = null; };
  }, [controllerRef, peerKey, save, t, update, view.dirty, view.saving, views]);

  useEffect(() => {
    if (!Object.values(views).some((item) => item.dirty || item.saving)) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [views]);

  return (
    <section id="general-sec-file-permissions" aria-labelledby="general-file-permissions-heading" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <h3 id="general-file-permissions-heading" style={{ fontSize: 13, fontWeight: 600, margin: 0, color: "var(--text)" }}>{t("settings.filePermissionsTitle")}</h3>
        <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "5px 0 0", lineHeight: 1.5 }}>{t("settings.filePermissionsDescription")}</p>
      </div>
      {view.loading && !view.snapshot && <p role="status" style={{ margin: 0, fontSize: 12 }}>{t("settings.filePermissionsLoading")}</p>}
      {view.snapshot && <>
        <div style={{ fontSize: 11, color: "var(--text-muted)", overflowWrap: "anywhere" }}>
          {t("settings.filePermissionsPath")}: <code>{view.snapshot.path}</code>
        </div>
        <p style={{ margin: 0, fontSize: 11, lineHeight: 1.5, color: "var(--text-muted)" }}>{t("settings.filePermissionsHint")}</p>
        {(["read", "write"] as const).map((access) => {
          const label = t(access === "read" ? "settings.filePermissionsRead" : "settings.filePermissionsWrite");
          return <fieldset key={access} disabled={view.loading || view.saving} style={{ margin: 0, padding: 0, border: 0, minWidth: 0 }}>
            <legend style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>{label}</legend>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {view.draft[access].length === 0 && <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("settings.filePermissionsEmpty")}</span>}
              {view.draft[access].map((root, index) => <div key={index} style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                <input value={root} onChange={(event) => changeList(access, index, event.target.value)}
                  aria-label={t("settings.filePermissionsInput", { access: label, index: index + 1 })} placeholder="~/Projects/example"
                  style={{ flex: 1, minWidth: 0, padding: "7px 9px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 12 }} />
                <ConfigButton size="small" type="button" onClick={() => changeList(access, index, null)} aria-label={t("settings.filePermissionsRemove", { path: root || String(index + 1) })}>×</ConfigButton>
              </div>)}
              <div><ConfigButton size="small" type="button" onClick={() => changeList(access, -1, "")}>{t("settings.filePermissionsAdd")}</ConfigButton></div>
            </div>
          </fieldset>;
        })}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <ConfigButton variant="primary" type="button" disabled={!view.dirty || view.loading || view.saving || view.stale} onClick={() => void save("save")}>{t("settings.filePermissionsSave")}</ConfigButton>
          <ConfigButton type="button" disabled={!view.dirty || view.loading || view.saving} onClick={() => update(peerKey, (current) => current.snapshot ? { ...current, draft: { read: [...current.snapshot.policy.read], write: [...current.snapshot.policy.write] }, dirty: false, error: current.stale ? t("settings.filePermissionsConflict") : null } : current)}>{t("settings.filePermissionsDiscard")}</ConfigButton>
          <ConfigButton type="button" disabled={!view.snapshot.policy.previous || view.loading || view.saving || view.stale} onClick={() => void save("restore")}>{t("settings.filePermissionsRestore")}</ConfigButton>
        </div>
      </>}
      {view.notice && <p role="status" style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>{view.notice}</p>}
      {view.error && <div role="alert" style={{ fontSize: 12, color: "#dc2626", overflowWrap: "anywhere" }}>
        {t("settings.filePermissionsError")}: {view.error}{" "}
        <ConfigButton size="small" type="button" disabled={view.loading || view.saving} onClick={() => { if (!view.dirty || window.confirm(t("settings.filePermissionsDiscard") + "?")) void load(true); }}>{t("settings.filePermissionsRetry")}</ConfigButton>
      </div>}
    </section>
  );
}
