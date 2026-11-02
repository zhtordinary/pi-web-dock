/** Client-side response type; the installed pi-image-generation package owns capability rules. */
export interface GenCapability {
  /** Ratio-style size values (APIMart). */
  ratios?: string[];
  /** Pixel-string size presets (OpenAI Images API and laozhang VIP). */
  pixelSizes?: string[];
  resolutions: string[];
  /** Supported quality tiers; [] = explicit quality rejected. */
  qualities?: string[];
  versions?: string[];
  maxImages?: number;
  maxReferences?: number;
  note?: string;
}
