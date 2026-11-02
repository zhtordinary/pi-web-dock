"use client";

import { useRef } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useResizablePanel } from "@/hooks/useResizablePanel";
import { ConfigButton } from "./SettingsUi";

export const CONFIG_SIDEBAR_DEFAULT_WIDTH = 240;
export const CONFIG_SIDEBAR_MIN_WIDTH = 180;
export const CONFIG_SIDEBAR_MAX_WIDTH = 420;
const CONFIG_SIDEBAR_STORAGE_KEY = "pi-config-sidebar-width";

export function getConfigSidebarMaxWidth(viewportWidth: number): number {
  return Math.min(CONFIG_SIDEBAR_MAX_WIDTH, Math.max(CONFIG_SIDEBAR_MIN_WIDTH, viewportWidth - 360));
}

/** Shared width and resize behavior for the Skills and Plugins sidebars. */
export function useConfigSidebarResize() {
  const { t } = useI18n();
  const widthRef = useRef(CONFIG_SIDEBAR_DEFAULT_WIDTH);

  return useResizablePanel({
    ariaLabel: t("layout.resizeSidebar"),
    cssVariable: "--config-sidebar-width",
    defaultWidth: CONFIG_SIDEBAR_DEFAULT_WIDTH,
    getMaxWidth: () => (typeof window === "undefined"
      ? CONFIG_SIDEBAR_MAX_WIDTH
      : getConfigSidebarMaxWidth(window.innerWidth)),
    growthDirection: "right",
    maxWidth: CONFIG_SIDEBAR_MAX_WIDTH,
    minWidth: CONFIG_SIDEBAR_MIN_WIDTH,
    storageKey: CONFIG_SIDEBAR_STORAGE_KEY,
    widthRef,
  });
}

export function ConfigPanelRefreshButton({
  disabled,
  onRefresh,
}: {
  disabled: boolean;
  onRefresh: () => void;
}) {
  const { t } = useI18n();
  const label = t("settings.refreshList");
  const hint = t("settings.refreshListHint");
  return (
    <span className="config-panel-refresh">
      <span className="config-panel-refresh-hint">{hint}</span>
      <ConfigButton
        type="button"
        onClick={onRefresh}
        disabled={disabled}
        aria-label={label}
        title={hint}
      >
        {disabled ? t("i18n.loading") : label}
      </ConfigButton>
    </span>
  );
}
