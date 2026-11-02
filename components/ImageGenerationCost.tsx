import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { ImageGenerationCost as Cost } from "@/lib/image-generation-cost";

const labels = {
  confirmed: "chat.imageCostConfirmed",
  estimated: "chat.imageCostEstimated",
  pending: "chat.imageCostPending",
  unavailable: "chat.imageCostUnavailable",
} as const;

function ImageGenerationCostRow({ cost, image }: { cost: Cost; image: boolean }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const b = cost.billing;
  const source = cost.status === "estimated" ? "genai-prices"
    : b.source === "apimart-task" ? "API Mart" : b.source === "laozhang-log" ? "LaoZhang" : cost.provider;
  const hint = b.reason === "credentials-required" ? t("chat.imageCostCredentials")
    : b.reason === "request-id-missing" ? t("chat.imageCostMissingId")
    : cost.status === "estimated" ? t("chat.imageCostEstimateHint")
    : cost.status === "unavailable" ? t("chat.imageCostUnavailableHint")
    : cost.status !== "confirmed" ? t("chat.imageCostWaiting") : t("chat.imageCostConfirmedHint");
  return (
    <span data-cost-status={cost.status} style={{ display: "block", color: "var(--text-muted)", fontSize: 11, lineHeight: 1.5 }}>
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}
        style={{ display: "block", border: 0, padding: 0, background: "none", color: "inherit", font: "inherit", textAlign: "left", cursor: "pointer", overflowWrap: "anywhere" }}>
        <span style={{ fontWeight: 600, color: cost.status === "confirmed" ? "var(--text)" : undefined, fontVariantNumeric: "tabular-nums" }}>
          {t(labels[cost.status])}{cost.amount !== null ? ` $${Number(cost.amount.toPrecision(8)).toString()}` : ""}
        </span>
        {b.credits !== undefined && cost.status === "confirmed" ? ` · ${b.credits} credits` : ""}
        {b.returnedImages !== undefined ? ` · ${t("chat.imageCostImages", { n: b.returnedImages })}` : ""}
        {` · ${source}`}
        {image ? ` · ${cost.model}${[b.size, b.resolution, b.quality].filter(Boolean).length ? ` · ${[b.size, b.resolution, b.quality].filter(Boolean).join(" · ")}` : ""}` : ""}
        {image && cost.status === "confirmed" ? ` · ${t("chat.imageCostVerified")}` : ""}
        <span aria-hidden="true"> {expanded ? "▾" : "▸"}</span>
      </button>
      <span hidden={!expanded} style={{ display: expanded ? "grid" : "none", paddingTop: 4, overflowWrap: "anywhere" }}>
        <span>{cost.provider}/{cost.model}{[b.size, b.resolution, b.quality].filter(Boolean).length ? ` · ${[b.size, b.resolution, b.quality].filter(Boolean).join(" · ")}` : ""}</span>
        <span>{hint}</span>
        {b.quota !== undefined && cost.status === "confirmed" ? <span>quota: {b.quota}</span> : null}
        {b.taskId || b.requestId ? <code style={{ userSelect: "text" }}>{b.taskId ?? b.requestId}</code> : null}
      </span>
    </span>
  );
}

export function ImageGenerationCost({ costs, image = false, batch = false }: { costs: readonly Cost[]; image?: boolean; batch?: boolean }) {
  const { t } = useI18n();
  if (costs.length === 0) return null;
  return (
    <span data-image-generation-cost data-cost-placement={image ? "image" : "tool"}
      style={{ display: "grid", gap: 4, borderTop: image ? undefined : "1px solid var(--border)", padding: image ? "4px 0 0" : "6px 10px" }}>
      {batch && <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{t("chat.imageCostBatch")}</span>}
      {costs.map((cost) => <ImageGenerationCostRow key={cost.id} cost={cost} image={image} />)}
    </span>
  );
}
