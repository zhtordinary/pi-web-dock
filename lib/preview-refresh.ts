type RefreshRisk = { pending: boolean; dirtyFileTabs?: boolean };

export function hasRefreshRisk(doc: Document, state: RefreshRisk): boolean {
  if (state.pending || state.dirtyFileTabs) return true;
  if (doc.querySelector('iframe,dialog[open],[role="dialog"],[role="menu"],[aria-modal="true"]')) return true;
  for (const node of doc.querySelectorAll('textarea,input,[contenteditable]')) {
    if (node.tagName === 'INPUT') {
      const input = node as HTMLInputElement;
      if (input.type === 'password') return true;
      if (input.type === 'file') { if (input.files?.length) return true; continue; }
      if (['hidden', 'checkbox', 'radio', 'button', 'submit', 'reset'].includes(input.type)) continue;
      if (input.value.trim()) return true;
    } else if (node.tagName === 'TEXTAREA') {
      if ((node as HTMLTextAreaElement).value.trim()) return true;
    } else if (node.textContent?.trim()) {
      return true;
    }
  }
  return false;
}

export function canRefreshPreview(
  doc: Document,
  state: RefreshRisk & { hidden: boolean; sessionOpen: boolean },
): boolean {
  return state.hidden && !state.sessionOpen
    && !doc.activeElement?.matches('textarea,input,[contenteditable]')
    && !hasRefreshRisk(doc, state);
}
