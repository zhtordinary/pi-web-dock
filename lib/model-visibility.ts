export interface ModelReference {
  provider: string;
  id: string;
}

/**
 * Per-model hiding lives in `models.json` as top-level `hiddenModels`
 * (`provider/modelId` references). It is a display-only preference synced
 * with the rest of `models.json`, so it survives deleting `enabledModels`.
 * Unknown references are kept: a temporarily unavailable model stays hidden
 * when it comes back.
 */
export function normalizeHiddenModelReferences(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const reference = entry.trim();
    if (reference.length > 0) seen.add(reference);
  }
  return [...seen];
}

export function isModelHidden(
  model: ModelReference,
  hidden: readonly string[],
): boolean {
  return hidden.includes(`${model.provider}/${model.id}`);
}

export function filterHiddenModels<T extends ModelReference>(
  models: readonly T[],
  hidden: readonly string[],
): T[] {
  const hiddenSet = new Set(hidden);
  if (hiddenSet.size === 0) return [...models];
  return models.filter((model) => !hiddenSet.has(`${model.provider}/${model.id}`));
}

export function toggleHiddenModelReference(
  hidden: readonly string[],
  model: ModelReference,
): string[] {
  const reference = `${model.provider}/${model.id}`;
  return hidden.includes(reference)
    ? hidden.filter((entry) => entry !== reference)
    : [...hidden, reference];
}
