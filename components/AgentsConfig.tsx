"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import type { SettingsPanelController } from "./UnifiedSettingsModal";
import { ExternalLink, X, ChevronDown } from "lucide-react";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { BUILTIN_TOOLS, type ReaderNativeProfileOptions, type SubagentProfile } from "@/lib/subagent-profile-types";
import { collectPendingDrafts, hasPendingSubagentReload, pendingSubagentReloadToken, rememberDraft, removeDrafts, setPendingSubagentReload } from "@/lib/subagent-draft-state";
import type { ProjectTrustStatus } from "@/lib/api-types";
import { projectTrustReloadKey } from "./settings-ui-helpers";
import { apiPathForPeer } from "@/lib/file-api";
import { sendAgentCommand } from "@/lib/agent-client";
import { moveSubagentProfile } from "@/lib/subagent-order";
import { ConfigButton, ConfigListAction, ConfigScopeTag, ConfigSwitch, useSettingsDetailNavigation } from "./SettingsUi";
import { useConfigSidebarResize } from "./ConfigPanelShared";
import { ReaderFloatingSelect } from "./ReaderFloatingSelect";
import { useHiddenModelProviders } from "@/hooks/useHiddenModelProviders";
import { filterHiddenProviderNames } from "@/lib/model-visibility-preference";

export interface AgentsConfigProps {
  cwd?: string;
  sessionId?: string | null;
  remotePeer?: string;
  onClose?: () => void;
  onReloaded?: () => void;
  embedded?: boolean;
  onOpenFile?: (filePath: string) => void;
  active?: boolean;
  trust?: ProjectTrustStatus | null;
  controllerRef?: React.MutableRefObject<SettingsPanelController | null>;
}

const DEFAULT_READER_NATIVE: ReaderNativeProfileOptions = {
  loadSkills: true,
  loadExtensions: true,
  codemode: "inherit",
  mcp: "on",
  inheritContext: false,
  runInBackground: true,
};

const DEFAULT_DRAFT: SubagentProfile = {
  name: "",
  displayName: "",
  description: "",
  systemPrompt: "",
  tools: [...BUILTIN_TOOLS],
  reader: { ...DEFAULT_READER_NATIVE },
  enabled: true,
  scope: "global",
  toolsExplicit: true,
  defaultContext: "fresh",
  defaultAsync: true,
  inheritProjectContext: true,
  inheritGlobalContext: true,
  inheritSkills: true,
};

type ProfileGroupKey = "project" | "workspace" | "global" | "builtin-reader" | "runtime";

function isWritableScope(scope: SubagentProfile["scope"]): boolean {
  return scope === "global" || scope === "project";
}

function isTogglableScope(scope: SubagentProfile["scope"]): boolean {
  return isWritableScope(scope) || scope === "builtin";
}

