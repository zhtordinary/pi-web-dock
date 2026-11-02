import { join } from "node:path";
import { createJiti } from "jiti";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { GenCapability } from "./gen-capabilities";

interface GenerationProvider { baseUrl?: string; backend?: "sync" | "async-task" | "chat-completions"; models?: (string | { id?: string; name?: string })[] }
interface GenerationConfig {
  genEnabled: "on" | "off";
  genProvider?: string;
  genModelId?: string;
  genBackend?: "sync" | "async-task" | "chat-completions";
  genSize?: string;
  genResolution?: string;
  genQuality?: string;
  genVersion?: "flare" | "sunburst";
  parameterSources?: Record<string, string>;
  outputDirGlobal?: string;
  outputDirProject?: string;
  providers: Record<string, GenerationProvider>;
}
type OptionField = "size" | "resolution" | "quality" | "version";
export interface ImageGenerationPackage {
  IMAGE_GENERATION_CONFIG_API_VERSION: number;
  DEFAULT_OUTPUT_DIR: string;
  OPENAI_IMAGE_MODELS: string[];
  GEN_OPTION_KEYS: Record<OptionField, string>;
  genProviderModels(provider: GenerationProvider): string[];
  generationPanelCapabilities(provider?: string, agentDir?: string, cwd?: string, backend?: "sync" | "async-task" | "chat-completions"): Record<string, GenCapability>;
  generationSessionConfig(entries: unknown[]): Record<string, unknown>;
  resolveEffectiveConfig(entries: unknown[], cwd: string, agentDir?: string): GenerationConfig;
  projectGenerationConfigPath(cwd: string): string;
  readGenOptionUnsets(value: unknown): OptionField[];
  mergeSessionGenOptions(existing: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown>;
  clearSessionGenOptions(existing: Record<string, unknown>, fields: OptionField[]): Record<string, unknown>;
}

/** Load the installed package contract, not a second copy bundled with Reader. */
export function loadImageGenerationPackage(agentDir = getAgentDir()): ImageGenerationPackage {
  try {
    const loaded = createJiti(join(agentDir, "image-generation-loader.cjs"), { moduleCache: false, fsCache: false })(
      join(agentDir, "packages", "pi-image-generation", "config.ts"),
    ) as ImageGenerationPackage;
    if (loaded.IMAGE_GENERATION_CONFIG_API_VERSION !== 1 || !["resolveEffectiveConfig", "generationPanelCapabilities", "generationSessionConfig", "projectGenerationConfigPath", "genProviderModels", "readGenOptionUnsets", "mergeSessionGenOptions", "clearSessionGenOptions"]
      .every((key) => typeof (loaded as unknown as Record<string, unknown>)[key] === "function")) throw new Error("Incompatible image package contract");
    return loaded;
  } catch {
    throw new Error("Image generation package is unavailable or incompatible. Install or update pi-image-generation; Reader cannot substitute generation rules.");
  }
}
