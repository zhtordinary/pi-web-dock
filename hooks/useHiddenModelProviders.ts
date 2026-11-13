"use client";

import { useCallback, useEffect, useState } from "react";
import {
  COLLAPSED_PROVIDERS_CHANGED_EVENT,
  COLLAPSED_PROVIDERS_REQUEST_EVENT,
  COLLAPSED_PROVIDERS_SYNC_EVENT,
  readCollapsedProviderNames,
  writeCollapsedProviderNames,
} from "@/lib/model-visibility-preference";

/** Keep model pickers aligned with the provider visibility set in ModelsConfig. */
export function useHiddenModelProviders(): ReadonlySet<string> {
  const [hiddenProviders, setHiddenProviders] = useState<Set<string>>(
    () => new Set(readCollapsedProviderNames()),
  );
  const refresh = useCallback(() => {
    setHiddenProviders(new Set(readCollapsedProviderNames()));
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (window.parent === window || event.source !== window.parent) return;
      const data = event.data as { type?: unknown; providers?: unknown } | null;
      if (data?.type !== COLLAPSED_PROVIDERS_SYNC_EVENT || !Array.isArray(data.providers)) return;
      const names = data.providers.filter((name): name is string => typeof name === "string" && name.trim().length > 0);
      writeCollapsedProviderNames(names);
      setHiddenProviders(new Set(names));
    };

    window.addEventListener("storage", refresh);
    window.addEventListener(COLLAPSED_PROVIDERS_CHANGED_EVENT, refresh);
    window.addEventListener("message", onMessage);
    if (window.parent !== window) {
      window.parent.postMessage({ type: COLLAPSED_PROVIDERS_REQUEST_EVENT }, "*");
    }
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener(COLLAPSED_PROVIDERS_CHANGED_EVENT, refresh);
      window.removeEventListener("message", onMessage);
    };
  }, [refresh]);

  return hiddenProviders;
}
