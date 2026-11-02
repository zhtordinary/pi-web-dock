"use client";

import { useState, type ReactNode } from "react";
import { MoveHorizontal, WrapText } from "lucide-react";
import { useI18n } from "@/hooks/useI18n";

export function MarkdownTable({ children }: { children: ReactNode }) {
  const [wrapText, setWrapText] = useState(true);
  const { t } = useI18n();
  const nextModeLabel = t(wrapText ? "markdown.tableScroll" : "markdown.tableWrap");
  const ToggleIcon = wrapText ? MoveHorizontal : WrapText;

  return (
    <div className={`markdown-table-wrap${wrapText ? " markdown-table-wrap--wrap" : ""}`}>
      <div className="markdown-table-toolbar">
        <button
          type="button"
          className="markdown-table-toggle"
          aria-label={nextModeLabel}
          aria-pressed={wrapText}
          title={nextModeLabel}
          onClick={() => setWrapText((current) => !current)}
        >
          <ToggleIcon size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="markdown-table-scroll">
        <table>{children}</table>
      </div>
    </div>
  );
}
