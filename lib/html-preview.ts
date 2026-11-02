function escapeHtmlAttribute(value: string): string {
  return value.replace(/[&"'<>]/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      case "<": return "&lt;";
      default: return "&gt;";
    }
  });
}

/**
 * Give srcDoc HTML a project-aware base for local relative assets.
 *
 * srcDoc documents otherwise resolve relative URLs against about:srcdoc, so
 * scripts/styles/images next to a project HTML file disappear in Reader.
 * Keep the document sandboxed; only add a base URL for the static resource
 * proxy supplied by Reader.
 */
export function addHtmlPreviewBase(content: string, resourceBase: string): string {
  const baseTag = `<base href="${escapeHtmlAttribute(resourceBase)}">`;

  if (/<base\b/i.test(content)) return content;

  const head = /<head\b[^>]*>/i.exec(content);
  if (head && head.index !== undefined) {
    const insertAt = head.index + head[0].length;
    return `${content.slice(0, insertAt)}${baseTag}${content.slice(insertAt)}`;
  }

  const html = /<html\b[^>]*>/i.exec(content);
  if (html && html.index !== undefined) {
    const insertAt = html.index + html[0].length;
    return `${content.slice(0, insertAt)}<head>${baseTag}</head>${content.slice(insertAt)}`;
  }

  return `<head>${baseTag}</head>${content}`;
}
