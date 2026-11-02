"use client";

import { useEffect, useState, useCallback, useRef, type DragEvent } from "react";
import { X, Plus, Trash2, Check, Sparkles, GripVertical, ExternalLink } from "lucide-react";
import { useI18n } from "@/hooks/useI18n";
import { ConfigButton } from "./SettingsUi";
import { CUSTOM_PROMPTS_CHANGED_EVENT } from "@/lib/custom-prompt-types";
import type { CustomPrompt } from "@/lib/custom-prompt-types";

export { CUSTOM_PROMPTS_CHANGED_EVENT };

const CUSTOM_PROMPTS_STORAGE_KEY = "pi-web:custom-prompts:v1";

function broadcastPromptsChanged(promptsList?: CustomPrompt[]) {
  if (promptsList && typeof window !== "undefined") {
    try {
      window.localStorage.setItem(CUSTOM_PROMPTS_STORAGE_KEY, JSON.stringify(promptsList));
    } catch {
      // LocalStorage access denied or quota exceeded
    }
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(CUSTOM_PROMPTS_CHANGED_EVENT));
    if (window.parent !== window) {
      window.parent.postMessage({ type: CUSTOM_PROMPTS_CHANGED_EVENT }, "*");
    }
    document.querySelectorAll("iframe").forEach((frame) => {
      try {
        frame.contentWindow?.postMessage({ type: CUSTOM_PROMPTS_CHANGED_EVENT }, "*");
      } catch (error) {
        console.warn("[PromptsConfig] failed to notify embedded frame:", error);
      }
    });
  }
}

export interface PromptsConfigProps {
  onClose?: () => void;
  onOpenFile?: (filePath: string) => void;
  remotePeer?: string;
  embedded?: boolean;
}

function shortenPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

