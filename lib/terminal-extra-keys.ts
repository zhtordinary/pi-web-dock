export type TerminalExtraKey = "Escape" | "Tab" | "/" | "-" | "Home" | "End"
  | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "PageUp" | "PageDown";
export type TerminalModifier = "ctrl" | "alt";
export interface TerminalModifiers { ctrl: boolean; alt: boolean }

export const TERMINAL_EXTRA_KEYS: readonly (TerminalExtraKey | TerminalModifier)[] = [
  "Escape", "/", "-", "Home", "ArrowUp", "End", "PageUp",
  "Tab", "ctrl", "alt", "ArrowLeft", "ArrowDown", "ArrowRight", "PageDown",
];

export function applyTerminalModifiers(data: string, modifiers: TerminalModifiers): string {
  // Paste, IME text, and existing xterm escape/control sequences remain intact.
  if (data.length !== 1 || data.charCodeAt(0) < 32 || data.charCodeAt(0) > 126) return data;
  let result = data;
  if (modifiers.ctrl) {
    const upper = data.toUpperCase();
    const code = upper.charCodeAt(0);
    if (upper.length === 1 && code >= 64 && code <= 95) result = String.fromCharCode(code & 31);
    else if (data === " ") result = "\x00";
    else if (data === "/" || data === "-") result = "\x1f";
    else if (data === "?") result = "\x7f";
  }
  return modifiers.alt ? `\x1b${result}` : result;
}

export function terminalExtraKeySequence(key: TerminalExtraKey, modifiers: TerminalModifiers, applicationCursorKeys: boolean): string {
  const finals: Partial<Record<TerminalExtraKey, string>> = { ArrowUp: "A", ArrowDown: "B", ArrowRight: "C", ArrowLeft: "D", Home: "H", End: "F" };
  const final = finals[key];
  const parameter = 1 + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0);
  if (final) return parameter > 1 ? `\x1b[1;${parameter}${final}` : applicationCursorKeys && key.startsWith("Arrow") ? `\x1bO${final}` : `\x1b[${final}`;
  if (key === "PageUp" || key === "PageDown") {
    const code = key === "PageUp" ? 5 : 6;
    return parameter > 1 ? `\x1b[${code};${parameter}~` : `\x1b[${code}~`;
  }
  if (key === "Escape") return modifiers.alt ? "\x1b\x1b" : "\x1b";
  if (key === "Tab") return modifiers.alt ? "\x1b\t" : "\t";
  return applyTerminalModifiers(key, modifiers);
}

/** One input binding per terminal writer; never transfers modifiers to another scope. */
export function createTerminalExtraKeyInput(options: {
  scope: () => unknown;
  enabled: () => boolean;
  write: (data: string) => void;
  changed: (modifiers: TerminalModifiers) => void;
}) {
  let disposed = false;
  let scope = options.scope();
  let modifiers: TerminalModifiers = { ctrl: false, alt: false };
  const clear = () => {
    const changed = modifiers.ctrl || modifiers.alt;
    modifiers = { ctrl: false, alt: false };
    scope = options.scope();
    if (!disposed && changed) options.changed(modifiers);
  };
  const current = () => {
    if (disposed) return false;
    if (scope !== options.scope()) clear();
    if (!options.enabled()) { clear(); return false; }
    return true;
  };
  const consume = (encode: (selected: TerminalModifiers) => string) => {
    if (!current()) return;
    const data = encode(modifiers);
    clear();
    options.write(data);
  };
  return {
    clear,
    toggle(modifier: TerminalModifier) {
      if (!current()) return;
      modifiers = { ...modifiers, [modifier]: !modifiers[modifier] };
      options.changed(modifiers);
    },
    data(data: string) { consume((selected) => applyTerminalModifiers(data, selected)); },
    key(key: TerminalExtraKey, applicationCursorKeys: boolean) { consume((selected) => terminalExtraKeySequence(key, selected, applicationCursorKeys)); },
    dispose() { clear(); disposed = true; },
  };
}