function getProfileGroupKey(profile: SubagentProfile): ProfileGroupKey {
  if (profile.scope === "builtin") return "builtin-reader";
  if (profile.scope === "runtime") return "runtime";
  return profile.scope;
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

function cloneProfile(profile: SubagentProfile): SubagentProfile {
  return {
    ...profile,
    tools: [...profile.tools],
    ...(profile.reader ? { reader: { ...profile.reader } } : {}),
  };
}

function readerOptions(profile: SubagentProfile): ReaderNativeProfileOptions {
  return {
    ...DEFAULT_READER_NATIVE,
    ...(profile.reader ?? {}),
    inheritContext: profile.defaultContext === "fork",
    runInBackground: profile.defaultAsync,
  };
}

function modelReferenceBase(reference: string, models: readonly { provider: string; id: string }[]): string {
  if (models.some((model) => `${model.provider}/${model.id}` === reference)) return reference;
  const colon = reference.lastIndexOf(":");
  const suffix = reference.slice(colon + 1);
  return colon > 0 && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(suffix)
    ? reference.slice(0, colon)
    : reference;
}

function profileKey(profile: Pick<SubagentProfile, "scope" | "name">): string {
  return `${profile.scope}:${profile.name}`;
}

function duplicateProfileName(name: string, profiles: readonly SubagentProfile[]): string {
  const existing = new Set(profiles.map((profile) => profile.name.toLowerCase()));
  const base = `${name}-copy`;
  let candidate = base;
  let suffix = 2;
  while (existing.has(candidate.toLowerCase())) candidate = `${base}-${suffix++}`;
  return candidate;
}

function editableModel(profile: SubagentProfile): string | undefined {
  return profile.scope === "runtime" || profile.scope === "builtin" ? profile.modelOverride : profile.model;
}

function editableThinking(profile: SubagentProfile): string | undefined {
  if (profile.scope !== "runtime" && profile.scope !== "builtin") return profile.thinking;
  if (profile.thinkingOverride === false) return undefined;
  return profile.thinkingOverride ?? profile.thinking;
}

function withEditableModel(profile: SubagentProfile, model: string | undefined): SubagentProfile {
  if (profile.scope === "runtime" || profile.scope === "builtin") return { ...profile, model, modelOverride: model };
  return { ...profile, model };
}

function withEditableThinking(profile: SubagentProfile, thinking: string | undefined): SubagentProfile {
  if (profile.scope !== "runtime") return { ...profile, thinking };
  if (thinking !== undefined) return { ...profile, thinking, thinkingOverride: thinking };
  if (profile.thinking !== undefined || profile.thinkingOverride === false) {
    return { ...profile, thinking: undefined, thinkingOverride: false };
  }
  return { ...profile, thinking: undefined, thinkingOverride: undefined };
}

const NEW_DRAFT_KEY = "__new__";

function comparableProfile(profile: SubagentProfile): Record<string, unknown> {
  return {
    name: profile.name,
    displayName: profile.displayName,
    description: profile.description,
    systemPrompt: profile.systemPrompt,
    tools: profile.toolsExplicit === false
      ? []
      : Array.from(new Set(profile.tools ?? [])).sort(),
    toolsExplicit: profile.toolsExplicit !== false,
    enabled: profile.enabled,
    scope: profile.scope,
    model: editableModel(profile) ?? "",
    thinking: editableThinking(profile) ?? "",
    defaultContext: profile.defaultContext,
    defaultAsync: profile.defaultAsync,
    inheritProjectContext: profile.inheritProjectContext,
    inheritGlobalContext: profile.inheritGlobalContext,
    inheritSkills: profile.inheritSkills,
    reader: readerOptions(profile),
  };
}

function profilesEqual(left: SubagentProfile, right: SubagentProfile): boolean {
  return JSON.stringify(comparableProfile(left)) === JSON.stringify(comparableProfile(right));
}

function hasNewDraftChanges(profile: SubagentProfile): boolean {
  const comparable = cloneProfile(profile);
  comparable.scope = DEFAULT_DRAFT.scope;
  comparable.filePath = undefined;
  return !profilesEqual(comparable, DEFAULT_DRAFT);
}

export function AgentsConfig({ cwd = "", sessionId = null, remotePeer, onClose, onReloaded, embedded = false, onOpenFile, active = true, controllerRef, trust }: AgentsConfigProps) {
  const { t } = useI18n();
  const navigation = useSettingsDetailNavigation();
  const isMobile = useIsMobile();
  const hiddenModelProviders = useHiddenModelProviders();
  const sidebarResizer = useConfigSidebarResize();

  const [showBuiltInInfo, setShowBuiltInInfo] = useState(false);
  const builtInInfoRef = useRef<HTMLDivElement>(null);
  const [builtInEnabled, setBuiltInEnabled] = useState(false);
  const [reloadNeededFor, setReloadNeededFor] = useState<string | null>(null);
  const reloadIdentity = sessionId ? JSON.stringify([remotePeer ?? null, sessionId]) : null;
  const reloadNeeded = reloadIdentity !== null && reloadNeededFor === reloadIdentity;
  const [reloading, setReloading] = useState(false);
  const [maxConcurrent, setMaxConcurrent] = useState(10);
  const [, setBuiltInLoading] = useState(true);
  const [profiles, setProfiles] = useState<SubagentProfile[]>([]);
  const [, setLoadingProfiles] = useState(true);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [profileDrop, setProfileDrop] = useState<{ group: ProfileGroupKey; key: string; after: boolean } | null>(null);
  const draggedProfileRef = useRef<{ group: ProfileGroupKey; key: string } | null>(null);
  const [reordering, setReordering] = useState(false);
  const [expandedScopes, setExpandedScopes] = useState<Record<ProfileGroupKey, boolean>>({
    project: true,
    workspace: true,
    global: true,
    "builtin-reader": true,
    runtime: true,
  });
  const trustKey = projectTrustReloadKey(trust);
  const [modelList, setModelList] = useState<Array<{ id: string; name: string; provider: string }>>([]);
  const [modelError, setModelError] = useState<string | null>(null);
  const [thinkingLevelsMap, setThinkingLevelsMap] = useState<Record<string, string[]>>({});

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setModelList([]);
    setModelError(null);
    setThinkingLevelsMap({});
    fetch(apiPathForPeer(remotePeer, `models?cwd=${encodeURIComponent(cwd)}`), { cache: "no-store", signal: controller.signal })
      .then(async (res) => ({ ok: res.ok, status: res.status, data: await res.json() }))
      .then(({ ok, status, data }) => {
        if (controller.signal.aborted) return;
        const message = typeof data?.modelError?.message === "string" ? data.modelError.message
          : typeof data?.error === "string" ? data.error : undefined;
        if (!ok || message) setModelError(message ?? `HTTP ${status}`);
        if (data && Array.isArray(data.modelList)) {
          setModelList(data.modelList);
        } else if (data && data.models && typeof data.models === "object") {
          const parsed: Array<{ id: string; name: string; provider: string }> = [];
          for (const [k, name] of Object.entries(data.models)) {
            const colonIdx = k.indexOf(":");
            const provider = colonIdx >= 0 ? k.slice(0, colonIdx) : "Default";
            const id = colonIdx >= 0 ? k.slice(colonIdx + 1) : k;
            parsed.push({ id, name: String(name), provider });
          }
          setModelList(parsed);
        }
        if (data && data.thinkingLevels && typeof data.thinkingLevels === "object") {
          setThinkingLevelsMap(data.thinkingLevels);
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) setModelError(err instanceof Error ? err.message : String(err));
      });
    return () => controller.abort();
  }, [active, cwd, remotePeer, trustKey]);

  const providerNames = useMemo(() => {
    const set = new Set<string>();
    for (const m of modelList) {
      if (m.provider) set.add(m.provider);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [modelList]);

  const [isCreating, setIsCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<SubagentProfile>(DEFAULT_DRAFT);
  const [draftsByKey, setDraftsByKey] = useState<Record<string, SubagentProfile>>({});
  const draftsRef = useRef<Record<string, SubagentProfile>>({});
  const selectedKeyRef = useRef<string | null>(null);
  const isCreatingRef = useRef(false);
  const newScopeRef = useRef<"global" | "project" | null>(null);
  const reloadOwnerRef = useRef({ sessionId, remotePeer });
  reloadOwnerRef.current = { sessionId, remotePeer };
  const [sessionEvidence, setSessionEvidence] = useState<{ loaded: boolean; provider?: string } | null>(null);

  useEffect(() => {
    setReloadNeededFor(sessionId && hasPendingSubagentReload(sessionId, remotePeer) ? reloadIdentity : null);
  }, [sessionId, remotePeer, reloadIdentity]);
  useEffect(() => { newScopeRef.current = null; }, [cwd, remotePeer]);

  useEffect(() => {
    draftsRef.current = draftsByKey;
  }, [draftsByKey]);
  useEffect(() => {
    selectedKeyRef.current = selectedKey;
  }, [selectedKey]);
  useEffect(() => {
    isCreatingRef.current = isCreating;
  }, [isCreating]);

  useEffect(() => {
    if (!active || !sessionId) {
      setSessionEvidence(null);
      return;
    }
    const controller = new AbortController();
    fetch(apiPathForPeer(remotePeer, `sessions/${encodeURIComponent(sessionId)}/state`), { cache: "no-store", signal: controller.signal })
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        if (controller.signal.aborted) return;
        const model = data?.running && data.state?.model;
        setSessionEvidence(model && typeof model.provider === "string"
          ? { loaded: true, provider: model.provider }
          : { loaded: false });
      })
      .catch(() => {
        if (!controller.signal.aborted) setSessionEvidence({ loaded: false });
      });
    return () => controller.abort();
  }, [active, cwd, remotePeer, sessionId, trustKey]);

  useEffect(() => {
    if (!showBuiltInInfo) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (builtInInfoRef.current && !builtInInfoRef.current.contains(event.target as Node)) {
        setShowBuiltInInfo(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [showBuiltInInfo]);

  const expandProfile = useCallback((profile: SubagentProfile) => {
    const group = getProfileGroupKey(profile);
    setExpandedScopes((previous) => ({ ...previous, [group]: true }));
  }, []);

  const toggleScope = (scope: ProfileGroupKey) => {
    setExpandedScopes((previous) => ({ ...previous, [scope]: !previous[scope] }));
  };

  const draftEditableModel = editableModel(draft);
  const draftEditableThinking = editableThinking(draft);
  const { currentPrimaryProvider, currentPrimaryModelId } = useMemo(() => {
    if (!draftEditableModel) return { currentPrimaryProvider: "", currentPrimaryModelId: "" };
    const baseReference = modelReferenceBase(draftEditableModel, modelList);
    const matched = modelList.find((m) => `${m.provider}/${m.id}` === baseReference);
    if (matched) return { currentPrimaryProvider: matched.provider, currentPrimaryModelId: matched.id };
    const slashIdx = baseReference.indexOf("/");
    if (slashIdx > 0) {
      return {
        currentPrimaryProvider: baseReference.slice(0, slashIdx),
        currentPrimaryModelId: baseReference.slice(slashIdx + 1),
      };
    }
    return { currentPrimaryProvider: "", currentPrimaryModelId: baseReference };
  }, [draftEditableModel, modelList]);

  const getSupportedThinkingOptions = useCallback((provider: string, modelId: string) => {
    if (!provider || !modelId) return THINKING_LEVEL_OPTIONS;
    const key = `${provider}:${modelId}`;
    const supported = thinkingLevelsMap[key];
    if (supported === undefined) {
      return THINKING_LEVEL_OPTIONS;
    }
    if (supported.length === 0) {
      return [];
    }
    const set = new Set([...supported, "off"]);
    return THINKING_LEVEL_OPTIONS.filter((opt) => set.has(opt.value));
  }, [thinkingLevelsMap]);

  const primaryAvailableModels = useMemo(() => {
    if (!currentPrimaryProvider) return [];
    return modelList.filter((m) => m.provider === currentPrimaryProvider);
  }, [currentPrimaryProvider, modelList]);
  const visibleProviderNames = useMemo(
    () => filterHiddenProviderNames(providerNames, hiddenModelProviders, currentPrimaryProvider),
    [currentPrimaryProvider, hiddenModelProviders, providerNames],
  );

  const handlePrimaryProviderChange = useCallback((newProv: string) => {
    if (!newProv) {
      setDraft((p) => withEditableModel(p, undefined));
      return;
    }
    const avail = modelList.filter((m) => m.provider === newProv);
    const nextModelId = avail[0]?.id || "";
    setDraft((p) => withEditableModel(p, `${newProv}/${nextModelId}`));
  }, [modelList]);

  const handlePrimaryModelChange = useCallback((newModelId: string) => {
    if (!currentPrimaryProvider) return;
    const key = `${currentPrimaryProvider}:${newModelId}`;
    const supported = thinkingLevelsMap[key];
    setDraft((p) => {
      const currentThinking = editableThinking(p);
      const nextThinking = (supported && currentThinking && currentThinking !== "off" && !supported.includes(currentThinking))
        ? undefined
        : currentThinking;
      return withEditableThinking(withEditableModel(p, `${currentPrimaryProvider}/${newModelId}`), nextThinking);
    });
  }, [currentPrimaryProvider, thinkingLevelsMap]);

  // Fetch settings (built-in switch)
  const fetchSettings = useCallback(async () => {
    try {
      setBuiltInLoading(true);
      const res = await fetch(apiPathForPeer(remotePeer, "subagents/settings"), { cache: "no-store" });
      const data = await res.json();
      if (res.ok && typeof data.enabled === "boolean") {
        setBuiltInEnabled(data.enabled);
      }
      if (res.ok && typeof data.maxConcurrent === "number") {
        setMaxConcurrent(data.maxConcurrent);
      }
    } catch (err) {
      void err;
    } finally {
      setBuiltInLoading(false);
    }
  }, [remotePeer]);

  // Fetch profiles
  const fetchProfiles = useCallback(async (selectIdentity?: Pick<SubagentProfile, "scope" | "name">): Promise<boolean> => {
    try {
      setLoadingProfiles(true);
      setError(null);
      const params = new URLSearchParams();
      if (cwd) params.set("cwd", cwd);
      if (sessionId) params.set("sessionId", sessionId);
      const query = params.size ? `?${params.toString()}` : "";
      const url = apiPathForPeer(remotePeer, `subagents/profiles${query}`);
      const res = await fetch(url, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load profiles");

      const list: SubagentProfile[] = data.profiles ?? [];
      setProfiles(list);
      if (isCreatingRef.current) return true;

      const desiredKey = selectIdentity ? profileKey(selectIdentity) : selectedKeyRef.current;
      const found = desiredKey
        ? list.find((profile) => profileKey(profile) === desiredKey)
        : undefined;
      if (found) {
        setSelectedKey(desiredKey);
        selectedKeyRef.current = desiredKey;
        expandProfile(found);
        setDraft(cloneProfile(draftsRef.current[desiredKey as string] ?? found));
      } else if (!desiredKey && list.length > 0) {
        const first = list.find((profile) => profile.scope === "global") ?? list[0];
        const firstKey = profileKey(first);
        setSelectedKey(firstKey);
        selectedKeyRef.current = firstKey;
        expandProfile(first);
        setDraft(cloneProfile(draftsRef.current[firstKey] ?? first));
      }
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setLoadingProfiles(false);
    }
  }, [cwd, expandProfile, remotePeer, sessionId]);

  useEffect(() => {
    fetchSettings();
    fetchProfiles();
  }, [fetchSettings, fetchProfiles]);

  const toggleBuiltIn = async (enabled: boolean) => {
    const previous = builtInEnabled;
    const isCurrentOwner = () => reloadOwnerRef.current.sessionId === sessionId && reloadOwnerRef.current.remotePeer === remotePeer;
    setBuiltInEnabled(enabled);
    try {
      const res = await fetch(apiPathForPeer(remotePeer, "subagents/settings"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error("Save failed");
      if (sessionId) {
        setPendingSubagentReload(sessionId, remotePeer, true);
        if (isCurrentOwner()) setReloadNeededFor(reloadIdentity);
      }
      if (isCurrentOwner()) setError(null);
    } catch (err) {
      if (isCurrentOwner()) {
        setBuiltInEnabled(previous);
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const reloadSession = async () => {
    if (!sessionId || reloading) return;
    const isCurrentOwner = () => reloadOwnerRef.current.sessionId === sessionId && reloadOwnerRef.current.remotePeer === remotePeer;
    const pendingToken = pendingSubagentReloadToken(sessionId, remotePeer);
    try {
      setReloading(true);
      setError(null);
      await sendAgentCommand(sessionId, { type: "reload" }, remotePeer);
      if (pendingSubagentReloadToken(sessionId, remotePeer) === pendingToken) {
        setPendingSubagentReload(sessionId, remotePeer, false);
        if (isCurrentOwner()) setReloadNeededFor(null);
      }
      onReloaded?.();
    } catch (err) {
      if (isCurrentOwner()) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReloading(false);
    }
  };

  const updateMaxConcurrent = async (value: number) => {
    try {
      const res = await fetch(apiPathForPeer(remotePeer, "subagents/settings"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxConcurrent: value }),
      });
      const data = await res.json();
      if (!res.ok || data.error || typeof data.maxConcurrent !== "number") {
        throw new Error(data.error ?? "Save failed");
      }
      setMaxConcurrent(data.maxConcurrent);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const persistProfileOrder = useCallback(async (nextProfiles: SubagentProfile[]) => {
    setProfiles(nextProfiles);
    setReordering(true);
    setError(null);
    try {
      const res = await fetch(apiPathForPeer(remotePeer, "subagents/settings"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: nextProfiles.map(profileKey) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(data.error ?? "Save failed");
    } catch (err) {
      await fetchProfiles();
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReordering(false);
    }
  }, [fetchProfiles, remotePeer]);

  const moveProfile = useCallback((group: ProfileGroupKey, sourceKey: string, targetKey: string, after: boolean) => {
    if (saving || reordering) return;
    const groupProfiles = profiles.filter((profile) => getProfileGroupKey(profile) === group);
    const nextGroup = moveSubagentProfile(groupProfiles, sourceKey, targetKey, after);
    if (!nextGroup) return;
    const groupKeys = new Set(groupProfiles.map(profileKey));
    let nextGroupIndex = 0;
    const nextProfiles = profiles.map((profile) => groupKeys.has(profileKey(profile)) ? nextGroup[nextGroupIndex++] : profile);
    void persistProfileOrder(nextProfiles);
  }, [persistProfileOrder, profiles, reordering, saving]);

  const moveProfileByOffset = useCallback((group: ProfileGroupKey, sourceKey: string, offset: -1 | 1) => {
    const groupProfiles = profiles.filter((profile) => getProfileGroupKey(profile) === group);
    const sourceIndex = groupProfiles.findIndex((profile) => profileKey(profile) === sourceKey);
    const target = sourceIndex < 0 ? undefined : groupProfiles[sourceIndex + offset];
    if (!target) return;
    moveProfile(group, sourceKey, profileKey(target), offset > 0);
  }, [moveProfile, profiles]);

  const profileDragProps = (group: ProfileGroupKey, key: string): React.HTMLAttributes<HTMLDivElement> => {
    const target = (event: DragEvent<HTMLDivElement>) => {
      const dragged = draggedProfileRef.current;
      if (!dragged || dragged.group !== group || dragged.key === key) return null;
      const rect = event.currentTarget.getBoundingClientRect();
      return { after: event.clientY >= rect.top + rect.height / 2 };
    };
    const endDrag = () => {
      draggedProfileRef.current = null;
      setProfileDrop(null);
    };
    return {
      draggable: !saving && !reordering,
      onDragStart: (event) => {
        if (saving || reordering) return;
        draggedProfileRef.current = { group, key };
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/x-reader-subagent-profile", key);
        event.dataTransfer.setData("text/plain", key);
      },
      onDragOver: (event) => {
        const drop = target(event);
        if (!drop) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setProfileDrop((previous) => previous?.group === group && previous.key === key && previous.after === drop.after
          ? previous
          : { group, key, ...drop });
      },
      onDragLeave: (event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setProfileDrop((previous) => previous?.group === group && previous.key === key ? null : previous);
      },
      onDrop: (event) => {
        const drop = target(event);
        const dragged = draggedProfileRef.current;
        if (!drop || !dragged) return;
        event.preventDefault();
        moveProfile(group, dragged.key, key, drop.after);
        endDrag();
      },
      onDragEnd: endDrag,
    };
  };

  const selectedProfile = useMemo(() => {
    if (isCreating) return null;
    return profiles.find((p) => `${p.scope}:${p.name}` === selectedKey) ?? null;
  }, [profiles, selectedKey, isCreating]);
  const isReadonlyProfile = !isCreating && Boolean(selectedProfile && !isWritableScope(selectedProfile.scope));
  const isProfileEditable = isCreating || Boolean(selectedProfile && (
    isWritableScope(selectedProfile.scope)
    || selectedProfile.scope === "builtin"
    || (selectedProfile.scope === "runtime" && selectedProfile.runtimeKind === "native")
  ));
  const canEditModel = isCreating || isProfileEditable;
  const isExternalRuntime = !isCreating && selectedProfile?.scope === "runtime" && selectedProfile.runtimeKind !== "native";
  const draftReader = readerOptions(draft);
  const readerChatOnly = draft.toolsExplicit !== false
    && !draft.tools.some((tool) => BUILTIN_TOOLS.some((builtin) => builtin === tool))
    && !draftReader.loadSkills && !draftReader.loadExtensions;

  const rememberCurrentDraft = useCallback(() => {
    const key = isCreating ? NEW_DRAFT_KEY : selectedKey;
    if (!key || !isProfileEditable) return;

    const changed = isCreating
      ? hasNewDraftChanges(draft)
      : Boolean(selectedProfile && !profilesEqual(draft, selectedProfile));
    const next = rememberDraft(draftsRef.current, key, cloneProfile(draft), changed);
    draftsRef.current = next;
    setDraftsByKey(next);
  }, [draft, isCreating, isProfileEditable, selectedKey, selectedProfile]);

  const handleSelect = (p: SubagentProfile) => {
    const key = profileKey(p);
    rememberCurrentDraft();
    const nextDraft = !isCreating && selectedKey === key ? draft : draftsRef.current[key] ?? draftsByKey[key] ?? p;
    setSavedOk(false);
    setIsCreating(false);
    isCreatingRef.current = false;
    setSelectedKey(key);
    selectedKeyRef.current = key;
    expandProfile(p);
    setDraft(cloneProfile(nextDraft));
    navigation?.openDetail(p.displayName || p.name);
  };

  const handleStartCreate = () => {
    const newDraft = isCreating
      ? draft
      : draftsRef.current[NEW_DRAFT_KEY] ?? {
          ...DEFAULT_DRAFT,
          scope: newScopeRef.current ?? (cwd ? "project" : "global"),
          tools: [...BUILTIN_TOOLS],
          toolsExplicit: true,
        };
    rememberCurrentDraft();
    setSavedOk(false);
    setIsCreating(true);
    isCreatingRef.current = true;
    setSelectedKey(null);
    selectedKeyRef.current = null;
    setDraft(cloneProfile(newDraft));
  };

  const handleDuplicate = () => {
    if (!draft) return;
    rememberCurrentDraft();
    const nextDrafts = { ...draftsRef.current };
    delete nextDrafts[NEW_DRAFT_KEY];
    draftsRef.current = nextDrafts;
    setDraftsByKey(nextDrafts);
    setSavedOk(false);
    setIsCreating(true);
    isCreatingRef.current = true;
    setSelectedKey(null);
    selectedKeyRef.current = null;
    setDraft({
      ...draft,
      name: duplicateProfileName(draft.name, profiles),
      displayName: t("agents.copyName", { name: draft.displayName }),
      scope: draft.scope === "project" ? "project" : "global",
      builtinKind: undefined,
      filePath: undefined,
      copyFrom: selectedProfile ? { scope: selectedProfile.scope, name: selectedProfile.name } : undefined,
      tools: [...draft.tools],
      toolsExplicit: draft.toolsExplicit,
    });
  };

  const handleDelete = async () => {
    if (!selectedProfile || !isWritableScope(selectedProfile.scope)) return;
    if (!window.confirm(t("agents.deleteConfirm", { name: selectedProfile.displayName }))) return;

    try {
      setSaving(true);
      setError(null);
      setSavedOk(false);
      const res = await fetch(apiPathForPeer(remotePeer, "subagents/profiles"), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, scope: selectedProfile.scope, name: selectedProfile.name }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Delete failed");
      }
      setSelectedKey(null);
      selectedKeyRef.current = null;
      await fetchProfiles();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (enabled: boolean) => {
    if (isCreating || !selectedProfile || !isTogglableScope(selectedProfile.scope)) return;
    if (selectedProfile.scope === "builtin") {
      rememberCurrentDraft();
      try {
        setSaving(true);
        setError(null);
        const res = await fetch(apiPathForPeer(remotePeer, "subagents/profiles"), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd, scope: "builtin", name: selectedProfile.name, enabled, sessionId }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Save failed");
        if (!await fetchProfiles({ scope: selectedProfile.scope, name: selectedProfile.name })) {
          throw new Error("Refresh failed");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
      return;
    }
    setDraft((prev) => ({ ...prev, enabled }));
  };

  const saveProfile = useCallback(async (profile: SubagentProfile, baseline?: SubagentProfile) => {
    if (!profile.name.trim()) throw new Error("Agent ID is required");
    if (profile.reader?.maxTurns !== undefined && (!Number.isSafeInteger(profile.reader.maxTurns) || profile.reader.maxTurns < 1)) {
      throw new Error(t("agents.invalidMaxTurns"));
    }
    const currentBaseline = baseline ?? profiles.find((candidate) => profileKey(candidate) === profileKey(profile));
    if (profile.scope === "builtin" || profile.scope === "runtime") {
      const patch: Record<string, string | boolean | null> = { };
      if (profile.scope === "builtin") {
        if (editableModel(profile) !== editableModel(currentBaseline ?? profile)) patch.model = editableModel(profile) ?? null;
        if (editableThinking(profile) !== editableThinking(currentBaseline ?? profile)) patch.thinking = editableThinking(profile) ?? null;
      } else {
        if (profile.modelOverride !== currentBaseline?.modelOverride) patch.model = profile.modelOverride ?? null;
        if (profile.thinkingOverride !== currentBaseline?.thinkingOverride) patch.thinking = profile.thinkingOverride ?? null;
      }
      if (Object.keys(patch).length === 0) return;
      const res = await fetch(apiPathForPeer(remotePeer, "subagents/profiles"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, scope: profile.scope, name: profile.name, sessionId, ...patch }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Save failed");
      return;
    }
    const res = await fetch(apiPathForPeer(remotePeer, "subagents/profiles"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd, scope: profile.scope, profile }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Save failed");
  }, [cwd, profiles, remotePeer, sessionId, t]);

  const handleSave = useCallback(async (): Promise<boolean> => {
    const currentKey = isCreating ? NEW_DRAFT_KEY : selectedKey;
    const currentIsDirty = isProfileEditable && (
      isCreating
        ? hasNewDraftChanges(draft)
        : Boolean(selectedProfile && !profilesEqual(draft, selectedProfile))
    );
    const pendingDrafts = collectPendingDrafts(draftsRef.current, currentKey, cloneProfile(draft), currentIsDirty);
    if (currentKey && currentIsDirty) {
      draftsRef.current = { ...draftsRef.current, [currentKey]: cloneProfile(draft) };
      setDraftsByKey(draftsRef.current);
    }
    if (pendingDrafts.size === 0) {
      setError(null);
      setSavedOk(true);
      window.setTimeout(() => setSavedOk(false), 2000);
      return true;
    }
    if (Array.from(pendingDrafts.values()).some((profile) => !profile.name.trim())) {
      setError("Agent ID is required");
      return false;
    }

    setSaving(true);
    setError(null);
    setSavedOk(false);
    const succeeded = new Set<string>();
    let failure: unknown = null;
    try {
      for (const profile of pendingDrafts.values()) {
        const key = [...pendingDrafts.entries()].find(([, candidate]) => candidate === profile)?.[0] ?? profileKey(profile);
        try {
          await saveProfile(profile, profiles.find((candidate) => profileKey(candidate) === key));
          succeeded.add(key);
        } catch (err) {
          failure = err;
          break;
        }
      }
      if (succeeded.size > 0) {
        if (sessionId) {
          setPendingSubagentReload(sessionId, remotePeer, true);
          if (reloadOwnerRef.current.sessionId === sessionId && reloadOwnerRef.current.remotePeer === remotePeer) {
            setReloadNeededFor(reloadIdentity);
          }
        }
        // Remove saved drafts before reloading. fetchProfiles intentionally prefers
        // an unsaved draft when one exists, so refreshing first would put the old
        // object back into the form and make the controller report dirty again.
        const next = removeDrafts(draftsRef.current, succeeded);
        draftsRef.current = next;
        setDraftsByKey(next);

        const currentSavedProfile = currentKey ? pendingDrafts.get(currentKey) : undefined;
        const currentWasSaved = Boolean(currentKey && succeeded.has(currentKey));
        if (currentKey === NEW_DRAFT_KEY && currentWasSaved && currentSavedProfile) {
          const newKey = profileKey(currentSavedProfile);
          setIsCreating(false);
          isCreatingRef.current = false;
          setSelectedKey(newKey);
          selectedKeyRef.current = newKey;
        }
        const refreshProfile = currentWasSaved && currentSavedProfile
          ? currentSavedProfile
          : selectedProfile;
        const refreshTarget = refreshProfile
          ? { scope: refreshProfile.scope, name: refreshProfile.name }
          : undefined;
        if (!await fetchProfiles(refreshTarget)) {
          return false;
        }
      }
      if (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
        return false;
      }
      setSavedOk(true);
      window.setTimeout(() => setSavedOk(false), 2000);
      return true;
    } finally {
      setSaving(false);
    }
  }, [draft, fetchProfiles, isCreating, isProfileEditable, profiles, reloadIdentity, remotePeer, saveProfile, selectedKey, selectedProfile, sessionId]);

  const isDirty = useCallback(() => {
    if (Object.keys(draftsByKey).length > 0) return true;
    if (!isProfileEditable) return false;
    if (isCreating) return hasNewDraftChanges(draft);
    if (selectedProfile) {
      return !profilesEqual(draft, selectedProfile);
    }
    return false;
  }, [draftsByKey, isProfileEditable, isCreating, draft, selectedProfile]);

  const discard = useCallback(() => {
    setError(null);
    draftsRef.current = {};
    setDraftsByKey({});
    if (isCreating) {
      setIsCreating(false);
      isCreatingRef.current = false;
      setDraft(DEFAULT_DRAFT);
    } else if (selectedProfile) {
      setDraft(cloneProfile(selectedProfile));
    }
  }, [isCreating, selectedProfile]);

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

  const toggleTool = (tool: string) => {
    setDraft((prev) => {
      const set = new Set(prev.tools);
      if (set.has(tool)) set.delete(tool);
      else set.add(tool);
      return { ...prev, tools: [...set], toolsExplicit: true };
    });
  };

  const updateReaderOptions = (change: Partial<ReaderNativeProfileOptions>) => {
    setDraft((prev) => ({ ...prev, reader: { ...readerOptions(prev), ...change } }));
  };

  // Grouping
  const globals = useMemo(() => profiles.filter((p) => p.scope === "global"), [profiles]);
  const projects = useMemo(() => profiles.filter((p) => p.scope === "project"), [profiles]);
  const readerBuiltins = useMemo(() => profiles.filter((p) => p.scope === "builtin"), [profiles]);
  const runtimeProfiles = useMemo(() => profiles.filter((p) => p.scope === "runtime"), [profiles]);
  const profileGroups: Array<{ group: ProfileGroupKey; profiles: SubagentProfile[]; label: string }> = [
    { group: "project", profiles: projects, label: t("agents.scope.project") },
    { group: "workspace", profiles: profiles.filter((p) => p.scope === "workspace"), label: t("agents.scope.workspace") },
    { group: "global", profiles: globals, label: t("agents.scope.global") },
    { group: "builtin-reader", profiles: readerBuiltins, label: t("agents.scope.readerBuiltin") },
    { group: "runtime", profiles: runtimeProfiles, label: t("agents.scope.runtimeBuiltin") },
  ];

  const content = (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div className="config-resource-toolbar">
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
            {t("agents.builtInTitle")}
          </span>
          <div ref={builtInInfoRef} style={{ position: "relative", display: "inline-flex" }}>
            <button
              type="button"
              onClick={() => setShowBuiltInInfo((prev) => !prev)}
              aria-label={`${t("agents.executionNotice")}\n${t("agents.executionPending")}`}
              title={`${t("agents.executionNotice")}\n${t("agents.executionPending")}`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 18,
                height: 18,
                borderRadius: "50%",
                background: showBuiltInInfo ? "var(--accent)" : "var(--bg-hover)",
                color: showBuiltInInfo ? "#fff" : "var(--text-muted)",
                fontSize: 11,
                cursor: "pointer",
                border: "none",
                padding: 0,
                transition: "background-color 0.12s, color 0.12s",
              }}
            >
              ⓘ
            </button>
            {showBuiltInInfo && (
              <div
                style={{
                  position: "absolute",
                  top: "calc(100% + 6px)",
                  left: 0,
                  zIndex: 100,
                  width: 320,
                  maxWidth: "85vw",
                  padding: "10px 12px",
                  borderRadius: 6,
                  background: "var(--bg-panel)",
                  border: "1px solid var(--border)",
                  boxShadow: "0 4px 16px rgba(0, 0, 0, 0.15)",
                  fontSize: 12,
                  lineHeight: 1.5,
                  color: "var(--text)",
                }}
              >
                <div style={{ marginBottom: 6, color: "var(--text)", fontWeight: 500 }}>
                  {t("agents.builtInDescription")}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", borderTop: "1px solid var(--border)", paddingTop: 6 }}>
                  <div>{t("agents.executionNotice")}</div>
                  <div style={{ marginTop: 4, color: "var(--accent)" }}>
                    {t("agents.executionPending")}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 10, flexShrink: 0, marginLeft: "auto" }}>
          {reloadNeeded && sessionId && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "#d97706", fontSize: 11 }}>
              <span>{t("agents.reloadRequired")}</span>
              <ConfigButton size="small" onClick={() => void reloadSession()} disabled={reloading}>
                {reloading ? t("agents.reloading") : t("agents.reloadSession")}
              </ConfigButton>
            </span>
          )}
          <label title={t("agents.maxConcurrentDescription")} style={{ display: "inline-flex", alignItems: "center", gap: 7, color: "var(--text-muted)", fontSize: 12 }}>
            <span>{t("agents.maxConcurrent")}</span>
            <input
              aria-label={t("agents.maxConcurrent")}
              type="number"
              min={1}
              max={32}
              step={1}
              value={maxConcurrent}
              onChange={(event) => setMaxConcurrent(Number(event.target.value))}
              onBlur={() => void updateMaxConcurrent(maxConcurrent)}
              style={{ width: 52, height: 22, padding: "1px 4px", fontSize: 12, border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg)", color: "var(--text)" }}
            />
          </label>
          <ConfigSwitch
            checked={builtInEnabled}
            label={t("agents.builtInTitle")}
            onChange={toggleBuiltIn}
          />
        </div>
      </div>

      {/* Main Split Body */}
      <div className="settings-phone-split" style={{ display: "flex", flexDirection: isMobile ? "column" : "row", flex: 1, minHeight: 0 }}>
        {/* Left Agent List */}
        <div
          ref={sidebarResizer.panelRef}
          className="config-sidebar config-resource-sidebar agents-config-sidebar settings-phone-list"
          style={{
            width: isMobile ? "100%" : "var(--config-sidebar-width, 240px)",
            maxHeight: isMobile ? "40vh" : undefined,
            borderRight: isMobile ? "none" : undefined,
            borderBottom: isMobile ? "1px solid var(--border)" : undefined,
          }}
        >
          <div className="config-sidebar-list agents-sidebar-list" style={{ display: "flex", flexDirection: "column", gap: 0 }}>
            {profileGroups.map(({ group, profiles: groupProfiles, label }) => {
              if (groupProfiles.length === 0) return null;
              const expanded = expandedScopes[group];
              return (
                <div key={group} className="config-sidebar-group config-resource-group" style={{ marginBottom: 10, position: "relative" }}>
                  <div
                    className="config-resource-group-header"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      width: "100%",
                      borderTop: "1px solid var(--border)",
                      borderBottom: "1px solid var(--border)",
                      background: "var(--bg-panel)",
                    }}
                  >
                    <button
                      type="button"
                      aria-expanded={expanded}
                      onClick={() => toggleScope(group)}
                      className="config-sidebar-group-label config-resource-group-toggle"
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        flex: 1,
                        minWidth: 0,
                        border: "none",
                        background: "transparent",
                        color: "var(--text)",
                        cursor: "pointer",
                        textAlign: "left",
                      }}
                    >
                      <ChevronDown
                        size={13}
                        style={{ transform: expanded ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 0.15s" }}
                      />
                      <span style={{ flex: 1 }}>{label}</span>
                      <span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 500 }}>{groupProfiles.length}</span>
                    </button>
                  </div>
                  {expanded && groupProfiles.map((p) => {
                    const isOverridden = p.scope === "builtin" && (globals.some((g) => g.name.toLowerCase() === p.name.toLowerCase()) || projects.some((pr) => pr.name.toLowerCase() === p.name.toLowerCase()));
                    return (
                      <div
                        key={`${p.scope}:${p.name}`}
                        role="button"
                        tabIndex={0}
                        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                        aria-current={selectedKey === `${p.scope}:${p.name}` && !isCreating ? "page" : undefined}
                        aria-busy={reordering}
                        title={t("modelRouting.dragToReorder")}
                        {...profileDragProps(group, profileKey(p))}
                        onKeyDown={(event) => {
                          if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
                            const offset = event.key === "ArrowUp" ? -1 : 1;
                            const index = groupProfiles.findIndex((profile) => profileKey(profile) === profileKey(p));
                            if (groupProfiles[index + offset]) {
                              event.preventDefault();
                              moveProfileByOffset(group, profileKey(p), offset);
                            }
                            return;
                          }
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            handleSelect(p);
                          }
                        }}
                        onClick={() => handleSelect(p)}
                        className="config-sidebar-item config-resource-item agents-sidebar-item"
                        style={{
                          justifyContent: "space-between",
                          cursor: reordering ? "wait" : "grab",
                          background: selectedKey === `${p.scope}:${p.name}` && !isCreating ? "var(--bg-selected, rgba(59, 130, 246, 0.12))" : "transparent",
                          color: selectedKey === `${p.scope}:${p.name}` && !isCreating ? "var(--accent, #3b82f6)" : "var(--text)",
                          boxShadow: profileDrop?.group === group && profileDrop.key === profileKey(p)
                            ? `inset 0 ${profileDrop.after ? "-2px" : "2px"} 0 var(--accent)`
                            : undefined,
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                          <div
                            style={{
                              width: 7,
                              height: 7,
                              borderRadius: "50%",
                              background: p.scope === "builtin" ? (isOverridden ? "#999" : "#3b82f6") : (p.enabled ? "#3b82f6" : "#999"),
                              flexShrink: 0,
                            }}
                          />
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                            {p.displayName || p.name}
                          </span>
                        </div>
                        {isOverridden && (
                          <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>
                            {t("agents.overridden")}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>

          <ConfigListAction active={isCreating} onClick={() => { handleStartCreate(); navigation?.openDetail(t("agents.new")); }}>{t("agents.new")}</ConfigListAction>
        </div>

        {!isMobile && (
          <div
            {...sidebarResizer.separatorProps}
            className={`panel-resize-handle config-sidebar-resize-handle${sidebarResizer.isResizing ? " is-resizing" : ""}`}
            title={`${t("layout.resizeSidebar")}: ${t("layout.resizeHint")}`}
          />
        )}

        {/* Right Detail / Edit Form */}
        <div className="settings-phone-detail" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "var(--config-detail-padding-top) 22px 32px", display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Top Bar inside Detail Pane: badge + path + open + actions */}
          <div className="config-detail-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, minWidth: 0, minHeight: "var(--config-control-height)", flexWrap: "wrap" }}>
            <div className="config-detail-header-info" style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flexWrap: "nowrap" }}>
              {isCreating ? (
                <label style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--text-muted)", fontSize: 11 }}>
                  <span>{t("config.saveTo")}</span>
                  <ReaderFloatingSelect
                    value={draft.scope === "project" ? "project" : "global"}
                    onChange={(value) => {
                      const scope = value as "global" | "project";
                      newScopeRef.current = scope;
                      setDraft((profile) => ({ ...profile, scope }));
                    }}
                    options={[
                      { value: "global", label: t("agents.scope.global") },
                      { value: "project", label: t("agents.scope.project") },
                    ]}
                    ariaLabel={t("config.saveTo")}
                    disabled={saving}
                    appearance="field"
                    containerStyle={{ width: 120 }}
                    triggerStyle={{ height: 28, fontSize: 12 }}
                    optionFontSize={12}
                  />
                </label>
              ) : (
                <ConfigScopeTag scope={draft.scope}>
                  {draft.scope === "project"
                    ? t("agents.scope.project")
                    : draft.scope === "workspace"
                    ? t("agents.scope.workspace")
                    : draft.scope === "global"
                    ? t("agents.scope.global")
                    : draft.scope === "runtime"
                    ? t("agents.scope.runtimeBuiltin")
                    : t("agents.scope.readerBuiltin")}
                </ConfigScopeTag>
              )}
              {!isMobile && draft.filePath && (
                <code
                  style={{
                    fontSize: 11,
                    color: "var(--text-muted)",
                    fontFamily: "var(--font-mono)",
                    minWidth: 0,
                    flex: "1 1 0",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={draft.filePath}
                >
                  {draft.filePath}
                </code>
              )}
              {draft.filePath && onOpenFile && !isReadonlyProfile && (
                <button
                  type="button"
                  onClick={() => onOpenFile(draft.filePath!)}
                  title={t("settings.openInReaderTitle")}
                  aria-label={t("settings.openInReaderTitle")}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 22,
                    height: 22,
                    padding: 0,
                    boxSizing: "border-box",
                    flex: "0 0 22px",
                    borderRadius: 4,
                    border: "1px solid var(--border)",
                    background: "var(--bg-panel)",
                    color: "var(--accent, #3b82f6)",
                    cursor: "pointer",
                  }}
                >
                  <ExternalLink size={13} strokeWidth={2} />
                </button>
              )}
            </div>

            <div className="config-detail-actions">
              {!isCreating && (
                <ConfigButton
                  type="button"
                  onClick={handleDuplicate}
                >
                  <span>{t("agents.duplicate")}</span>
                </ConfigButton>
              )}
              {!isCreating && selectedProfile && isWritableScope(selectedProfile.scope) && (
                <ConfigButton variant="danger"
                  type="button"
                  onClick={handleDelete}
                >
                  <span>{t("agents.delete")}</span>
                </ConfigButton>
              )}
              <ConfigSwitch
                checked={draft.enabled}
                disabled={saving || (!isCreating && selectedProfile ? !isTogglableScope(selectedProfile.scope) : false)}
                label={t("agents.enable")}
                onChange={(enabled) => void handleToggleActive(enabled)}
              />
            </div>
          </div>

          {isReadonlyProfile && (
            <div
              style={{
                padding: "9px 11px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text-muted)",
                fontSize: 12,
                lineHeight: 1.45,
              }}
            >
              {selectedProfile?.scope === "workspace"
                ? t("agents.workspaceReadonly")
                : selectedProfile?.scope === "runtime"
                ? (isExternalRuntime ? t("agents.externalRuntimeReadonly") : t("agents.runtimeOverrideInfo"))
                : t("agents.builtinReadonly")}
            </div>
          )}

          {/* Fields: ID + Display Name */}
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 12 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
                {t("agents.name")}
              </label>
              <input
                type="text"
                value={draft.name}
                readOnly={isReadonlyProfile || !isCreating}
                onChange={(e) => setDraft((p) => ({ ...p, name: e.target.value }))}
                style={{
                  height: 34,
                  padding: "0 10px",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: "var(--bg)",
                  color: "var(--text)",
                  fontSize: 13,
                  fontFamily: "var(--font-mono)",
                }}
              />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
                {t("agents.displayName")}
              </label>
              <input
                type="text"
                value={draft.displayName}
                readOnly={isReadonlyProfile}
                onChange={(e) => setDraft((p) => ({ ...p, displayName: e.target.value }))}
                style={{
                  height: 34,
                  padding: "0 10px",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: "var(--bg)",
                  color: "var(--text)",
                  fontSize: 13,
                }}
              />
            </div>
          </div>

          {/* Model / Thinking */}
          {isExternalRuntime ? (
            <div style={{
              padding: "9px 11px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
              fontSize: 12,
              lineHeight: 1.45,
            }}>
              {t("agents.externalRuntimeReadonly")}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
                {t("agents.modelAndThinking")}
              </label>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: isMobile ? "1fr" : "minmax(0, 1.2fr) minmax(0, 1.5fr) minmax(130px, 0.9fr)",
                  gap: 10,
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <label style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("agents.providerLabel")}</label>
                  <ReaderFloatingSelect
                    value={currentPrimaryProvider}
                    disabled={!canEditModel}
                    onChange={(val) => handlePrimaryProviderChange(val)}
                    options={[
                      { value: "", label: t("agents.followParent") },
                      ...visibleProviderNames.map((provider) => ({ value: provider, label: provider })),
                      ...(currentPrimaryProvider && !visibleProviderNames.includes(currentPrimaryProvider)
                        ? [{ value: currentPrimaryProvider, label: currentPrimaryProvider }]
                        : []),
                    ]}
                    ariaLabel="Provider"
                    placement="below"
                    containerStyle={{ width: "100%" }}
                    triggerStyle={{
                      height: 34,
                      padding: "0 10px",
                      borderRadius: 6,
                      border: "1px solid var(--border)",
                      background: "var(--bg)",
                      color: "var(--text)",
                      fontSize: 13,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 6,
                      width: "100%",
                      boxSizing: "border-box",
                    }}
                  />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <label style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("agents.model")}</label>
                  <ReaderFloatingSelect
                    disabled={!canEditModel || !currentPrimaryProvider}
                    value={currentPrimaryModelId}
                    onChange={(val) => handlePrimaryModelChange(val)}
                    options={
                      !currentPrimaryProvider
                        ? [{ value: "", label: t("agents.followParentModel") }]
                        : [
                            ...primaryAvailableModels.map((model) => ({ value: model.id, label: model.name || model.id })),
                            ...(currentPrimaryModelId && !primaryAvailableModels.some((model) => model.id === currentPrimaryModelId)
                              ? [{ value: currentPrimaryModelId, label: currentPrimaryModelId }]
                              : []),
                          ]
                    }
                    ariaLabel={t("agents.model")}
                    placement="below"
                    containerStyle={{ width: "100%" }}
                    triggerStyle={{
                      height: 34,
                      padding: "0 10px",
                      borderRadius: 6,
                      border: "1px solid var(--border)",
                      background: "var(--bg)",
                      color: !currentPrimaryProvider ? "var(--text-dim)" : "var(--text)",
                      fontSize: 13,
                      cursor: !currentPrimaryProvider ? "not-allowed" : "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 6,
                      width: "100%",
                      boxSizing: "border-box",
                    }}
                  />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <label style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("agents.thinking")}</label>
                  {(() => {
                    const opts = getSupportedThinkingOptions(currentPrimaryProvider, currentPrimaryModelId);
                    const isUnsupported = Boolean(currentPrimaryProvider && currentPrimaryModelId && opts.length === 0);
                    const thinkingOptions = isUnsupported
                      ? [{ value: "", label: t("agents.thinkingUnsupported") }]
                      : [
                          { value: "", label: t("agents.followParent") },
                          ...opts.map((opt) => ({ value: opt.value, label: t(opt.labelKey) })),
                        ];
                    return (
                      <ReaderFloatingSelect
                        disabled={!canEditModel || isUnsupported}
                        value={isUnsupported ? "" : (draftEditableThinking ?? "")}
                        onChange={(val) => setDraft((profile) => withEditableThinking(profile, val || undefined))}
                        options={thinkingOptions}
                        ariaLabel={t("agents.thinking")}
                        placement="below"
                        containerStyle={{ width: "100%" }}
                        triggerStyle={{
                          height: 34,
                          padding: "0 10px",
                          borderRadius: 6,
                          border: "1px solid var(--border)",
                          background: "var(--bg)",
                          color: isUnsupported ? "var(--text-dim)" : "var(--text)",
                          fontSize: 13,
                          cursor: isUnsupported ? "not-allowed" : "pointer",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 6,
                          width: "100%",
                          boxSizing: "border-box",
                        }}
                      />
                    );
                  })()}
                </div>
              </div>
              {draft.modelSource && (
                <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
                  {draft.modelSource === "override"
                    ? t("agents.modelOverrideSource")
                    : draft.modelSource === "profile"
                    ? t("agents.modelProfileSource")
                    : draft.modelSource === "default"
                    ? t("agents.modelDefaultSource")
                    : t("agents.modelParentSource")}
                  {sessionEvidence?.loaded ? ` · ${sessionEvidence.provider}` : ` · ${t("agents.executionPending")}`}
                </div>
              )}
              {modelError && <div style={{ color: "#ef4444", fontSize: 11 }}>{modelError}</div>}
            </div>
          )}

          {/* Description */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
              {t("agents.description")}
            </label>
            <input
              type="text"
              value={draft.description}
              readOnly={isReadonlyProfile}
              onChange={(e) => setDraft((p) => ({ ...p, description: e.target.value }))}
              style={{
                height: 34,
                padding: "0 10px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--bg)",
                color: "var(--text)",
                fontSize: 13,
              }}
            />
          </div>

          {/* System Instruction */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
              {t("agents.prompt")}
            </label>
            <textarea
              value={draft.systemPrompt}
              readOnly={isReadonlyProfile}
              onChange={(e) => setDraft((p) => ({ ...p, systemPrompt: e.target.value }))}
              style={{
                width: "100%",
                height: 160,
                minHeight: 100,
                maxHeight: 280,
                padding: 10,
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--bg)",
                color: "var(--text)",
                fontSize: 12,
                lineHeight: 1.5,
                fontFamily: "var(--font-mono)",
                resize: "vertical",
              }}
            />
          </div>

          {/* Tools Checklist */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
                {t("agents.tools")}
              </label>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: isReadonlyProfile ? "not-allowed" : "pointer", fontSize: 11, color: "var(--text-muted)" }}>
                <input
                  type="checkbox"
                  checked={draft.toolsExplicit !== false}
                  disabled={isReadonlyProfile}
                  onChange={(e) => setDraft((p) => ({ ...p, toolsExplicit: e.target.checked }))}
                  style={{ accentColor: "var(--accent, #3b82f6)", cursor: isReadonlyProfile ? "not-allowed" : "pointer" }}
                />
                <span>{t("agents.explicitTools")}</span>
              </label>
            </div>
            {draft.toolsExplicit === false && (
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("agents.toolsInherited")}</span>
            )}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {BUILTIN_TOOLS.map((tool) => {
                const checked = draft.tools.includes(tool);
                return (
                  <label
                    key={tool}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "4px 10px",
                      borderRadius: 6,
                      border: checked ? "1px solid var(--accent, #3b82f6)" : "1px solid var(--border)",
                      background: checked ? "var(--bg-selected, rgba(59, 130, 246, 0.08))" : "var(--bg-panel)",
                      color: checked ? "var(--accent, #3b82f6)" : "var(--text)",
                      cursor: "pointer",
                      fontSize: 12,
                      fontWeight: checked ? 500 : 400,
                      userSelect: "none",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={isReadonlyProfile || draft.toolsExplicit === false}
                      onChange={() => toggleTool(tool)}
                      style={{ accentColor: "var(--accent, #3b82f6)", cursor: "pointer" }}
                    />
                    <span>{tool}</span>
                  </label>
                );
              })}
            </div>
          </div>

          {/* Native context and resource inheritance */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
              {t("agents.contextResources")}
            </label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 20 }}>
              {([
                ["inheritProjectContext", "agents.inheritProjectContext"],
                ["inheritGlobalContext", "agents.inheritGlobalContext"],
                ["inheritSkills", "agents.inheritSkills"],
              ] as const).map(([field, label]) => (
                <label key={field} style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 13, color: "var(--text)" }}>
                  <input
                    type="checkbox"
                    checked={draft[field]}
                    disabled={isReadonlyProfile}
                    onChange={(e) => setDraft((p) => ({ ...p, [field]: e.target.checked }))}
                    style={{ accentColor: "var(--accent, #3b82f6)", cursor: "pointer" }}
                  />
                  <span>{t(label)}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Inherit Context & Background */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 20 }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 13, color: "var(--text)" }}>
              <input
                type="checkbox"
                checked={draft.defaultContext === "fork"}
                disabled={isReadonlyProfile}
                onChange={(e) => setDraft((p) => ({ ...p, defaultContext: e.target.checked ? "fork" : "fresh" }))}
                style={{ accentColor: "var(--accent, #3b82f6)", cursor: "pointer" }}
              />
              <span>{t("agents.inheritContext")}</span>
            </label>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 13, color: "var(--text)" }}>
              <input
                type="checkbox"
                checked={draft.defaultAsync}
                disabled={isReadonlyProfile}
                onChange={(e) => setDraft((p) => ({ ...p, defaultAsync: e.target.checked }))}
                style={{ accentColor: "var(--accent, #3b82f6)", cursor: "pointer" }}
              />
              <span>{t("agents.background")}</span>
            </label>
          </div>

          {!isExternalRuntime && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 4, borderTop: "1px solid var(--border)" }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
                {t("agents.readerRuntime")}
              </label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 20px" }}>
                {([
                  ["loadSkills", "agents.loadSkills"],
                  ["loadExtensions", "agents.loadExtensions"],
                ] as const).map(([field, label]) => (
                  <label key={field} style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: isReadonlyProfile ? "not-allowed" : "pointer", fontSize: 13, color: "var(--text)" }}>
                    <input
                      type="checkbox"
                      checked={readerOptions(draft)[field]}
                      disabled={isReadonlyProfile}
                      onChange={(event) => updateReaderOptions({ [field]: event.target.checked } as Partial<ReaderNativeProfileOptions>)}
                      style={{ accentColor: "var(--accent, #3b82f6)", cursor: isReadonlyProfile ? "not-allowed" : "pointer" }}
                    />
                    <span>{t(label)}</span>
                  </label>
                ))}
                <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: isReadonlyProfile ? "not-allowed" : "pointer", fontSize: 13, color: "var(--text)" }}>
                  <input
                    type="checkbox"
                    checked={readerOptions(draft).mcp === "on"}
                    disabled={isReadonlyProfile || (readerChatOnly && draftReader.mcp !== "on")}
                    onChange={(event) => updateReaderOptions({ mcp: event.target.checked ? "on" : "off" })}
                    style={{ accentColor: "var(--accent, #3b82f6)", cursor: isReadonlyProfile ? "not-allowed" : "pointer" }}
                  />
                  <span>{t("agents.mcp")}</span>
                </label>
              </div>
              {readerChatOnly && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("agents.chatOnlyResources")}</span>}
              <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "minmax(0, 1fr) minmax(120px, 0.7fr)", gap: 10 }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "var(--text-dim)" }}>
                  <span>{t("agents.codemode")}</span>
                  <ReaderFloatingSelect
                    value={readerOptions(draft).codemode}
                    disabled={isReadonlyProfile}
                    onChange={(value) => updateReaderOptions({ codemode: value as ReaderNativeProfileOptions["codemode"] })}
                    options={[
                      { value: "inherit", label: t("agents.codemode.inherit") },
                      { value: "on", label: t("agents.codemode.on"), disabled: readerChatOnly && draftReader.codemode !== "on" },
                      { value: "off", label: t("agents.codemode.off") },
                    ]}
                    ariaLabel={t("agents.codemode")}
                    appearance="field"
                    triggerStyle={{ height: 34, fontSize: 13 }}
                    optionFontSize={13}
                  />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "var(--text-dim)" }}>
                  <span>{t("agents.maxTurns")}</span>
                  <input
                    type="number"
                    min={1}
                    value={readerOptions(draft).maxTurns ?? ""}
                    disabled={isReadonlyProfile}
                    onChange={(event) => updateReaderOptions({ maxTurns: event.target.value ? Number(event.target.value) : undefined })}
                    style={{ height: 34, padding: "0 8px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", fontSize: 13 }}
                  />
                </label>
              </div>
            </div>
          )}

        </div>
      </div>

      <div className="settings-form-footer">
        {error && (
          <span style={{ minWidth: 0, flex: 1, overflowWrap: "anywhere", fontSize: 12, color: "#f87171" }}>
            {error}
          </span>
        )}
        <ConfigButton
          type="button"
          onClick={() => {
            discard();
            onClose?.();
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
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
              style={{ strokeDasharray: 18, animation: "saved-check-draw 0.35s ease forwards", flexShrink: 0 }}>
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
          <span>{savedOk ? t("i18n.saved") : saving ? t("agents.saving") : t("agents.save")}</span>
        </ConfigButton>
      </div>
    </div>
  );

  if (embedded) return content;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0,0,0,0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div
        style={{
          width: isMobile ? "calc(100vw - 16px)" : 920,
          maxWidth: "calc(100vw - 16px)",
          height: isMobile ? "calc(100dvh - 16px)" : "80vh",
          maxHeight: "calc(100dvh - 16px)",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 18px",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>
            {t("common.agents")}
          </span>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              padding: 4,
            }}
          >
            <X size={18} />
          </button>
        </div>
        {content}
      </div>
    </div>
  );
}
