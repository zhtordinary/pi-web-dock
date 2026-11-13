"use client";

import { useI18n } from "@/hooks/useI18n";

interface ResourceToolbarProps {
  cwd: string | null;
  onOpenModels: () => void;
  onOpenSkills: () => void;
  onOpenPlugins: () => void;
  onOpenAgents: () => void;
}

/** Resource navigation owns the four context-dependent settings entry points. */
export function ResourceToolbar({
  cwd,
  onOpenModels,
  onOpenSkills,
  onOpenPlugins,
  onOpenAgents,
}: ResourceToolbarProps) {
  const { t } = useI18n();
  const actions = [
    {
      label: t("common.models"),
      onClick: onOpenModels,
      disabled: false,
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" />
          <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
          <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
          <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
          <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
        </svg>
      ),
    },
    {
      label: t("common.skills"),
      onClick: onOpenSkills,
      disabled: !cwd,
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2L2 7l10 5 10-5-10-5z" />
          <path d="M2 17l10 5 10-5" />
          <path d="M2 12l10 5 10-5" />
        </svg>
      ),
    },
    {
      label: t("common.plugins"),
      onClick: onOpenPlugins,
      disabled: !cwd,
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 7V2" />
          <path d="M15 7V2" />
          <path d="M6 13V8a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v5a6 6 0 0 1-12 0Z" />
          <path d="M12 19v3" />
        </svg>
      ),
    },
    {
      label: t("common.agents"),
      onClick: onOpenAgents,
      disabled: false,
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      ),
    },
  ] as const;

  return (
    <div
      data-resource-toolbar="true"
      style={{
        padding: "8px",
        flexShrink: 0,
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 4,
      }}
    >
      {actions.map(({ label, onClick, disabled, icon }) => (
        <button
          key={label}
          type="button"
          onClick={onClick}
          disabled={disabled}
          title={label}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            height: 32, padding: "0 6px", background: "none", border: "none",
            borderRadius: 7, color: "var(--text-muted)", cursor: disabled ? "default" : "pointer",
            fontSize: 12, whiteSpace: "nowrap", opacity: disabled ? 0.35 : 1,
            transition: "background 0.12s, color 0.12s",
          }}
          onMouseEnter={(event) => {
            if (!disabled) {
              event.currentTarget.style.background = "var(--bg-hover)";
              event.currentTarget.style.color = "var(--text)";
            }
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.background = "none";
            event.currentTarget.style.color = "var(--text-muted)";
          }}
        >
          {icon}
          {label}
        </button>
      ))}
    </div>
  );
}
