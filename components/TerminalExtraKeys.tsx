"use client";

import { useI18n } from "@/hooks/useI18n";
import { TERMINAL_EXTRA_KEYS, type TerminalExtraKey, type TerminalModifier, type TerminalModifiers } from "@/lib/terminal-extra-keys";

const LABELS: Record<TerminalExtraKey | TerminalModifier, string> = {
  Escape: "ESC", Tab: "TAB", "/": "/", "-": "-", Home: "HOME", End: "END",
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", PageUp: "PGUP", PageDown: "PGDN", ctrl: "CTRL", alt: "ALT",
};

export function TerminalExtraKeys({ modifiers, disabled, onKey, onToggleModifier }: {
  modifiers: TerminalModifiers;
  disabled: boolean;
  onKey: (key: TerminalExtraKey) => void;
  onToggleModifier: (modifier: TerminalModifier) => void;
}) {
  const { t } = useI18n();
  const press = (key: TerminalExtraKey | TerminalModifier) => {
    if (disabled) return;
    if (key === "ctrl" || key === "alt") onToggleModifier(key);
    else onKey(key);
  };
  return <div className="terminal-extra-keys" role="toolbar" aria-label={`${t("terminal.title")} · ESC / CTRL / ALT`}>
    {TERMINAL_EXTRA_KEYS.map((key) => <button
      key={key} type="button" disabled={disabled}
      aria-label={key} aria-pressed={key === "ctrl" || key === "alt" ? modifiers[key] : undefined}
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => press(key)}
      onContextMenu={(event) => event.preventDefault()}
    >{LABELS[key]}</button>)}
  </div>;
}
