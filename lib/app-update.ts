/** The installed Reader package and its source repository; package.json declares the same identity. */
export const APP_PACKAGE_NAME = "@zhtordinary/pi-web-dock";
export const APP_REPOSITORY_URL = "https://github.com/zhtordinary/pi-web-dock";

/** The upstream Pi Web package and repository used by the release check. */
export const APP_UPDATE_PACKAGE_NAME = "@agegr/pi-web";
export const APP_UPDATE_REPOSITORY_URL = "https://github.com/agegr/pi-web";

const STABLE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

function parseStableVersion(version: string): [number, number, number] | null {
  const match = STABLE_VERSION_PATTERN.exec(version);
  if (!match) return null;

  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;
  return parts as [number, number, number];
}

export function isNewerStableVersion(candidate: string, current: string): boolean {
  const candidateParts = parseStableVersion(candidate);
  const currentParts = parseStableVersion(current);
  if (!candidateParts || !currentParts) return false;

  for (let index = 0; index < candidateParts.length; index += 1) {
    if (candidateParts[index] !== currentParts[index]) {
      return candidateParts[index] > currentParts[index];
    }
  }
  return false;
}

export function getPiWebReleaseUrl(version: string): string | null {
  if (!parseStableVersion(version)) return null;
  return `${APP_UPDATE_REPOSITORY_URL}/releases/tag/v${version}`;
}
