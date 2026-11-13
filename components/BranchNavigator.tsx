"use client";

import { useState, useCallback, useMemo } from "react";
import type { BranchPreview, SessionEntry, SessionTreeNode } from "@/lib/types";
import { useI18n } from "@/hooks/useI18n";

interface Props {
  tree: SessionTreeNode[];
  activeLeafId: string | null;
  onLeafChange: (leafId: string | null) => void;
  /** When true, renders as a compact inline button for embedding in a top bar */
  inline?: boolean;
  /** Controlled open state for inline mode */
  open?: boolean;
  /** Called when the button is clicked in inline mode */
  onToggle?: () => void;
  /** Whether a session is currently active (used to show appropriate empty reason) */
  hasSession?: boolean;
  /** When inline, render icon-only (no text label) to save horizontal space */
  compact?: boolean;
  /** Keep the inline dropdown mounted while another control supplies its trigger */
  hideInlineButton?: boolean;
  /** Disable branch switching while the session is running. */
  busy?: boolean;
  /** Keeps the tree readable while a live run prevents navigation. */
  locked?: boolean;
}

/** Display stored automatic titles in the current language without rewriting history. */
export function formatSideBranchTitle(title: string, t: (key: string, params?: Record<string, string | number>) => string): string {
  const snippet = title.match(/^(?:临时|分支|Branch)[:：]\s*(.*)$/);
  if (snippet) return t("chat.sideTabTitleFromText", { text: snippet[1] });
  const numbered = title.match(/^(?:分支|Branch)\s+(\d+)$/);
  return numbered ? t("chat.sideTabTitleNumbered", { index: numbered[1] }) : title;
}

// Find the visible entry IDs on the path from root to activeLeafId.
export function buildActivePath(nodes: SessionTreeNode[], targetId: string | null): Set<string> {
  if (!targetId) return new Set();
  const target = targetId;
  const stack: { node: SessionTreeNode; path: string[] }[] = nodes.map((n) => ({ node: n, path: [n.entry.id] }));
  while (stack.length > 0) {
    const { node, path } = stack.pop()!;
    if (node.entry.id === target || node.compressedEntryIds?.includes(target)) {
      return new Set(path);
    }
    for (const child of node.children) {
      stack.push({ node: child, path: [...path, child.entry.id] });
    }
  }
  return new Set();
}

// The SDK orders siblings by timestamp, so the last leaf in timeline order is
// the session's current main line. Invalid timestamps fall back to tree order.
export function findLatestLeafId(nodes: SessionTreeNode[]): string | null {
  const leaves: Array<{ id: string; timestamp: number }> = [];
  const pending = [...nodes].reverse();

  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.children.length > 0) {
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        pending.push(node.children[index]);
      }
      continue;
    }

    leaves.push({ id: node.entry.id, timestamp: Date.parse(node.entry.timestamp) });
  }

  if (leaves.length === 0) return null;
  if (leaves.some((leaf) => !Number.isFinite(leaf.timestamp))) return leaves[leaves.length - 1].id;

  let latest = leaves[0]!;
  for (let index = 1; index < leaves.length; index += 1) {
    if (leaves[index]!.timestamp >= latest.timestamp) latest = leaves[index]!;
  }
  return latest.id;
}

export function isMessageEntry(entry: SessionEntry): boolean {
  return entry.type === "message" && "message" in entry && entry.message.role !== "system";
}

// Compress a visible linear chain into the first branching/leaf node.
// Server-side compressed IDs also count as skipped nodes.
// branchPreview is the bounded preview of the first message on the source
// chain. labelEntry keeps unprojected/test shapes working as a fallback.
export function compressChain(node: SessionTreeNode): {
  node: SessionTreeNode;
  skipped: number;
  branchPreview?: BranchPreview;
  labelEntry: SessionEntry;
} {
  let current = node;
  let branchPreview = current.branchPreview;
  let labelEntry: SessionEntry | null = isMessageEntry(current.entry) ? current.entry : null;
  let skipped = current.compressedEntryIds?.length ?? 0;
  while (current.children.length === 1) {
    current = current.children[0];
    branchPreview ??= current.branchPreview;
    if (!labelEntry && isMessageEntry(current.entry)) labelEntry = current.entry;
    skipped += 1 + (current.compressedEntryIds?.length ?? 0);
  }
  return { node: current, skipped, branchPreview, labelEntry: labelEntry ?? current.entry };
}

