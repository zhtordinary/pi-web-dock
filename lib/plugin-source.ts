export type PluginSourceKind = "local" | "npm" | "git";

export function pluginSourceKind(source: string): PluginSourceKind {
  const normalized = source.trim().toLowerCase();
  if (normalized.startsWith("npm:")) return "npm";
  if (
    normalized.startsWith("git:") ||
    normalized.startsWith("git@") ||
    normalized.startsWith("git+") ||
    normalized.startsWith("github:") ||
    normalized.startsWith("http://") ||
    normalized.startsWith("https://") ||
    normalized.startsWith("ssh://")
  ) return "git";
  return "local";
}

function packageNameFromSource(source: string): string {
  const trimmed = source.trim().replace(/[?#].*$/, "").replace(/[\\/]+$/, "");
  if (!trimmed) return source;

  if (trimmed.toLowerCase().startsWith("npm:")) {
    const npmSpec = trimmed.slice(4);
    const packageNameEnd = npmSpec.startsWith("@") ? npmSpec.indexOf("/", 1) : 0;
    const lastAt = npmSpec.lastIndexOf("@");
    return (lastAt > packageNameEnd ? npmSpec.slice(0, lastAt) : npmSpec) || source;
  }

  const repositoryName = trimmed.split(/[\\/]/).pop()?.replace(/^git:/i, "").replace(/\.git$/i, "") || source;
  const refSeparator = repositoryName.lastIndexOf("@");
  return refSeparator > 0 ? repositoryName.slice(0, refSeparator) : repositoryName;
}

function compactPackageName(name: string): string {
  const slash = name.lastIndexOf("/");
  return name.startsWith("@") && slash > 0 ? name.slice(slash + 1) : name;
}

export function pluginNameFromSource(source: string, packageName?: string): string {
  const sourceName = packageNameFromSource(source);
  const name = pluginSourceKind(source) === "git"
    ? sourceName
    : packageName?.trim() || sourceName;
  return compactPackageName(name);
}

type ExtensionSourceInfo = {
  source: string;
  origin: "package" | "top-level";
  baseDir?: string;
};

function stripExtension(value: string): string {
  return value.replace(/\.(?:[cm]?[jt]sx?|mjs|cjs)$/i, "");
}

function readableExtensionSegment(value: string): string {
  const segments = value.replaceAll("\\", "/").split("/").filter(Boolean);
  const leaf = segments.at(-1) ?? value;
  if (/^index\.(?:[cm]?[jt]sx?|mjs|cjs)$/i.test(leaf)) return stripExtension(segments.at(-2) ?? leaf);
  return stripExtension(leaf);
}

export function extensionDisplayName(
  path: string,
  sourceInfo?: ExtensionSourceInfo | null,
  resolvedPath = path,
): string {
  if (sourceInfo?.origin === "package") return pluginNameFromSource(sourceInfo.source);
  return readableExtensionSegment(resolvedPath);
}
