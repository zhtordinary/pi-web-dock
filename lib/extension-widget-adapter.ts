import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  createHeadlessCustomUiTui,
  DEFAULT_CUSTOM_UI_COLUMNS,
  type HeadlessCustomUiTui,
} from "./custom-ui-terminal";
import type { ExtensionWidgetItem } from "./types";

type WidgetComponent = {
  render: (width: number) => string[];
  dispose?: () => void;
};

type WidgetFactory = (tui: HeadlessCustomUiTui, theme: Theme) => WidgetComponent;
type WidgetContent = string[] | ((...args: never[]) => unknown) | undefined;
type WidgetPlacement = ExtensionWidgetItem["placement"];

type ActiveWidget = {
  component: WidgetComponent;
  placement: WidgetPlacement;
  width: number;
};

/**
 * Bridges Pi's TUI component-form widgets into the line-based RPC protocol.
 * Each AgentSessionWrapper owns one instance, so render callbacks cannot
 * update another session's widget.
 */
export class ExtensionWidgetAdapter {
  private readonly active = new Map<string, ActiveWidget>();
  private readonly widgets = new Map<string, ExtensionWidgetItem>();
  private readonly theme: Theme;
  private readonly onChange: (key: string, widget: ExtensionWidgetItem | undefined) => void;
  private readonly onError: (key: string, error: unknown) => void;
  private readonly width: number;

  constructor(
    theme: Theme,
    onChange: (key: string, widget: ExtensionWidgetItem | undefined) => void,
    onError: (key: string, error: unknown) => void,
    width = DEFAULT_CUSTOM_UI_COLUMNS,
  ) {
    this.theme = theme;
    this.onChange = onChange;
    this.onError = onError;
    this.width = width;
  }

  setWidget(key: string, content: WidgetContent, options?: { placement?: WidgetPlacement }): void {
    this.remove(key, true);

    if (content === undefined) return;

    const placement = options?.placement ?? "aboveEditor";
    if (this.isStringArray(content)) {
      this.commit(key, content, placement);
      return;
    }

    if (typeof content !== "function") {
      this.reportError(key, new Error("Widget content must be a string array or component factory"));
      return;
    }

    const activeRef: { current?: ActiveWidget } = {};
    const requestRender = () => {
      const active = activeRef.current;
      if (!active || this.active.get(key) !== active) return;
      this.renderActive(key, active);
    };

    let component: WidgetComponent;
    try {
      const tui = createHeadlessCustomUiTui(requestRender, this.width);
      component = (content as unknown as WidgetFactory)(tui, this.theme);
      if (!component || typeof component.render !== "function") {
        throw new Error("Widget factory did not return a renderable component");
      }
    } catch (error) {
      this.reportError(key, error);
      return;
    }

    const active = { component, placement, width: this.width };
    activeRef.current = active;
    this.active.set(key, active);
    this.renderActive(key, active);
  }

  getWidgets(): ExtensionWidgetItem[] {
    return Array.from(this.widgets.values(), (widget) => ({
      ...widget,
      lines: [...widget.lines],
    }));
  }

  clear(emitChanges = true): void {
    const keys = new Set([...this.active.keys(), ...this.widgets.keys()]);
    for (const key of keys) this.remove(key, emitChanges);
  }

  private renderActive(key: string, active: ActiveWidget): void {
    try {
      const lines = active.component.render(active.width);
      if (!this.isStringArray(lines)) {
        throw new Error("Widget component render() must return a string array");
      }
      this.commit(key, lines, active.placement);
    } catch (error) {
      this.remove(key, true);
      this.reportError(key, error);
    }
  }

  private commit(key: string, lines: string[], placement: WidgetPlacement): void {
    const widget: ExtensionWidgetItem = {
      key,
      lines: [...lines],
      placement,
    };
    this.widgets.set(key, widget);
    this.onChange(key, widget);
  }

  private remove(key: string, emitChange: boolean): void {
    const active = this.active.get(key);
    this.active.delete(key);
    if (active?.component.dispose) {
      try {
        active.component.dispose();
      } catch {
        // Widget disposal must not break the session UI bridge.
      }
    }

    const hadWidget = this.widgets.delete(key);
    if (emitChange && (active || hadWidget)) this.onChange(key, undefined);
  }

  private reportError(key: string, error: unknown): void {
    this.onError(key, error instanceof Error ? error : new Error(String(error)));
  }

  private isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((line) => typeof line === "string");
  }
}