// Top-level rows of the panel: with multiple roots (a branch was started from
// the very first message) the roots themselves are the branches; otherwise the
// children of the first branching node.
export function selectTopLevelBranches(tree: SessionTreeNode[]): SessionTreeNode[] {
  if (tree.length > 1) return tree;
  if (tree.length === 0) return [];
  const first = compressChain(tree[0]).node;
  return first.children.length > 1 ? first.children : [];
}

export function countBranches(tree: SessionTreeNode[]): number {
  return selectTopLevelBranches(tree).length;
}

export function getLabel(entry: SessionEntry): string {
  if (entry.type === "message" && "message" in entry) {
    const msg = entry.message as { role: string; content: unknown };
    const content = msg.content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join(" ");
    }
    if (text.length > 80) text = text.slice(0, 80) + "…";
    if (text) return text;
    if (msg.role === "assistant") return "[assistant]";
  }
  return entry.type;
}

// Does the tree have any branching at all?
export function hasSessionBranches(nodes: SessionTreeNode[]): boolean {
  // Sessions branched from the very first message have multiple root nodes.
  if (nodes.length > 1) return true;
  const stack: SessionTreeNode[] = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.children.length > 1) return true;
    for (const child of node.children) stack.push(child);
  }
  return false;
}

interface TreeNodeProps {
  node: SessionTreeNode;
  activeLeafId: string | null;
  activePathIds: Set<string>;
  depth: number;
  isLast: boolean;
  parentLines: boolean[]; // whether ancestor at each depth has more siblings after
  onSelect?: (id: string) => void;
}

