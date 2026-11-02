"use client";

import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEventHandler,
  type MouseEventHandler,
  type ReactNode,
  type RefObject,
} from "react";
import { Check, ChevronDown } from "lucide-react";
import { SelectorRow } from "./SelectorRow";

export const READER_MENU_OPEN_EVENT = "pi-reader-menu-open";

export interface ReaderSelectOptionAction {
  icon: ReactNode;
  ariaLabel: string;
  title?: string;
  onClick: () => void;
}

export interface ReaderSelectOption {
  value: string;
  label: ReactNode;
  menuLabel?: ReactNode;
  kind?: "option" | "group";
  disabled?: boolean;
  onContextMenu?: MouseEventHandler<HTMLButtonElement>;
  onContextMenuKey?: KeyboardEventHandler<HTMLButtonElement>;
  action?: ReaderSelectOptionAction;
}

export interface ReaderSelectTriggerRenderProps {
  triggerRef: RefObject<HTMLButtonElement | null>;
  open: boolean;
  disabled: boolean;
  title?: string;
  ariaLabel: string;
  onToggle: () => void;
  onKeyDown: KeyboardEventHandler<HTMLButtonElement>;
}

type MenuPlacement = "above" | "below";
type MenuAlign = "start" | "end";
type MenuPosition = { top: number; left: number };

export function announceReaderMenuOpen(id: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<string>(READER_MENU_OPEN_EVENT, { detail: id }));
}

export function useReaderMenuDismiss(onOpen: (id: string) => void): void {
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  useEffect(() => {
    const handleOpen = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      if (typeof id === "string") onOpenRef.current(id);
    };
    window.addEventListener(READER_MENU_OPEN_EVENT, handleOpen);
    return () => window.removeEventListener(READER_MENU_OPEN_EVENT, handleOpen);
  }, []);
}

interface ReaderFloatingCommonProps {
  options: readonly ReaderSelectOption[];
  ariaLabel: string;
  describedBy?: string;
  ariaInvalid?: boolean;
  title?: string;
  onClose?: () => void;
  appearance?: "field";
  containerClassName?: string;
  placement?: MenuPlacement;
  align?: MenuAlign;
  containerStyle?: CSSProperties;
  triggerStyle?: CSSProperties;
  triggerLabel?: ReactNode;
  menuMinWidth?: CSSProperties["minWidth"];
  menuMaxWidth?: CSSProperties["maxWidth"];
  optionFontSize?: number;
  optionMinHeight?: number;
  renderOption?: (option: ReaderSelectOption, selected: boolean) => ReactNode;
  renderTrigger?: (props: ReaderSelectTriggerRenderProps) => ReactNode;
  disabled?: boolean;
}

export interface ReaderFloatingSelectProps extends ReaderFloatingCommonProps {
  value: string;
  onChange: (value: string) => void;
}

export interface ReaderFloatingMultiSelectProps extends ReaderFloatingCommonProps {
  values: readonly string[];
  onChange: (values: string[]) => void;
  selectedLabel: ReactNode;
  allValue?: string;
}

type ReaderFloatingMenuProps =
  | (ReaderFloatingCommonProps & { mode: "single"; value: string; onChange: (value: string) => void })
  | (ReaderFloatingCommonProps & {
      mode: "multiple";
      values: readonly string[];
      onChange: (values: string[]) => void;
      selectedLabel: ReactNode;
      allValue?: string;
    });

export function ReaderFloatingSelect(props: ReaderFloatingSelectProps) {
  return <ReaderFloatingMenu {...props} mode="single" />;
}

export function ReaderFloatingMultiSelect(props: ReaderFloatingMultiSelectProps) {
  return <ReaderFloatingMenu {...props} mode="multiple" />;
}

