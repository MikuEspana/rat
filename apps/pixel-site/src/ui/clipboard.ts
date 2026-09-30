// Copy text to the clipboard: the Clipboard API where the page may use it, else a hidden textarea and
// execCommand('copy') (older phones, http pages, a denied permission).

type Nav = { clipboard?: { writeText(t: string): Promise<void> } };

export async function copyText(text: string, nav: Nav | undefined = globalThis.navigator, doc: Document | undefined = globalThis.document): Promise<boolean> {
  try {
    if (nav?.clipboard?.writeText) {
      await nav.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the textarea
  }
  if (!doc?.body) return false;
  const ta = doc.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '-9999px';
  ta.style.opacity = '0';
  doc.body.appendChild(ta);
  try {
    ta.select();
    ta.setSelectionRange(0, text.length);
    return doc.execCommand('copy');
  } catch {
    return false;
  } finally {
    ta.remove();
  }
}
