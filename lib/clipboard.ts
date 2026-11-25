export function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => fallbackCopy(text));
  }
  return fallbackCopy(text);
}
function fallbackCopy(text: string): Promise<boolean> {
  let ta: HTMLTextAreaElement | undefined;
  try {
    ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    return Promise.resolve(document.execCommand("copy"));
  } catch {
    return Promise.reject();
  } finally {
    ta?.remove();
  }
}
