import type { SessionStorageCategory } from "./session-category-state.ts";

export type SessionStorageScope = "normal" | "hidden" | "favorites" | SessionStorageCategory;

export interface SessionStorageMembership {
  category?: SessionStorageCategory;
  favorite: boolean;
  hidden: boolean;
}

/** Resolve one session to exactly one visible storage scope. */
export function sessionStorageScopeFor(membership: SessionStorageMembership): SessionStorageScope {
  if (membership.hidden) return "hidden";
  if (membership.favorite) return "favorites";
  return membership.category ?? "normal";
}

export function isSessionStorageCategory(scope: SessionStorageScope): scope is SessionStorageCategory {
  return scope === "to_discuss" || scope === "to_revise" || scope === "completed";
}

export function matchesSessionStorageScope(
  scope: SessionStorageScope,
  membership: SessionStorageMembership,
): boolean {
  return sessionStorageScopeFor(membership) === scope;
}
