// Reader test fixture for the external package contract, not production model rules.
export const IMAGE_GENERATION_CONFIG_API_VERSION = 1;
export const DEFAULT_OUTPUT_DIR = "fixture-output";
export const OPENAI_IMAGE_MODELS = ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare"];
export const GEN_OPTION_KEYS = { size: "genSize", resolution: "genResolution", quality: "genQuality", version: "genVersion" };
export function genProviderModels() { return ["fixture-model"]; }
export function generationPanelCapabilities() { return { "fixture-model": { resolutions: [], note: "fixture-v1" } }; }
export function generationSessionConfig() { return {}; }
export function resolveEffectiveConfig() { throw new Error("Test fixture does not implement production configuration."); }
export function projectGenerationConfigPath(cwd: string) { return cwd + "/.pi/image-generation.json"; }
export function readGenOptionUnsets() { return []; }
export function mergeSessionGenOptions() { return {}; }
export function clearSessionGenOptions() { return {}; }
