import { parseFrontmatter } from "./frontmatter";

export interface SkillContentParts {
  frontmatter: Record<string, unknown> | null;
  body: string;
}

/**
 * Split an authorized SKILL.md into the metadata shown by the panel and the
 * Markdown body rendered by the existing sanitized Markdown surface.
 *
 * Keep the body bytes after the frontmatter fence intact. The content route
 * has already authorized and bounded the file; this helper only changes the
 * presentation boundary and never interprets the body as instructions.
 */
export function parseSkillContent(content: string): SkillContentParts {
  const parsed = parseFrontmatter(content);
  return { frontmatter: parsed.data, body: parsed.rest };
}
