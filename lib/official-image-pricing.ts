const GATEWAY_PROVIDER_MARKERS = ["cpa", "sub2api", "cli-proxy-api", "cliproxy", "proxy-api"];

function normalize(value: string | undefined): string {
  return String(value ?? "").trim().toLowerCase().replace(/_/g, "-");
}

function modelId(model: string): string {
  return normalize(model).split("/").pop() ?? "";
}

/** Resolve a gateway image label to the official provider used by genai-prices. */
export function officialImageProviderForModel(provider: string | undefined, model: string): "google" | "openai" | undefined {
  const providerId = normalize(provider);
  if (!GATEWAY_PROVIDER_MARKERS.some((marker) => providerId.includes(marker))) return undefined;
  const id = modelId(model);
  if ((id.startsWith("gemini-") && id.includes("-image")) || id.startsWith("gemini-nano-banana-")) return "google";
  if (id.startsWith("gpt-image-")) return "openai";
  return undefined;
}

/**
 * Estimate image-output tokens when a gateway returns an image without usage.
 * shortcut: CPA does not expose usage; use the official 1K equivalent until the gateway returns usage or a ledger charge.
 */
export function officialImageOutputTokenEstimate(model: string, resolution?: string, returnedImages = 1): number | undefined {
  const id = modelId(model);
  const count = Number.isSafeInteger(returnedImages) && returnedImages > 0 ? returnedImages : 1;
  if (id.startsWith("gpt-image-")) return count * 1000;
  if (!((id.startsWith("gemini-") && id.includes("-image")) || id.startsWith("gemini-nano-banana-"))) return undefined;
  const key = normalize(resolution || "1k");
  const tokens = ({
    "0.5k": 750,
    "1k": 1120,
    "2k": 1680,
    "4k": 2520,
  } as Record<string, number>)[key] ?? 1120;
  return count * tokens;
}
