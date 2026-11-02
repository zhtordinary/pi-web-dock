import { priceTokenUsages } from "./billing";
import { officialImageProviderForModel } from "./official-image-pricing";
import { loadImageGenerationPackage } from "./image-generation-package";

export interface ImageGenerationQuote {
  status: "available" | "unavailable";
  model: string;
  source?: "apimart" | "laozhang" | "openai" | "google";
  fetchedAt: string;
  unit?: "image" | "call" | "million-tokens";
  rows: { name: string; amount: number; unit?: "image" | "call" | "million-tokens" }[];
  group?: string;
  sourceUrl?: string;
  warnings?: ("pricing-conflict" | "first-reference-free")[];
}

const cache = new Map<string, { expires: number; quote: Promise<ImageGenerationQuote> }>();

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function amount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Only payable fields enter display quotes; list prices and precharges are not rates. */
export function apimartPriceRows(data: Record<string, unknown>): Pick<ImageGenerationQuote, "unit" | "rows" | "warnings"> | undefined {
  const rows: ImageGenerationQuote["rows"] = [];
  const grid = (value: unknown, prefix: string[] = [], unit?: "image" | "million-tokens") => {
    if (!object(value) || prefix.length > 3) return;
    for (const [name, valueOrGrid] of Object.entries(value)) {
      if (amount(valueOrGrid)) rows.push({ name: [...prefix, name].join(" · "), amount: valueOrGrid, ...(unit ? { unit } : {}) });
      else grid(valueOrGrid, [...prefix, name], unit);
    }
  };
  const tokenBilling = data.billing_type === "tiered_token"
    || (data.quota_type !== 1 && object(data.pricing) && data.pricing.unit === "usd_per_million_tokens");
  if (tokenBilling) {
    const pricing = data.pricing;
    if (!object(pricing) || pricing.tier_count !== 1 || pricing.unit !== "usd_per_million_tokens" || !object(pricing.effective_rates)) return undefined;
    for (const name of ["input", "cached_input", "cache_write", "output", "text_input", "cached_text_input", "image_input", "cached_image_input", "text_output", "image_output"]) {
      if (name.startsWith("cached_") && (!object(pricing.limits) || pricing.limits.supports_cache_read !== true)) continue;
      const value = pricing.effective_rates[name];
      if (amount(value)) rows.push({ name, amount: value });
    }
    return rows.length ? { unit: "million-tokens", rows } : undefined;
  }
  if (data.quota_type !== 1 && !object(data.resolution_paid_prices)) return undefined;
  // A token-only response must not be mistaken for a fixed precharge quote.
  if (object(data.pricing) && data.pricing.tier_count !== 1) return undefined;
  if (data.billing_type === "version_resolution") grid(data.version_resolution_paid_prices);
  else if (data.billing_type === "size_quality") grid(data.size_quality_paid_prices);
  else {
    if (amount(data.paid_price)) rows.push({ name: "default", amount: data.paid_price });
    grid(data.resolution_paid_prices);
  }
  if (!rows.length) return undefined;
  grid(data.billing_variant_paid_prices);
  grid(data.layer_decomposition_paid_prices, ["layer_decomposition"]);
  if (object(data.input_image_paid_prices)) grid(data.input_image_paid_prices, ["reference_image"]);
  else if (amount(data.input_image_paid_price)) rows.push({ name: "reference_image", amount: data.input_image_paid_price });
  const warnings: NonNullable<ImageGenerationQuote["warnings"]> = [];
  if (["seedream-5-0-flash", "grok-imagine-2.0-ext"].includes(String(data.model_name))) warnings.push("pricing-conflict");
  if (data.input_image_first_free === true) warnings.push("first-reference-free");
  return { unit: "image", rows, ...(warnings.length ? { warnings } : {}) };
}

