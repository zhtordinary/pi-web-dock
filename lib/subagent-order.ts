import type { SubagentProfile } from "./subagent-profile-types";

type SubagentProfileIdentity = Pick<SubagentProfile, "scope" | "name">;

export function subagentProfileKey(profile: SubagentProfileIdentity): string {
  return `${profile.scope}:${profile.name}`;
}

export function orderSubagentProfiles<T extends SubagentProfileIdentity>(
  profiles: readonly T[],
  order: readonly string[],
): T[] {
  const rank = new Map<string, number>();
  for (const [index, key] of order.entries()) {
    if (!rank.has(key)) rank.set(key, index);
  }

  return profiles
    .map((profile, index) => ({ profile, index, rank: rank.get(subagentProfileKey(profile)) ?? Number.MAX_SAFE_INTEGER }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ profile }) => profile);
}

export function moveSubagentProfile<T extends SubagentProfileIdentity>(
  profiles: readonly T[],
  sourceKey: string,
  targetKey: string,
  after: boolean,
): T[] | null {
  const sourceIndex = profiles.findIndex((profile) => subagentProfileKey(profile) === sourceKey);
  const targetIndex = profiles.findIndex((profile) => subagentProfileKey(profile) === targetKey);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return null;

  const next = [...profiles];
  const [moved] = next.splice(sourceIndex, 1);
  if (!moved) return null;
  const insertion = targetIndex + (after ? 1 : 0) - (sourceIndex < targetIndex ? 1 : 0);
  next.splice(insertion, 0, moved);
  return next;
}
