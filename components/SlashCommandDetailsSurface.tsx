"use client";

import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Check, Pencil, X } from "lucide-react";
import { useChatAppearance } from "@/hooks/useChatAppearance";
import { useI18n } from "@/hooks/useI18n";
import { CUSTOM_PROMPTS_CHANGED_EVENT, type CustomPromptEditValue } from "@/lib/custom-prompt-types";
import { isForeignNativeModalOwner } from "@/lib/extension-dialog-keyboard";
import { MarkdownBody } from "./MarkdownBody";
import { ConfigButton } from "./SettingsUi";

export interface SlashCommandDetailsView {
  label: string;
  content: string;
  loading: boolean;
  error: string | null;
  sourcePath?: string;
  cwd?: string;
  sessionId?: string;
  remotePeer?: string;
  editablePrompt?: CustomPromptEditValue;
}

export interface SlashCommandDetailsSurfaceProps extends SlashCommandDetailsView {
  onClose: () => void;
  dialogRef?: RefObject<HTMLDivElement | null>;
  onOpenFile?: (filePath: string, page?: number) => void;
  onCustomPromptSaved?: (prompt: CustomPromptEditValue) => void;
}

interface CustomPromptEditorProps {
  initialValue: CustomPromptEditValue;
  onSave: (prompt: CustomPromptEditValue) => Promise<void>;
  onClose: () => void;
}