function ReaderFloatingMenu(props: ReaderFloatingMenuProps) {
  const {
    options,
    ariaLabel,
    title,
    placement = "below",
    align = "start",
    containerStyle,
    triggerStyle,
    menuMinWidth = "max-content",
    menuMaxWidth = "min(320px, calc(100vw - 16px))",
    optionFontSize = 11,
    optionMinHeight = 28,
    disabled = false,
  } = props;
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const onClose = props.onClose;
  const close = useCallback(() => {
    setOpen(false);
    onClose?.();
  }, [onClose]);

  useEffect(() => {
    const handleOpen = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      if (id !== menuId) close();
    };
    window.addEventListener(READER_MENU_OPEN_EVENT, handleOpen);
    return () => window.removeEventListener(READER_MENU_OPEN_EVENT, handleOpen);
  }, [close, menuId]);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const menu = menuRef.current;
    const menuWidth = menu?.getBoundingClientRect().width ?? rect.width;
    const menuHeight = menu?.getBoundingClientRect().height ?? 0;
    const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const margin = 8;
    const left = Math.min(
      Math.max(margin, align === "end" ? rect.right - menuWidth : rect.left),
      Math.max(margin, viewportWidth - menuWidth - margin),
    );
    let top = placement === "above" ? rect.top - menuHeight - 4 : rect.bottom + 4;
    if (placement === "above" && top < margin && rect.bottom + menuHeight + 4 <= viewportHeight - margin) {
      top = rect.bottom + 4;
    } else if (placement === "below" && top + menuHeight > viewportHeight - margin && rect.top - menuHeight - 4 >= margin) {
      top = rect.top - menuHeight - 4;
    }
    setPosition({
      left,
      top: Math.min(Math.max(margin, top), Math.max(margin, viewportHeight - menuHeight - margin)),
    });
  }, [align, placement]);

  useEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    updatePosition();
    const frame = window.requestAnimationFrame(updatePosition);
    return () => window.cancelAnimationFrame(frame);
  }, [close, open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const reposition = () => updatePosition();
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) close();
    };
    // A click inside an iframe never bubbles to the parent document.
    const closeOnFocusIn = (event: FocusEvent) => {
      if (event.target instanceof HTMLIFrameElement) close();
    };
    const closeOnWindowBlur = () => {
      if (document.activeElement instanceof HTMLIFrameElement) close();
    };
    const closeOnKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOnPointerDown, true);
    document.addEventListener("focusin", closeOnFocusIn);
    document.addEventListener("keydown", closeOnKeyDown);
    window.addEventListener("blur", closeOnWindowBlur);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown, true);
      document.removeEventListener("focusin", closeOnFocusIn);
      document.removeEventListener("keydown", closeOnKeyDown);
      window.removeEventListener("blur", closeOnWindowBlur);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [close, open, updatePosition]);

  const toggle = () => {
    if (disabled) return;
    if (open) {
      close();
      return;
    }
    announceReaderMenuOpen(menuId);
    setPosition(null);
    setOpen(true);
  };

  useEffect(() => {
    if (!open || !position) return;
    const menu = menuRef.current;
    if (!menu || menu.contains(document.activeElement)) return;
    (menu.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]:not(:disabled)')
      ?? menu.querySelector<HTMLButtonElement>('[role="option"]:not(:disabled)'))?.focus();
  }, [open, position]);

  const selected = props.mode === "single" ? options.find((option) => option.value === props.value) : null;
  const selectedValues = props.mode === "multiple" ? new Set(props.values) : new Set<string>();
  const allValue = props.mode === "multiple" ? props.allValue ?? "all" : "";

  const selectOption = (option: ReaderSelectOption) => {
    if (disabled || option.disabled || option.kind === "group") return;
    if (props.mode === "multiple") {
      if (option.value === allValue) {
        props.onChange([]);
        return;
      }
      props.onChange(
        selectedValues.has(option.value)
          ? props.values.filter((value) => value !== option.value)
          : [...props.values, option.value],
      );
      return;
    }
    close();
    triggerRef.current?.focus();
    props.onChange(option.value);
  };

  const menu = open ? (
    <div
      ref={menuRef}
      role="listbox"
      aria-label={ariaLabel}
      aria-multiselectable={props.mode === "multiple" ? true : undefined}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)')];
        const current = rows.indexOf(document.activeElement as HTMLButtonElement);
        let next: number;
        if (event.key === "ArrowDown") next = (current + 1) % rows.length;
        else if (event.key === "ArrowUp") next = (current - 1 + rows.length) % rows.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = rows.length - 1;
        else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
          triggerRef.current?.focus();
          return;
        }
        else if (event.key === "Tab") { close(); triggerRef.current?.focus(); return; }
        else return;
        event.preventDefault();
        rows[next]?.focus();
      }}
      style={{
        position: "fixed",
        top: position?.top ?? 8,
        left: position?.left ?? 8,
        zIndex: 1200,
        minWidth: menuMinWidth,
        width: "max-content",
        maxWidth: menuMaxWidth,
        maxHeight: "calc(100dvh - 16px)",
        overflowY: "auto",
        padding: 4,
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--bg)",
        boxShadow: "0 -4px 16px rgba(0,0,0,0.10), 0 8px 24px rgba(0,0,0,0.12)",
        visibility: position ? "visible" : "hidden",
      }}
    >
      {options.map((option, index) => {
        if (option.kind === "group") {
          return (
            <div
              key={option.value}
              role="presentation"
              style={{
                marginTop: index > 0 ? 4 : 0,
                padding: "7px 12px 4px",
                borderTop: index > 0 ? "1px solid color-mix(in srgb, var(--border) 72%, transparent)" : "none",
                color: "var(--text-dim)",
                fontSize: Math.max(10, optionFontSize - 1),
                fontWeight: 650,
                whiteSpace: "nowrap",
              }}
            >
              {option.label}
            </div>
          );
        }
        const isSelected = props.mode === "multiple"
          ? option.value === allValue ? props.values.length === 0 : selectedValues.has(option.value)
          : option.value === props.value;
        const content = props.renderOption
          ? props.renderOption(option, isSelected)
          : <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{option.menuLabel ?? option.label}</span>;
        if (props.mode === "single" && props.renderOption && !option.action) {
          return (
            <SelectorRow
              key={option.value}
              active={isSelected}
              gutter={false}
              disabled={option.disabled}
              onSelect={() => selectOption(option)}
            >
              {content}
            </SelectorRow>
          );
        }
        const optionStyle: CSSProperties = {
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          minHeight: optionMinHeight,
          padding: "7px 12px",
          border: "none",
          borderRadius: 4,
          background: isSelected ? "var(--bg-selected)" : "none",
          color: isSelected ? "var(--text)" : "var(--text-muted)",
          cursor: "pointer",
          font: "inherit",
          fontSize: optionFontSize,
          fontWeight: isSelected ? 600 : 400,
          textAlign: "left",
          whiteSpace: "nowrap",
        };
        const hover = (event: { currentTarget: HTMLElement }) => {
          if (!isSelected) event.currentTarget.style.background = "var(--bg-hover)";
        };
        const leave = (event: { currentTarget: HTMLElement }) => {
          event.currentTarget.style.background = isSelected ? "var(--bg-selected)" : "none";
        };
        const hasRightAction = Boolean(option.action);
        const optionButton = (
          <button
            type="button"
            key={option.value}
            role="option"
            aria-selected={isSelected}
            disabled={option.disabled}
            onClick={() => selectOption(option)}
            onContextMenu={option.onContextMenu}
            onKeyDown={(event) => {
              if (!option.onContextMenuKey) return;
              if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
              event.preventDefault();
              event.stopPropagation();
              option.onContextMenuKey(event);
            }}
            onMouseEnter={hover}
            onMouseLeave={leave}
            style={{ ...optionStyle, appearance: "none", ...(option.disabled ? { opacity: 0.5, cursor: "not-allowed" } : {}), ...(option.action ? { flex: 1, width: "auto", minWidth: 0 } : {}) }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 14, flexShrink: 0 }}>
              {isSelected && <Check size={12} strokeWidth={2.4} style={{ color: "var(--accent)" }} aria-hidden="true" />}
            </span>
            <span style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
              {content}
            </span>
            {!hasRightAction && (
              <span style={{ display: "inline-flex", width: 14, flexShrink: 0 }} aria-hidden="true" />
            )}
          </button>
        );
        if (!option.action) return optionButton;
        return (
          <div key={option.value} style={{ display: "flex", alignItems: "center", gap: 2 }}>
            {optionButton}
            <button
              type="button"
              title={option.action.title ?? option.action.ariaLabel}
              aria-label={option.action.ariaLabel}
              onClick={(event) => { event.stopPropagation(); option.action?.onClick(); }}
              style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, flexShrink: 0, padding: 0, border: "none", borderRadius: 4, background: "none", color: "var(--text-dim)", cursor: "pointer" }}
            >
              {option.action.icon}
            </button>
          </div>
        );
      })}
    </div>
  ) : null;

  const handleTriggerKeyDown: KeyboardEventHandler<HTMLButtonElement> = (event) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (!open) toggle();
  };
  const triggerLabel = props.mode === "multiple" ? props.selectedLabel : selected?.label ?? props.value;
  const trigger = props.renderTrigger
    ? props.renderTrigger({ triggerRef, open, disabled, title, ariaLabel, onToggle: toggle, onKeyDown: handleTriggerKeyDown })
    : (
      <button
        ref={triggerRef}
        className="reader-select-trigger"
        type="button"
        title={title}
        aria-label={ariaLabel}
        aria-describedby={props.describedBy}
        aria-invalid={props.ariaInvalid}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={toggle}
        onKeyDown={handleTriggerKeyDown}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "flex-start",
          gap: 4,
          height: 32,
          width: "max-content",
          minWidth: 0,
          padding: "0 2px",
          background: "none",
          border: "none",
          borderRadius: 9,
          color: "var(--text-muted)",
          cursor: disabled ? "not-allowed" : "pointer",
          font: "inherit",
          fontSize: 11,
          whiteSpace: "nowrap",
          ...(props.appearance === "field" ? {
            width: "100%",
            padding: "0 10px",
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg-panel)",
            color: "var(--text)",
            fontSize: 12,
            justifyContent: "space-between",
            boxSizing: "border-box" as const,
          } : {}),
          ...triggerStyle,
        }}
      >
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {props.triggerLabel ?? triggerLabel}
        </span>
        <ChevronDown size={12} strokeWidth={1.8} aria-hidden="true" />
      </button>
    );

  return (
    <span className={props.containerClassName} style={{ position: "relative", display: "inline-flex", flexShrink: 0, ...(props.appearance === "field" ? { width: "100%", maxWidth: "100%" } : {}), ...containerStyle }}>
      {trigger}
      {typeof document !== "undefined" && menu ? createPortal(menu, document.body) : null}
    </span>
  );
}