export function PromptsConfig({ onClose, onOpenFile, remotePeer, embedded = false }: PromptsConfigProps) {
  const { t } = useI18n();
  const [prompts, setPrompts] = useState<CustomPrompt[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem(CUSTOM_PROMPTS_STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileExists, setFileExists] = useState(false);
  const [loadErrorMessage, setLoadErrorMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [formTitle, setFormTitle] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formContent, setFormContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [closeConfirmationOpen, setCloseConfirmationOpen] = useState(false);
  const [draggingPromptId, setDraggingPromptId] = useState<string | null>(null);
  const [dragOverPromptId, setDragOverPromptId] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);

  const titleInputRef = useRef<HTMLInputElement>(null);
  const initialFormRef = useRef({ title: "", description: "", content: "" });
  const hasUnsavedChanges = editingId !== null && (
    formTitle !== initialFormRef.current.title
    || formDescription !== initialFormRef.current.description
    || formContent !== initialFormRef.current.content
  );

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setErrorMessage(null);
    setCloseConfirmationOpen(false);
  }, []);

  const requestCloseEditor = useCallback(() => {
    if (saving) return;
    if (hasUnsavedChanges) setCloseConfirmationOpen(true);
    else cancelEdit();
  }, [cancelEdit, hasUnsavedChanges, saving]);

  const apiPath = useCallback((path: string) => {
    if (!remotePeer) return `/api/${path}`;
    const [pathname, rawQuery] = path.split("?", 2);
    const params = new URLSearchParams(rawQuery);
    params.set("peer", remotePeer);
    const query = params.toString();
    return `/api/remote/${pathname}${query ? `?${query}` : ""}`;
  }, [remotePeer]);

  const loadPrompts = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch(apiPath("custom-prompts"), { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (typeof data.filePath === "string") setFilePath(data.filePath);
      setFileExists(data.fileExists === true);
      if (!res.ok) throw new Error(data.error || "Failed to load prompts");
      if (!Array.isArray(data.prompts) || typeof data.filePath !== "string") throw new Error("Invalid custom prompts response");
      setPrompts(data.prompts);
      try {
        window.localStorage.setItem(CUSTOM_PROMPTS_STORAGE_KEY, JSON.stringify(data.prompts));
      } catch {
        // LocalStorage access denied or quota exceeded
      }
      setLoadErrorMessage(null);
    } catch (err) {
      setLoadErrorMessage(err instanceof Error ? err.message : String(err));
      console.warn("[PromptsConfig] failed to load prompts:", err);
    } finally {
      setLoading(false);
    }
  }, [apiPath]);

  useEffect(() => {
    loadPrompts();
    const handleChanged = () => loadPrompts();
    window.addEventListener(CUSTOM_PROMPTS_CHANGED_EVENT, handleChanged);
    return () => window.removeEventListener(CUSTOM_PROMPTS_CHANGED_EVENT, handleChanged);
  }, [loadPrompts]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (editingId) {
        e.preventDefault();
        e.stopPropagation();
        if (closeConfirmationOpen) setCloseConfirmationOpen(false);
        else requestCloseEditor();
        return;
      }
      if (!embedded) {
        e.preventDefault();
        onClose?.();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, editingId, embedded, closeConfirmationOpen, requestCloseEditor]);

  const startNew = () => {
    initialFormRef.current = { title: "", description: "", content: "" };
    setCloseConfirmationOpen(false);
    setEditingId("new");
    setFormTitle("");
    setFormDescription("");
    setFormContent("");
    setErrorMessage(null);
    setTimeout(() => titleInputRef.current?.focus(), 50);
  };

  const startEdit = (p: CustomPrompt) => {
    initialFormRef.current = { title: p.title, description: p.description ?? "", content: p.content };
    setCloseConfirmationOpen(false);
    setEditingId(p.id);
    setFormTitle(p.title);
    setFormDescription(p.description ?? "");
    setFormContent(p.content);
    setErrorMessage(null);
    setTimeout(() => titleInputRef.current?.focus(), 50);
  };

  const handleSave = async () => {
    if (!formTitle.trim() && !formContent.trim()) {
      setCloseConfirmationOpen(false);
      setErrorMessage(t("chat.promptTitleRequired") || "Title or content is required");
      return;
    }

    try {
      setSaving(true);
      setErrorMessage(null);
      const body = {
        id: editingId === "new" ? undefined : editingId,
        title: formTitle.trim() || formContent.trim().slice(0, 30),
        description: formDescription.trim() || undefined,
        content: formContent,
      };

      const res = await fetch(apiPath("custom-prompts"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "Failed to save prompt");
      }

      setEditingId(null);
      setCloseConfirmationOpen(false);
      await loadPrompts();
      broadcastPromptsChanged();
    } catch (err) {
      setCloseConfirmationOpen(false);
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm(t("prompts.confirmDelete") || "Are you sure you want to delete this prompt?")) {
      return;
    }

    try {
      const res = await fetch(apiPath(`custom-prompts?id=${encodeURIComponent(id)}`), {
        method: "DELETE",
      });
      if (res.ok) {
        await loadPrompts();
        broadcastPromptsChanged();
      }
    } catch (err) {
      console.warn("[PromptsConfig] failed to delete prompt:", err);
    }
  };

  const persistPromptOrder = useCallback(async (next: CustomPrompt[]) => {
    setPrompts(next);
    setReordering(true);

    try {
      const res = await fetch(apiPath("custom-prompts"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "reorder",
          orderedIds: next.map((prompt) => prompt.id),
        }),
      });
      if (res.ok) {
        broadcastPromptsChanged(next);
      } else {
        await loadPrompts();
      }
    } catch {
      await loadPrompts();
    } finally {
      setReordering(false);
    }
  }, [apiPath, loadPrompts]);

  const movePrompt = useCallback((sourceIndex: number, targetIndex: number) => {
    if (reordering || sourceIndex < 0 || targetIndex < 0 || targetIndex >= prompts.length || sourceIndex === targetIndex) return;

    const next = [...prompts];
    const [moved] = next.splice(sourceIndex, 1);
    if (!moved) return;
    next.splice(targetIndex, 0, moved);
    void persistPromptOrder(next);
  }, [persistPromptOrder, prompts, reordering]);

  const handlePromptDragStart = (event: DragEvent<HTMLElement>, id: string) => {
    if (reordering || (event.target instanceof Element && event.target.closest("button, a, input, textarea, select, [contenteditable=\"true\"]"))) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/custom-prompt-id", id);
    event.dataTransfer.setData("text/plain", id);
    setDraggingPromptId(id);
  };

  const handlePromptDragOver = (event: DragEvent<HTMLElement>, id: string) => {
    if (reordering || !draggingPromptId || id === draggingPromptId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDragOverPromptId(id);
  };

  const handlePromptDrop = (event: DragEvent<HTMLElement>, targetId: string) => {
    event.preventDefault();
    const sourceId = event.dataTransfer.getData("text/custom-prompt-id") || event.dataTransfer.getData("text/plain");
    setDraggingPromptId(null);
    setDragOverPromptId(null);
    if (!sourceId || sourceId === targetId || reordering) return;

    const sourceIndex = prompts.findIndex((prompt) => prompt.id === sourceId);
    const targetIndex = prompts.findIndex((prompt) => prompt.id === targetId);
    movePrompt(sourceIndex, targetIndex);
  };

  const handlePromptDragEnd = () => {
    setDraggingPromptId(null);
    setDragOverPromptId(null);
  };

  const isMobile = typeof window !== "undefined" && window.innerWidth < 640;

  const editorElement = editingId !== null && (
    <div
      className="prompts-config-editor-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) requestCloseEditor();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        if (closeConfirmationOpen) setCloseConfirmationOpen(false);
        else requestCloseEditor();
      }}
    >
      <div
        className="prompts-config-editor-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompts-config-editor-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div id="prompts-config-editor-title" style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>
          {editingId === "new" ? t("chat.addCustomPrompt") : t("chat.editCustomPrompt")}
        </div>

        {errorMessage && (
          <div style={{ fontSize: 12, color: "var(--danger, #ef4444)", padding: "6px 9px", background: "rgba(239,68,68,0.08)", borderRadius: 5 }}>
            {errorMessage}
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <label style={{ fontSize: 11, fontWeight: 500, color: "var(--text-muted)" }}>
            {t("chat.promptTitle")}
          </label>
          <input
            ref={titleInputRef}
            type="text"
            value={formTitle}
            onChange={(e) => setFormTitle(e.target.value)}
            placeholder={t("chat.promptTitlePlaceholder")}
            style={{
              padding: "8px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text)",
              fontSize: 13,
              outline: "none",
            }}
          />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <label style={{ fontSize: 11, fontWeight: 500, color: "var(--text-muted)" }}>
            {t("chat.promptDescription")}
          </label>
          <input
            type="text"
            value={formDescription}
            onChange={(e) => setFormDescription(e.target.value)}
            placeholder={t("chat.promptDescriptionPlaceholder")}
            style={{
              padding: "8px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text)",
              fontSize: 13,
              outline: "none",
            }}
          />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <label style={{ fontSize: 11, fontWeight: 500, color: "var(--text-muted)" }}>
            {t("chat.promptContent")}
          </label>
          <textarea
            value={formContent}
            onChange={(e) => setFormContent(e.target.value)}
            placeholder={t("chat.promptPlaceholder")}
            rows={10}
            style={{
              minHeight: 220,
              padding: "9px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text)",
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              resize: "vertical",
              outline: "none",
              lineHeight: 1.5,
            }}
          />
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 2 }}>
          <ConfigButton
            type="button"
            onClick={cancelEdit}
            disabled={saving}
          >
            {t("i18n.cancel")}
          </ConfigButton>
          <ConfigButton variant="primary"
            type="button"
            onClick={handleSave}
            disabled={saving}
          >
            <Check size={14} />
            {saving ? t("i18n.saving") : t("i18n.save")}
          </ConfigButton>
        </div>
      </div>
      {closeConfirmationOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="prompts-config-unsaved-title"
          style={{ position: "fixed", inset: 0, zIndex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, background: "rgba(0,0,0,0.18)" }}
          onClick={(event) => {
            event.stopPropagation();
            if (event.target === event.currentTarget) setCloseConfirmationOpen(false);
          }}
        >
          <div
            style={{ width: 440, maxWidth: "100%", boxSizing: "border-box", padding: "20px 22px", border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg)", boxShadow: "0 12px 36px rgba(0,0,0,0.28)", display: "flex", flexDirection: "column", gap: 14 }}
            onClick={(event) => event.stopPropagation()}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <h3 id="prompts-config-unsaved-title" style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--text)" }}>
                {t("settings.unsavedChangesTitle")}
              </h3>
              <button
                type="button"
                onClick={() => setCloseConfirmationOpen(false)}
                aria-label={t("i18n.close")}
                style={{ display: "grid", placeItems: "center", width: 28, height: 28, padding: 0, border: 0, borderRadius: 6, background: "transparent", color: "var(--text-muted)", cursor: "pointer" }}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {t("settings.unsavedChangesDesc")}
            </p>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
              <ConfigButton
                type="button"
                onClick={() => setCloseConfirmationOpen(false)}
              >
                {t("settings.continueEditing")}
              </ConfigButton>
              <ConfigButton
                type="button"
                onClick={cancelEdit}
              >
                {t("settings.discardAndClose")}
              </ConfigButton>
              <ConfigButton variant="primary"
                type="button"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? t("i18n.saving") : t("settings.saveAndClose")}
              </ConfigButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  const contentElement = (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Subheader / Action bar */}
      <div className="prompts-config-toolbar">
        <div className="prompts-config-toolbar-info">
          <span className="prompts-config-toolbar-title">
            {t("prompts.modalTitle")}
          </span>
          <div className="prompts-config-file-row">
            <code
              className="prompts-config-file-path"
              title={filePath ?? "~/.pi/agent/custom-prompts.json"}
            >
              {filePath ? shortenPath(filePath) : "~/.pi/agent/custom-prompts.json"}
            </code>
            {onOpenFile && filePath && (
              <button
                type="button"
                className="prompts-config-open-file"
                onClick={() => onOpenFile(filePath)}
                disabled={!fileExists}
                title={fileExists ? t("prompts.openFile") : t("prompts.fileNotCreated")}
                aria-label={fileExists ? t("prompts.openFile") : t("prompts.fileNotCreated")}
              >
                <ExternalLink size={13} strokeWidth={2} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <ConfigButton variant="primary"
            type="button"
            onClick={startNew}
          >
            <Plus size={14} />
            {t("chat.addCustomPrompt")}
          </ConfigButton>
          {!embedded && onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              title="Close"
              style={{
                background: "none",
                border: "none",
                color: "var(--text-muted)",
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "4px 6px",
              }}
            >
              <X size={18} strokeWidth={1.8} />
            </button>
          )}
        </div>
      </div>

      {/* Main List Body */}
      <div className="prompts-config-body">
        {/* List of prompts */}
        {loadErrorMessage ? (
          <div role="alert" style={{ padding: 12, border: "1px solid var(--danger, #ef4444)", borderRadius: 8, color: "var(--danger, #ef4444)", fontSize: 12 }}>
            {t("prompts.loadFailed")} {loadErrorMessage}
          </div>
        ) : loading && prompts.length === 0 ? (
          <div style={{ textAlign: "center", padding: "30px 0", color: "var(--text-muted)", fontSize: 13 }}>
            {t("chat.loadingCommands")}
          </div>
        ) : prompts.length === 0 && editingId === null ? (
          <div
            style={{
              textAlign: "center",
              padding: "40px 16px",
              border: "1px dashed var(--border)",
              borderRadius: 8,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 10,
            }}
          >
            <Sparkles size={24} style={{ color: "var(--text-muted)", opacity: 0.5 }} />
            <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
              {t("prompts.empty")}
            </div>
            <ConfigButton variant="primary"
              type="button"
              onClick={startNew}
            >
              + {t("chat.addCustomPrompt")}
            </ConfigButton>
          </div>
        ) : (
          <div className="prompts-config-list" role="list" aria-label={t("prompts.modalTitle")}>
            {prompts.map((item, index) => (
              <article
                key={item.id}
                className={`prompts-config-card${draggingPromptId === item.id ? " is-dragging" : ""}${dragOverPromptId === item.id ? " is-drop-target" : ""}`}
                draggable={!reordering}
                role="listitem"
                tabIndex={0}
                aria-label={`${item.title}. ${t("chat.dragPromptOrder")}`}
                aria-busy={reordering}
                onKeyDown={(event) => {
                  if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
                  event.preventDefault();
                  movePrompt(index, index + (event.key === "ArrowUp" ? -1 : 1));
                }}
                onDragStart={(event) => handlePromptDragStart(event, item.id)}
                onDragOver={(event) => handlePromptDragOver(event, item.id)}
                onDrop={(event) => handlePromptDrop(event, item.id)}
                onDragEnd={handlePromptDragEnd}
              >
                <div className="prompts-config-card-header">
                  <GripVertical className="prompts-config-card-grip" size={15} strokeWidth={1.8} aria-hidden="true" />
                  <div className="prompts-config-card-heading">
                    <span className="prompts-config-card-title" title={item.title}>{item.title}</span>
                    {item.description && (
                      <span className="prompts-config-card-description">{item.description}</span>
                    )}
                  </div>
                  <div className="prompts-config-card-actions">
                    <button
                      className="prompts-config-action is-danger"
                      type="button"
                      onClick={() => handleDelete(item.id)}
                      title={t("i18n.delete")}
                      aria-label={t("i18n.delete")}
                      draggable={false}
                    >
                      <Trash2 size={15} aria-hidden="true" />
                    </button>
                  </div>
                </div>

                <button
                  className="prompts-config-card-content"
                  type="button"
                  onClick={() => startEdit(item)}
                  title={t("chat.editCustomPrompt")}
                  aria-label={t("prompts.editNamed", { title: item.title })}
                  draggable={false}
                >
                  <pre>{item.content}</pre>
                </button>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  if (embedded) {
    return (
      <>
        {contentElement}
        {editorElement}
      </>
    );
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !editingId) onClose?.();
      }}
    >
      <div
        style={{
          width: isMobile ? "calc(100vw - 16px)" : 680,
          maxWidth: "calc(100vw - 16px)",
          height: isMobile ? "calc(100dvh - 16px)" : "80vh",
          maxHeight: "calc(100dvh - 16px)",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 10px 36px rgba(0,0,0,0.22)",
          overflow: "hidden",
        }}
      >
        {contentElement}
      </div>
      {editorElement}
    </div>
  );
}
