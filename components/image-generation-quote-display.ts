import type { ImageGenerationQuote } from "@/lib/image-generation-pricing";

/** Keep every token rate visible when a model is shown in the compact settings list. */
export function compactImageQuoteSummary(
  quote: Pick<ImageGenerationQuote, "unit" | "rows">,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const first = quote.rows[0];
  if (quote.unit === "image" && first) return t("chat.imagePriceCompactPerImage", { amount: first.amount });
  if (quote.unit === "call" && first) return t("chat.imagePriceCompactPerCall", { amount: first.amount });
  if (quote.unit === "million-tokens" && quote.rows.length > 0) {
    return `${quote.rows.map((row) => `$${row.amount}`).join("/")}/M token`;
  }
  return t("chat.imagePriceByToken");
}
