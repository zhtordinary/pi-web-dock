"use client";

import { X } from "lucide-react";
import type { KeyboardEvent, Ref } from "react";

interface SessionSearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  title: string;
  clearLabel: string;
  inputRef?: Ref<HTMLInputElement>;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
}

export function SessionSearchInput({
  value,
  onChange,
  placeholder,
  title,
  clearLabel,
  inputRef,
  onKeyDown,
}: SessionSearchInputProps) {
  return (
    <div className="session-search-control">
      <input
        ref={inputRef}
        className="session-search-input"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.defaultPrevented) return;
          if (event.key === "Escape") onChange("");
        }}
        placeholder={placeholder}
        title={title}
        aria-label={placeholder}
      />
      {value.length > 0 && (
        <button
          type="button"
          className="session-search-clear"
          onClick={() => onChange("")}
          title={clearLabel}
          aria-label={clearLabel}
        >
          <X size={11} strokeWidth={2.2} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