function TreeNodeView({ node, activeLeafId, activePathIds, depth, isLast, parentLines, onSelect }: TreeNodeProps) {
  const { t } = useI18n();
  const { node: rep, skipped, branchPreview, labelEntry } = compressChain(node);
  const isCurrent = Boolean(
    activeLeafId && (
      rep.entry.id === activeLeafId ||
      node.entry.id === activeLeafId ||
      (rep.compressedEntryIds?.includes(activeLeafId) ?? false) ||
      (node.compressedEntryIds?.includes(activeLeafId) ?? false)
    )
  );
  const isOnPath = activePathIds.has(node.entry.id) || activePathIds.has(rep.entry.id);
  const isAlternative = !isOnPath && !isCurrent;
  const label = branchPreview?.text ?? getLabel(labelEntry);
  const role = branchPreview
    ? branchPreview.role ?? null
    : isMessageEntry(labelEntry)
      ? (labelEntry as { message: { role: string } }).message.role
      : null;

  const fullTitle = [
    isCurrent ? `[${t("branches.current")}]` : isOnPath ? `[${t("branches.historyPath")}]` : `[${t("branches.alternative")}]`,
    role ? `(${role})` : "",
    skipped > 0 ? `+${skipped}` : "",
    label,
  ].filter(Boolean).join(" ");

  return (
    <div>
      {/* This node row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          height: 28,
          padding: "0 6px",
          borderRadius: 4,
          cursor: onSelect ? "pointer" : "default",
          background: isCurrent ? "var(--bg-selected)" : "transparent",
          borderLeft: isCurrent ? "2px solid var(--accent)" : "2px solid transparent",
          transition: "background 0.12s, border-color 0.12s",
          whiteSpace: "nowrap",
          userSelect: "none",
        }}
        onClick={onSelect ? () => onSelect(rep.entry.id) : undefined}
        onMouseEnter={(event) => {
          if (onSelect && !isCurrent) event.currentTarget.style.background = "var(--bg-hover)";
        }}
        onMouseLeave={(event) => {
          if (onSelect && !isCurrent) event.currentTarget.style.background = "transparent";
        }}
        title={fullTitle}
      >
        {/* Indent guide lines */}
        {parentLines.map((hasLine, i) => (
          <div key={i} style={{ width: 16, flexShrink: 0, position: "relative", height: "100%", alignSelf: "stretch" }}>
            {hasLine && (
              <div style={{
                position: "absolute",
                left: 7,
                top: 0,
                bottom: 0,
                width: 1,
                background: "var(--border)",
              }} />
            )}
          </div>
        ))}

        {/* Branch connector */}
        <div style={{ width: 16, flexShrink: 0, position: "relative", height: "100%", alignSelf: "stretch" }}>
          {/* vertical line up (to parent) */}
          <div style={{
            position: "absolute",
            left: 7,
            top: 0,
            bottom: isLast ? "50%" : 0,
            width: 1,
            background: isOnPath ? "rgba(37,99,235,0.4)" : "var(--border)",
          }} />
          {/* horizontal line to node */}
          <div style={{
            position: "absolute",
            left: 7,
            top: "50%",
            width: 9,
            height: 1,
            background: isOnPath ? "rgba(37,99,235,0.4)" : "var(--border)",
          }} />
        </div>

        {/* Node dot container */}
        <div style={{
          width: 14,
          height: 14,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          marginRight: 6,
        }}>
          {isCurrent ? (
            /* Current active leaf: double ring halo target */
            <div style={{
              width: 12,
              height: 12,
              borderRadius: "50%",
              background: "rgba(37, 99, 235, 0.18)",
              border: "1.5px solid var(--accent)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}>
              <div style={{
                width: 5,
                height: 5,
                borderRadius: "50%",
                background: "var(--accent)",
              }} />
            </div>
          ) : isOnPath ? (
            /* Ancestor on active path: solid neutral dot */
            <div style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "var(--text-muted)",
            }} />
          ) : (
            /* Inactive branch: hollow circle */
            <div style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: "transparent",
              border: "1.5px solid var(--border)",
            }} />
          )}
        </div>

        {/* Role badge */}
        {role && (
          <span style={{
            fontSize: 9,
            fontFamily: "var(--font-mono)",
            color: role === "user" ? "var(--accent)" : "var(--text-dim)",
            background: role === "user" ? "rgba(37,99,235,0.08)" : "var(--bg-hover)",
            border: `1px solid ${role === "user" ? "rgba(37,99,235,0.2)" : "var(--border)"}`,
            borderRadius: 3,
            padding: "0 4px",
            marginRight: 5,
            flexShrink: 0,
            lineHeight: "16px",
          }}>
            {role === "user" ? "U" : role === "assistant" ? "A" : role.slice(0, 1).toUpperCase()}
          </span>
        )}

        {/* Skipped indicator */}
        {skipped > 0 && (
          <span style={{ fontSize: 10, color: "var(--text-dim)", marginRight: 5, flexShrink: 0 }}>
            +{skipped}
          </span>
        )}

        {/* Label */}
        <span style={{
          fontSize: 11,
          color: isCurrent ? "var(--text)" : isOnPath ? "var(--text)" : "var(--text-muted)",
          fontWeight: isCurrent ? 600 : 400,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: 1,
          minWidth: 100,
        }}>
          {label}
        </span>

        {/* Current branch badge */}
        {isCurrent && (
          <span style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 3,
            fontSize: 10,
            color: "var(--accent)",
            background: "rgba(37,99,235,0.1)",
            border: "1px solid rgba(37,99,235,0.25)",
            borderRadius: 10,
            padding: "1px 6px",
            marginLeft: 8,
            flexShrink: 0,
            fontWeight: 500,
            lineHeight: "14px",
          }}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <span>{t("branches.current")}</span>
          </span>
        )}
      </div>

      {/* Children */}
      {rep.children.map((child, idx) => (
        <TreeNodeView
          key={child.entry.id}
          node={child}
          activeLeafId={activeLeafId}
          activePathIds={activePathIds}
          depth={depth + 1}
          isLast={idx === rep.children.length - 1}
          parentLines={[...parentLines, !isLast]}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

interface BranchPanelProps {
  tree: SessionTreeNode[];
  activeLeafId: string | null;
  onLeafChange: (leafId: string | null) => void;
  onToggle?: () => void;
  hasSession?: boolean;
  busy?: boolean;
  locked?: boolean;
}

function BranchPanelContent({ tree, activeLeafId, onLeafChange, onToggle, hasSession, busy = false, locked = false }: BranchPanelProps) {
  const { t } = useI18n();
  const resolvedActiveLeafId = useMemo(
    () => activeLeafId ?? findLatestLeafId(tree),
    [activeLeafId, tree]
  );
  const activePathIds = useMemo(
    () => buildActivePath(tree, resolvedActiveLeafId),
    [tree, resolvedActiveLeafId]
  );
  const branchSwitchLocked = busy || locked;
  const handleSelect = useCallback((id: string) => {
    if (branchSwitchLocked) return;
    onLeafChange(id);
    onToggle?.();
  }, [branchSwitchLocked, onLeafChange, onToggle]);
  const selectBranch = branchSwitchLocked ? undefined : handleSelect;
  const lockedNotice = branchSwitchLocked && (
    <div style={{ padding: "4px 2px 6px", fontSize: 11, color: "var(--text-dim)", fontStyle: "italic" }}>
      {t("i18n.branchesLockedWhileRunning")}
    </div>
  );
  const noBranchReason = !hasSession
    ? t("i18n.noActiveSession")
    : !hasSessionBranches(tree)
      ? t("i18n.noBranches")
      : null;
  const branchCount = countBranches(tree);
  const hasContent = !noBranchReason && tree.length > 0;
  const branchIcon = (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: hasContent ? "var(--accent)" : "var(--text-dim)", flexShrink: 0 }}>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
  const headerLegend = (
    <div style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "4px 4px 8px 4px",
      marginBottom: 6,
      borderBottom: "1px solid var(--border)",
      fontSize: 11,
      color: "var(--text-muted)",
      gap: 12,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, color: "var(--text)" }}>
        {branchIcon}
        <span>{t("i18n.branches")}</span>
        {branchCount > 0 && (
          <span style={{
            fontSize: 10,
            background: "rgba(37,99,235,0.1)",
            color: "var(--accent)",
            padding: "0 5px",
            borderRadius: 8,
            fontWeight: 500,
          }}>
            {branchCount}
          </span>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 10, color: "var(--text-dim)" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--accent)", boxShadow: "0 0 0 2px rgba(37,99,235,0.25)", display: "inline-block" }} />
          {t("branches.current")}
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--text-muted)", display: "inline-block" }} />
          {t("branches.historyPath")}
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", border: "1.5px solid var(--border)", background: "transparent", display: "inline-block" }} />
          {t("branches.alternative")}
        </span>
      </div>
    </div>
  );

  return hasContent ? (
    <div style={{ minWidth: "max-content" }}>
      {headerLegend}
      {lockedNotice}
      {tree.map((child, idx) => (
        <TreeNodeView
          key={child.entry.id}
          node={child}
          activeLeafId={resolvedActiveLeafId}
          activePathIds={activePathIds}
          depth={0}
          isLast={idx === tree.length - 1}
          parentLines={[]}
          onSelect={selectBranch}
        />
      ))}
    </div>
  ) : (
    <div style={{ padding: "10px 0", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
      {noBranchReason}
    </div>
  );
}

export function BranchNavigatorPanel(props: BranchPanelProps) {
  const { t } = useI18n();
  return (
    <section
      role="dialog"
      aria-label={t("i18n.branches")}
      style={{
        maxHeight: "min(600px, 75dvh)",
        overflow: "auto",
        background: "var(--bg-panel)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div style={{ padding: "12px 16px" }}>
        <BranchPanelContent {...props} />
      </div>
    </section>
  );
}

export function BranchNavigator({ tree, activeLeafId, onLeafChange, inline, open: openProp, onToggle, hasSession, compact, hideInlineButton, busy = false, locked = false }: Props) {
  const { t } = useI18n();
  const [openInternal, setOpenInternal] = useState(false);
  const open = openProp !== undefined ? openProp : openInternal;
  const branchCount = countBranches(tree);
  const hasContent = Boolean(hasSession && hasSessionBranches(tree) && tree.length > 0);
  const branchIcon = (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: hasContent ? "var(--accent)" : "var(--text-dim)", flexShrink: 0 }}>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
  const chevron = (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 2, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
      <polyline points="2 3.5 5 6.5 8 3.5" />
    </svg>
  );

  if (inline) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "stretch" }}>
        <button
          disabled={busy || hideInlineButton}
          onClick={() => {
            if (busy || hideInlineButton) return;
            if (onToggle) onToggle();
            else setOpenInternal((v) => !v);
          }}
          style={{
            display: hideInlineButton ? "none" : "flex",
            alignItems: "center",
            gap: 6,
            height: "100%",
            padding: "0 12px",
            background: open ? "var(--bg-selected)" : "none",
            border: "none",
            borderTop: open ? "2px solid var(--accent)" : "2px solid transparent",
            borderRight: "1px solid var(--border)",
            cursor: busy ? "not-allowed" : "pointer",
            color: open ? "var(--text)" : "var(--text-muted)",
            fontSize: 11,
            whiteSpace: "nowrap",
            opacity: busy ? 0.45 : 1,
            transition: "color 0.1s, background 0.1s, opacity 0.1s",
          }}
          onMouseEnter={(e) => { if (!busy) e.currentTarget.style.color = "var(--text)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = open ? "var(--text)" : "var(--text-muted)"; }}
          title={busy ? t("chat.sessionBusyDisabled") : t("i18n.branches")}
          aria-label={t("i18n.branches")}
          aria-haspopup="dialog"
          aria-expanded={open}
        >
          {branchIcon}
          {!compact && <span>{t("i18n.branches")}</span>}
        </button>
      </div>
    );
  }

  return (
    <div style={{ borderBottom: "1px solid var(--border)", background: "var(--bg)", flexShrink: 0, position: "relative" }}>
      <button
        disabled={busy}
        onClick={() => {
          if (busy) return;
          setOpenInternal((v) => !v);
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          padding: "5px 12px",
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "var(--text-muted)",
          fontSize: 11,
          textAlign: "left",
        }}
      >
        {branchIcon}
        <span style={{ color: "var(--text-muted)" }}>{t("i18n.branches")}</span>
        {branchCount > 0 && <span style={{ color: "var(--accent)", fontSize: 10, fontWeight: 600 }}>{branchCount}</span>}
        {chevron}
      </button>
      {open && (
        <div style={{
          position: "absolute",
          top: "100%",
          left: 0,
          right: 0,
          background: "var(--bg)",
          borderBottom: "1px solid var(--border)",
          boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
          zIndex: 100,
        }}>
          <div style={{ padding: "6px 12px 8px 12px", maxHeight: 320, overflow: "auto" }}>
            <BranchPanelContent
              tree={tree}
              activeLeafId={activeLeafId}
              onLeafChange={onLeafChange}
              onToggle={() => setOpenInternal(false)}
              hasSession={hasSession}
              busy={busy}
              locked={locked}
            />
          </div>
        </div>
      )}
    </div>
  );
}
