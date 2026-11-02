export const MAX_ATTACHED_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHED_IMAGES = 10;

export interface Base64ImageAttachment {
  data: string;
  mimeType: string;
}

function isBase64DataChar(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a)
    || (code >= 0x61 && code <= 0x7a)
    || (code >= 0x30 && code <= 0x39)
    || code === 0x2b
    || code === 0x2f;
}

export function getBase64DecodedByteLength(data: string): number | null {
  if (!data || data.length % 4 !== 0) return null;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const dataEnd = data.length - padding;
  for (let index = 0; index < dataEnd; index += 1) {
    if (!isBase64DataChar(data.charCodeAt(index))) return null;
  }
  for (let index = dataEnd; index < data.length; index += 1) {
    if (data[index] !== "=") return null;
  }
  return (data.length / 4) * 3 - padding;
}

export function isBase64ImageWithinLimits(value: unknown): value is Base64ImageAttachment {
  if (!value || typeof value !== "object") return false;
  const image = value as Partial<Base64ImageAttachment>;
  if (typeof image.data !== "string" || typeof image.mimeType !== "string" || !image.mimeType.startsWith("image/")) {
    return false;
  }
  const bytes = getBase64DecodedByteLength(image.data);
  return bytes !== null && bytes <= MAX_ATTACHED_IMAGE_BYTES;
}

export function extractBase64ImageAttachment(value: unknown): Base64ImageAttachment | null {
  if (!value || typeof value !== "object") return null;
  const image = value as {
    source?: { type?: unknown; data?: unknown; media_type?: unknown };
    data?: unknown;
    mimeType?: unknown;
  };
  const source = image.source;
  const data = source?.type === "base64" ? source.data : image.data;
  const mimeType = source?.type === "base64" ? source.media_type : image.mimeType;
  if (typeof data !== "string" || typeof mimeType !== "string") return null;
  const attachment = { data, mimeType };
  return isBase64ImageWithinLimits(attachment) ? attachment : null;
}

/** Return an API-safe error for prompt, steering, and follow-up image arrays. */
export function validateAgentImages(value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return "images must be an array";
  if (value.length > MAX_ATTACHED_IMAGES) {
    return `A message can include at most ${MAX_ATTACHED_IMAGES} images`;
  }
  for (const image of value) {
    if (!image || typeof image !== "object" || (image as { type?: unknown }).type !== "image") {
      return "Each attachment must be an image";
    }
    if (!isBase64ImageWithinLimits(image)) {
      return `Each image must be valid base64 image data of ${MAX_ATTACHED_IMAGE_BYTES / (1024 * 1024)}MB or smaller`;
    }
  }
  return null;
}

export const CLIENT_IMAGE_COMPRESSION_THRESHOLD_BYTES = 1024 * 1024;
export const CLIENT_MAX_IMAGE_SIDE = 1024;
export const CLIENT_JPEG_QUALITY = 0.85;

export function shouldCompressImageFile(file: Pick<File, "size" | "type">): boolean {
  return file.size > CLIENT_IMAGE_COMPRESSION_THRESHOLD_BYTES && file.type !== "image/gif";
}

function readImageFile(file: Blob, mimeType: string): Promise<{ data: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const data = typeof reader.result === "string" ? reader.result.split(",")[1] : undefined;
      if (!data) {
        reject(new Error("Failed to read image"));
        return;
      }
      resolve({ data, mimeType });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Compress oversized raster attachments before they enter draft/session state. */
export async function compressImageFile(file: File): Promise<{ data: string; mimeType: string }> {
  const original = () => readImageFile(file, file.type);
  if (!shouldCompressImageFile(file) || typeof createImageBitmap !== "function") return original();

  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return original();

  try {
    const scale = Math.min(1, CLIENT_MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return original();
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL("image/jpeg", CLIENT_JPEG_QUALITY).split(",")[1];
    return data && data.length < Math.ceil(file.size / 3) * 4
      ? { data, mimeType: "image/jpeg" }
      : original();
  } catch {
    return original();
  } finally {
    bitmap.close();
  }
}
