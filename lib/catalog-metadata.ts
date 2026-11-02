import type { HiddenState } from "./hidden-state";
import type { FavoriteState } from "./favorite-state";
import type { SessionCategoryState } from "./session-category-state";
import type { ViewedState } from "./viewed-state";
export interface CatalogMetadataWarning {
  deviceId: string;
  domain: "hidden" | "favorites" | "categories" | "viewed" | "execution";
  code: "metadata_unavailable" | "execution_observation_incomplete";
}
/** Read-only degradation. Mutators still use strict locked reads and never
 * persist these fallback values. Unknown visibility must hide the catalog. */
export function readCatalogMetadata(deviceId: string, readers: {
  hidden: () => HiddenState; favorites: () => FavoriteState;
  categories: () => SessionCategoryState; viewed: () => ViewedState;
}) {
  const warnings: CatalogMetadataWarning[] = [];
  function read<T>(domain: CatalogMetadataWarning["domain"], load: () => T, fallback: T): T {
    try { return load(); } catch { warnings.push({ deviceId, domain, code: "metadata_unavailable" }); return fallback; }
  }
  const hidden = read<HiddenState | null>("hidden", readers.hidden, null);
  return { hidden, favorites: read("favorites", readers.favorites, {sessions:[]}),
    categories: read("categories", readers.categories, {to_discuss:[],to_revise:[],completed:[]}),
    viewed: read("viewed", readers.viewed, {}), warnings };
}
