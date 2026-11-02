/** Identity of the favorites category the server creates for every install. */
export const DEFAULT_SLASH_FAVORITE_CATEGORY_ID = "default";
/** Name the server stores for that category until the user renames it. */
export const DEFAULT_SLASH_FAVORITE_CATEGORY_NAME = "常用";

/**
 * Show the untouched default favorites category in the current UI language;
 * every other category keeps the name the user gave it.
 */
export function slashFavoriteCategoryLabel(category: { id: string; name: string }, defaultLabel: string): string {
  return category.id === DEFAULT_SLASH_FAVORITE_CATEGORY_ID && category.name === DEFAULT_SLASH_FAVORITE_CATEGORY_NAME
    ? defaultLabel
    : category.name;
}

/**
 * Display-only restoration for the exact envelope emitted by pi's
 * `_expandSkillCommand`. The expanded text remains the stored session input.
 */
const SKILL_EXPANSION_RE = /^<skill name="([^"\n]+)" location="([^"\n]+)">\nReferences are relative to [^\n]+\.\n\n([\s\S]*)\n<\/skill>(?:\n\n([\s\S]+))?$/;

/**
 * Restore a complete SDK skill expansion to its compact command form.
 *
 * The expression intentionally requires the opening envelope, matching
 * base-directory reference, final closing tag, and an optional two-newline args
 * suffix. This avoids collapsing ordinary text that merely starts with a
 * skill-looking tag. The greedy body capture makes the final closing tag win
 * when a skill body contains an example `</skill>` tag.
 */
export function skillExpansionToCommand(text: string): string | null {
  const match = text.match(SKILL_EXPANSION_RE);
  if (!match) return null;

  const [, name, , , args] = match;
  return args ? `/skill:${name} ${args}` : `/skill:${name}`;
}
