import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useI18n } from "@/hooks/useI18n";
import { apiPathForPeer } from "@/lib/file-api";
import type { GenCapability } from "@/lib/gen-capabilities";
import type { ImageGenerationQuote } from "@/lib/image-generation-pricing";
import { compactImageQuoteSummary } from "./image-generation-quote-display";
import { ConfigButton } from "./SettingsUi";

const rateLabels = {
  default: "chat.imagePriceDefault",
  text_input: "chat.imagePriceTextInput",
  cached_text_input: "chat.imagePriceCachedText",
  image_input: "chat.imagePriceImageInput",
  cached_image_input: "chat.imagePriceCachedImage",
  text_output: "chat.imagePriceTextOutput",
  image_output: "chat.imagePriceImageOutput",
  input: "chat.imagePriceInput",
  output: "chat.imagePriceOutput",
  cached_input: "chat.imagePriceCachedText",
  cache_write: "chat.imagePriceCacheWrite",
  reference_image: "chat.imagePriceReferenceImage",
  layer_decomposition: "chat.imagePriceLayer",
} as const;

export function ImageGenerationPrice({ provider, model, remotePeer, capability, compact = false, active = true }: {
  provider: string | null;
  model: string | null;
  remotePeer?: string;
  capability?: GenCapability;
  compact?: boolean;
  active?: boolean;
}) {
  const { t } = useI18n();
  const [quote, setQuote] = useState<ImageGenerationQuote | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setQuote(null);
    if (!provider || !model) return;
    const controller = new AbortController();
    setLoading(true);
    const query = new URLSearchParams({ quote: "1", provider, model, ...(refresh ? { refresh: "1" } : {}) });
    void fetch(apiPathForPeer(remotePeer, `image-gen?${query}`), { signal: controller.signal, cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error("quote unavailable");
        const data = await res.json() as ImageGenerationQuote;
        if (!controller.signal.aborted) setQuote(data);
      })
      .catch(() => { if (!controller.signal.aborted) setQuote(null); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [provider, model, remotePeer, refresh]);

  if (!provider || !model) return null;

  // Inactive models render a compact inline price badge to keep the list clean and navigable
  if (!active) {
    if (loading) {
      return (
        <span style={{ display: "inline-flex", alignItems: "center", lineHeight: 1, flexShrink: 0, fontSize: 9, color: "rgba(99,102,241,0.85)", fontFamily: "var(--font-mono)", padding: "1px 5px", borderRadius: 3, background: "rgba(99,102,241,0.12)", whiteSpace: "nowrap" }}>
          {t("i18n.loading")}
        </span>
      );
    }
    if (quote?.status === "available" && quote.rows.length > 0) {
      const official = quote.source === "google" || quote.source === "openai";
      const summary = compactImageQuoteSummary(quote, t);
      const summaryText = official ? t("chat.imagePriceOfficial", { price: summary }) : summary;
      const summaryTitle = quote.unit === "million-tokens"
        ? quote.rows.map((row) => `${row.name}: $${row.amount}/M token`).join(" · ")
        : undefined;
      return (
        <span title={summaryTitle} style={{ display: "inline-flex", alignItems: "center", lineHeight: 1, flexShrink: 0, fontSize: 9, color: "rgba(99,102,241,0.85)", fontFamily: "var(--font-mono)", padding: "1px 5px", borderRadius: 3, background: "rgba(99,102,241,0.12)", whiteSpace: "nowrap" }}>
          {summaryText}
        </span>
      );
    }
    return null;
  }

  return (
    <div style={{ margin: compact ? "6px 0 2px" : "4px 18px 12px", padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-subtle, rgba(127,127,127,0.04))", fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, paddingBottom: 6, borderBottom: "1px solid var(--border-subtle, rgba(127,127,127,0.15))" }}>
        <span style={{ fontWeight: 600, color: "var(--text)", fontSize: 11, display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span>{t("chat.imagePriceTitle")}{compact ? "" : ` · ${model}`}</span>
          {quote?.status === "available" && (
            <span style={{ fontSize: 10, fontWeight: 400, color: "var(--text-dim)" }}>
              ({quote.source === "apimart" ? "API Mart" : quote.source === "laozhang" ? "LaoZhang" : quote.source === "google" ? "Google" : "OpenAI"} · {quote.group} · {t(quote.unit === "image" ? "chat.imagePricePerImage" : quote.unit === "call" ? "chat.imagePricePerCall" : "chat.imagePricePerMillion")})
            </span>
          )}
        </span>
        <button
          type="button"
          disabled={loading}
          onClick={() => setRefresh((value) => value + 1)}
          title={t("chat.imagePriceRefresh")}
          style={{
            display: "inline-flex", alignItems: "center", gap: 4,
            padding: "2px 8px", fontSize: 11, borderRadius: 4,
            border: "1px solid var(--border)", background: "var(--bg)",
            color: "var(--text-muted)", cursor: loading ? "default" : "pointer",
          }}
        >
          <RefreshCw size={11} strokeWidth={2} style={{ animation: loading ? "spin 1s linear infinite" : undefined }} />
          <span>{t("chat.imagePriceRefresh")}</span>
        </button>
      </div>
      {loading ? (
        <div role="status" style={{ paddingTop: 8, fontSize: 11 }}>{t("i18n.loading")}</div>
      ) : quote?.status === "available" ? (
        <div style={{ paddingTop: 6 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, paddingBottom: 6 }}>
            {quote.rows.map((row) => (
              <span key={row.name} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 6px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 4, fontVariantNumeric: "tabular-nums" }}>
                <span style={{ color: "var(--text-dim)" }}>{row.name.split(" · ").map((name) => name in rateLabels ? t(rateLabels[name as keyof typeof rateLabels]) : name).join(" · ")}:</span>
                <strong style={{ fontWeight: 600, color: "var(--text)" }}>${row.amount}</strong>
              </span>
            ))}
          </div>
          {quote.warnings?.map((warning) => (
            <div key={warning} style={{ color: warning === "pricing-conflict" ? "var(--error, #f87171)" : undefined, fontSize: 10, marginTop: 2 }}>
              {t(warning === "pricing-conflict" ? "chat.imagePriceConflict" : "chat.imagePriceFirstReferenceFree")}
            </div>
          ))}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginTop: 4, fontSize: 10, color: "var(--text-dim)" }}>
            <span>{t("chat.imagePriceCheckedAt")} {new Date(quote.fetchedAt).toLocaleString()}</span>
            {quote.sourceUrl ? (
              <a href={quote.sourceUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent)", textDecoration: "underline" }}>
                {t("chat.imagePriceSource")}
              </a>
            ) : null}
          </div>
        </div>
      ) : (
        <div style={{ paddingTop: 6, fontSize: 11 }}>{t("chat.imagePriceUnavailable")}</div>
      )}
      {capability?.maxImages ? (
        <div style={{ marginTop: 4, fontSize: 10, color: "var(--text-dim)" }}>
          {t("chat.imagePriceLimits", { n: capability.maxImages, refs: capability.maxReferences ?? "?" })}
        </div>
      ) : null}
    </div>
  );
}