function CustomPromptEditor({ initialValue, onSave, onClose }: CustomPromptEditorProps) {
  const { t } = useI18n();
  const [formTitle, setFormTitle] = useState(initialValue.title);
  const [formDescription, setFormDescription] = useState(initialValue.description);
  const [formContent, setFormContent] = useState(initialValue.content);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);

  const hasChanges = formTitle !== initialValue.title
    || formDescription !== initialValue.description
    || formContent !== initialValue.content;

  const requestClose = () => {
    if (saving) return;
    if (hasChanges) setConfirmClose(true);
    else onClose();
  };

  useLayoutEffect(() => {
    titleInputRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      if (confirmClose) setConfirmClose(false);
      else if (saving) return;
      else if (hasChanges) setConfirmClose(true);
      else onClose();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [confirmClose, hasChanges, onClose, saving]);

  const handleSave = async () => {
    if (!formTitle.trim() && !formContent.trim()) {
      setConfirmClose(false);
      setErrorMessage(t("chat.promptTitleRequired") || "Title or content is required");
      return;
    }

    const prompt = {
      id: initialValue.id,
      title: formTitle.trim() || formContent.trim().slice(0, 30),
      description: formDescription.trim(),
      content: formContent,
    } satisfies CustomPromptEditValue;

    try {
      setSaving(true);
      setErrorMessage(null);
      await onSave(prompt);
      onClose();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const discardChanges = () => {
    if (saving) return;
    setConfirmClose(false);
    onClose();
  };

  return (
    <div
      className="prompts-config-editor-backdrop"
      data-custom-prompt-editor
      role="presentation"
      style={{ zIndex: 1500 }}
      onClick={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div
        className="prompts-config-editor-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="slash-custom-prompt-editor-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <div id="slash-custom-prompt-editor-title" style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>
            {t("chat.editCustomPrompt")}
          </div>
          <ConfigButton variant="ghost" size="small" className="config-button-icon"
            type="button"
            onClick={requestClose}
            disabled={saving}
            aria-label={t("i18n.close")}
            title={t("i18n.close")}
          >
            <X size={15} aria-hidden="true" />
          </ConfigButton>
        </div>

        {errorMessage && (
          <div role="alert" style={{ fontSize: 12, color: "var(--danger, #ef4444)", padding: "6px 9px", background: "rgba(239,68,68,0.08)", borderRadius: 5 }}>
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
            onChange={(event) => setFormTitle(event.target.value)}
            placeholder={t("chat.promptTitlePlaceholder")}
            style={{ padding: "8px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontSize: 13, outline: "none" }}
          />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <label style={{ fontSize: 11, fontWeight: 500, color: "var(--text-muted)" }}>
            {t("chat.promptDescription")}
          </label>
          <input
            type="text"
            value={formDescription}
            onChange={(event) => setFormDescription(event.target.value)}
            placeholder={t("chat.promptDescriptionPlaceholder")}
            style={{ padding: "8px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontSize: 13, outline: "none" }}
          />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <label style={{ fontSize: 11, fontWeight: 500, color: "var(--text-muted)" }}>
            {t("chat.promptContent")}
          </label>
          <textarea
            value={formContent}
            onChange={(event) => setFormContent(event.target.value)}
            placeholder={t("chat.promptPlaceholder")}
            rows={10}
            style={{ minHeight: 220, padding: "9px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontSize: 12, fontFamily: "var(--font-mono)", resize: "vertical", outline: "none", lineHeight: 1.5 }}
          />
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 2 }}>
          <ConfigButton
            type="button"
            onClick={requestClose}
            disabled={saving}
          >
            {t("i18n.cancel")}
          </ConfigButton>
          <ConfigButton variant="primary"
            type="button"
            onClick={handleSave}
            disabled={saving}
          >
            <Check size={14} aria-hidden="true" />
            {saving ? t("i18n.saving") : t("i18n.save")}
          </ConfigButton>
        </div>
      </div>

      {confirmClose && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="slash-custom-prompt-unsaved-title"
          style={{ position: "fixed", inset: 0, zIndex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, background: "rgba(0,0,0,0.18)" }}
          onClick={(event) => {
            event.stopPropagation();
            if (event.target === event.currentTarget) setConfirmClose(false);
          }}
        >
          <div
            style={{ width: 440, maxWidth: "100%", boxSizing: "border-box", padding: "20px 22px", border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg)", boxShadow: "0 12px 36px rgba(0,0,0,0.28)", display: "flex", flexDirection: "column", gap: 14 }}
            onClick={(event) => event.stopPropagation()}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <h3 id="slash-custom-prompt-unsaved-title" style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--text)" }}>
                {t("settings.unsavedChangesTitle")}
              </h3>
              <button
                type="button"
                onClick={() => setConfirmClose(false)}
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
                onClick={() => setConfirmClose(false)}
              >
                {t("settings.continueEditing")}
              </ConfigButton>
              <ConfigButton variant="danger"
                type="button"
                onClick={discardChanges}
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
}

/**
 * The slash detail surface is a document-level modal.  ChatInput may live in
 * an embedded Reader iframe, so keeping this fixed element inside the input
 * layout would make it cover only the right-hand iframe viewport.  The
 * presentation is therefore rendered through the owning document body; an
 * embedded child forwards the view data to AppShell, which mounts the same
 * surface in the outer document.
 */
export function SlashCommandDetailsSurface({
  label,
  content,
  loading,
  error,
  sourcePath,
  cwd,
  sessionId,
  remotePeer,
  editablePrompt: editablePromptProp,
  onClose,
  dialogRef,
  onOpenFile,
  onCustomPromptSaved,
}: SlashCommandDetailsSurfaceProps) {
  const { t } = useI18n();
  useChatAppearance();
  const [currentEditablePrompt, setCurrentEditablePrompt] = useState<CustomPromptEditValue | undefined>(editablePromptProp);
  const [promptEditorOpen, setPromptEditorOpen] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const previousActiveElementRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setCurrentEditablePrompt((current) => {
      if (!editablePromptProp) return undefined;
      if (
        current?.id === editablePromptProp.id
        && current.title === editablePromptProp.title
        && current.description === editablePromptProp.description
        && current.content === editablePromptProp.content
      ) return current;
      return editablePromptProp;
    });
  }, [editablePromptProp?.content, editablePromptProp?.description, editablePromptProp?.id, editablePromptProp?.title]);

  const handleSaveCustomPrompt = async (prompt: CustomPromptEditValue) => {
    const requestUrl = new URL(
      remotePeer ? "/api/remote/custom-prompts" : "/api/custom-prompts",
      window.location.origin,
    );
    if (remotePeer) requestUrl.searchParams.set("peer", remotePeer);
    if (
      requestUrl.origin !== window.location.origin
      || !["/api/custom-prompts", "/api/remote/custom-prompts"].includes(requestUrl.pathname)
    ) {
      throw new Error("Invalid custom prompts endpoint");
    }
    const response = await fetch(requestUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: prompt.id,
        title: prompt.title,
        description: prompt.description || undefined,
        content: prompt.content,
      }),
    });
    const data = await response.json().catch(() => ({})) as { error?: unknown; prompts?: unknown };
    if (!response.ok) {
      throw new Error(typeof data.error === "string" ? data.error : "Failed to save prompt");
    }
    if (Array.isArray(data.prompts) && typeof window !== "undefined") {
      try {
        window.localStorage.setItem("pi-web:custom-prompts:v1", JSON.stringify(data.prompts));
      } catch {
        // LocalStorage access denied or quota exceeded.
      }
    }
    setCurrentEditablePrompt(prompt);
    onCustomPromptSaved?.(prompt);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(CUSTOM_PROMPTS_CHANGED_EVENT));
    }
  };
  useLayoutEffect(() => {
    if (previousActiveElementRef.current === null) {
      previousActiveElementRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    }
    closeButtonRef.current?.focus({ preventScroll: true });
    return () => {
      const previous = previousActiveElementRef.current;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    // Capture phase keeps Escape owned by this modal and prevents the global
    // composer handler from stopping a running agent underneath it.
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (
        document.querySelector("[data-image-preview-close-controls], [data-file-viewer-modal], [data-custom-prompt-editor]")
        || (dialogRef && isForeignNativeModalOwner(event.target, document.activeElement, dialogRef.current))
      ) return;
      event.stopPropagation();
      if (event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [dialogRef, onClose]);

  const detailLabel = currentEditablePrompt?.title ?? label;
  const detailContent = currentEditablePrompt?.content ?? content;

  const surface = (
    <>
    <div
      role="presentation"
      data-slash-command-details-backdrop
      onPointerDown={(event) => {
        if (event.target !== event.currentTarget) event.stopPropagation();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1400,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        boxSizing: "border-box",
        background: "rgba(0,0,0,0.4)",
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("chat.slashCommandDetails")}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        style={{
          width: 620,
          maxWidth: "100%",
          maxHeight: "min(80vh, 720px)",
          display: "flex",
          flexDirection: "column",
          border: "1px solid var(--border)",
          borderRadius: 9,
          background: "var(--bg-panel)",
          boxShadow: "0 12px 36px rgba(0,0,0,0.24)",
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
          <strong style={{ minWidth: 0, flex: 1, overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--text)" }}>
            {detailLabel}
          </strong>
          {currentEditablePrompt && !loading && !error && (
            <button
              ref={editButtonRef}
              type="button"
              aria-label={t("chat.editCustomPrompt")}
              title={t("chat.editCustomPrompt")}
              onClick={() => setPromptEditorOpen(true)}
              style={{ display: "grid", placeItems: "center", width: 28, height: 28, padding: 0, border: "1px solid var(--border)", borderRadius: 6, background: "transparent", color: "var(--text-muted)", cursor: "pointer" }}
            >
              <Pencil size={15} aria-hidden="true" />
            </button>
          )}
          <button
            ref={closeButtonRef}
            type="button"
            aria-label={t("chat.closeSlashCommandDetails")}
            title={t("chat.closeSlashCommandDetails")}
            onClick={onClose}
            style={{ display: "grid", placeItems: "center", width: 28, height: 28, padding: 0, border: "1px solid var(--border)", borderRadius: 6, background: "transparent", color: "var(--text-muted)", cursor: "pointer" }}
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
        <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: "12px 14px", overflowWrap: "anywhere", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.6 }}>
          {loading ? t("chat.loadingSlashCommandDetails") : error ? (
            <div role="alert">{error}</div>
          ) : (
            <MarkdownBody cwd={cwd} sessionId={sessionId} remotePeer={remotePeer} onOpenFile={onOpenFile}>{detailContent || "\u2014"}</MarkdownBody>
          )}
        </div>
        {sourcePath && (
          <div style={{ flexShrink: 0, padding: "8px 14px", borderTop: "1px solid var(--border)", color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 10, overflowWrap: "anywhere" }}>
            {sourcePath}
          </div>
        )}
      </div>
    </div>
    {promptEditorOpen && currentEditablePrompt && (
      <CustomPromptEditor
        initialValue={currentEditablePrompt}
        onSave={handleSaveCustomPrompt}
        onClose={() => {
          setPromptEditorOpen(false);
          requestAnimationFrame(() => editButtonRef.current?.focus({ preventScroll: true }));
        }}
      />
    )}
    </>
  );

  // Server-side rendering has no document and therefore no portal target. The
  // direct return keeps static rendering/tests deterministic; browsers always
  // mount the surface at the document root.
  return typeof document === "undefined" ? surface : createPortal(surface, document.body);
}
