/** Reader's retired provider IDs occur in historical sessions and settings. */
export function isLegacyOpenAIProvider(provider: string | undefined): boolean {
  return provider === "openai-subscription" || provider === "openai-api";
}

/** Resolve historical model metadata and prices without changing stored identities. */
export function canonicalHistoricalOpenAIProvider(provider: string | undefined): string | undefined {
  return isLegacyOpenAIProvider(provider) ? "openai" : provider;
}