/** Public display quotes never price historical calls or receive account credentials. */
export async function imageGenerationQuote(baseUrl: string, model: string, fetcher: typeof fetch = fetch, refresh = false, providerName?: string): Promise<ImageGenerationQuote> {
  const unavailable: ImageGenerationQuote = { status: "unavailable", model, fetchedAt: new Date().toISOString(), rows: [] };
  let provider: "apimart" | "laozhang" | "openai" | "google";
  let endpoint: URL | undefined;
  const officialProvider = officialImageProviderForModel(providerName, model);
  try {
    if (officialProvider) {
      provider = officialProvider;
    } else {
      const base = new URL(baseUrl);
      if (base.protocol !== "https:" || base.username || base.password || base.port || !/^\/v1\/?$/.test(base.pathname)
          || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(model)) return unavailable;
      if (base.hostname === "api.apimart.ai") {
        provider = "apimart";
        endpoint = new URL("/api/pricing/model", base);
        endpoint.searchParams.set("model", model);
      } else if (["api.laozhang.ai", "api2.laozhang.ai"].includes(base.hostname)) {
        provider = "laozhang";
        endpoint = new URL("/api/pricing", base);
      } else if (base.hostname === "api.openai.com" && loadImageGenerationPackage().OPENAI_IMAGE_MODELS.includes(model)) {
        provider = "openai";
      } else return unavailable;
    }
  } catch { return unavailable; }
  const key = `${provider}/${model}`;
  const previous = cache.get(key);
  if (!refresh && previous && previous.expires > Date.now()) return previous.quote;
  const quote = (async (): Promise<ImageGenerationQuote> => {
    try {
      if (provider === "openai" || provider === "google") {
        const specs = [
          { name: "text_input", input: 1_000_000, output: 0, inputImage: 0, outputImage: 0 },
          { name: "image_input", input: 1_000_000, output: 0, inputImage: 1_000_000, outputImage: 0 },
          { name: "image_output", input: 0, output: 1_000_000, inputImage: 0, outputImage: 1_000_000 },
        ];
        const rates = await priceTokenUsages(specs.map((usage) => ({ ...usage, model, provider, usageAvailable: true, timestamp: new Date().toISOString() })));
        const rows = specs.flatMap((spec, index) => {
          const row = rates[index];
          const value = row?.pricing.configured && row.cost ? row.cost.total : undefined;
          return amount(value) ? [{ name: spec.name, amount: value }] : [];
        });
        if (!rows.length) return unavailable;
        const source = rates.find((row) => row.pricing.source)?.pricing.source?.split(";")[0];
        return { ...unavailable, status: "available", source: provider, unit: "million-tokens", group: "Standard · genai-prices",
          rows, ...(source ? { sourceUrl: source } : {}) };
      }
      const res = await fetcher(endpoint!, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(5_000), cache: "no-store" });
      if (!res.ok) return unavailable;
      const payload: unknown = await res.json();
      if (!object(payload) || payload.success !== true) return unavailable;
      if (provider === "laozhang") {
        const row = Array.isArray(payload.data) ? payload.data.find((item) => object(item) && item.model_name === model) : undefined;
        // Expression/tier billing may also carry a model_price used only for precharge.
        if (!object(row) || row.quota_type !== 1 || row.billing_mode || !amount(row.model_price)) return unavailable;
        return { ...unavailable, status: "available", source: provider, unit: "call", group: "default", rows: [{ name: "default", amount: row.model_price }] };
      }
      if (!object(payload.data)) return unavailable;
      const data = payload.data;
      const display = apimartPriceRows(data);
      if (!display) return unavailable;
      const group = display.unit === "million-tokens" && object(data.pricing) && typeof data.pricing.group === "string"
        ? data.pricing.group : "Gold/default";
      return { ...unavailable, ...display, status: "available", source: provider, sourceUrl: endpoint!.href, group };
    } catch { return unavailable; }
  })();
  if (cache.size >= 100) cache.delete(cache.keys().next().value!);
  cache.set(key, { expires: Date.now() + 5 * 60_000, quote });
  const result = await quote;
  if (result.status === "unavailable" && cache.get(key)?.quote === quote) cache.set(key, { expires: Date.now() + 10_000, quote });
  return result;
}
