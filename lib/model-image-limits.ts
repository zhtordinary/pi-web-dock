type ImageLimitEntry = { inputLimits?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function modelImageResizeLimit(entry: ImageLimitEntry): { editable: boolean; present: boolean; value: unknown } {
  const limits = entry.inputLimits;
  if (limits !== undefined && !isRecord(limits)) return { editable: false, present: false, value: undefined };
  const images = limits?.images;
  if (images !== undefined && !isRecord(images)) return { editable: false, present: false, value: undefined };
  const resize = images?.resize;
  if (resize !== undefined && !isRecord(resize)) return { editable: false, present: false, value: undefined };
  return { editable: true, present: Object.hasOwn(resize ?? {}, "maxBytes"), value: resize?.maxBytes };
}

export function withModelImageResizeLimit<T extends ImageLimitEntry>(entry: T, raw: string): T {
  if (!modelImageResizeLimit(entry).editable) return entry;
  const limits = { ...(entry.inputLimits as Record<string, unknown> | undefined) };
  const images = { ...(limits.images as Record<string, unknown> | undefined) };
  const resize = { ...(images.resize as Record<string, unknown> | undefined) };
  if (raw === "") delete resize.maxBytes;
  else resize.maxBytes = /^\d+$/.test(raw) ? Number(raw) : raw;
  if (Object.keys(resize).length) images.resize = resize;
  else delete images.resize;
  if (Object.keys(images).length) limits.images = images;
  else delete limits.images;
  return { ...entry, inputLimits: Object.keys(limits).length ? limits : undefined };
}

export class ModelImageLimitError extends Error {
  constructor(public readonly model: string) {
    super(`${model}: image resize maxBytes must be a positive safe integer`);
  }
}

export function checkModelImageLimits(config: unknown): void {
  if (!isRecord(config) || !isRecord(config.providers)) return;
  const check = (entry: unknown, ref: string) => {
    if (!isRecord(entry)) return;
    const { present, value } = modelImageResizeLimit(entry);
    if (present && (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)) {
      throw new ModelImageLimitError(ref);
    }
  };
  for (const [providerId, provider] of Object.entries(config.providers)) {
    if (!isRecord(provider)) continue;
    if (Array.isArray(provider.models)) {
      for (const model of provider.models) {
        if (isRecord(model)) check(model, `${providerId}/${typeof model.id === "string" ? model.id : "(unnamed)"}`);
      }
    }
    if (isRecord(provider.modelOverrides)) {
      for (const [modelId, override] of Object.entries(provider.modelOverrides)) check(override, `${providerId}/${modelId}`);
    }
  }
}
