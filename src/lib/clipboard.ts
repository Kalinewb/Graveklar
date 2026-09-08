/**
 * One place for "put this string on the clipboard".
 *
 * The async Clipboard API only exists in a **secure context**. This admin
 * panel is explicitly deployed over plain HTTP on a LAN as well (see the
 * `isSecureRequest` note in `src/app/api/admin/login/route.ts`), and there
 * `navigator.clipboard` is `undefined` — so `navigator.clipboard.writeText(…)`
 * throws a TypeError before it ever reaches a permission check. Call sites
 * that awaited it without a catch simply did nothing and reported nothing,
 * which is how the 2FA "manuell oppføring" copy button came to look broken.
 *
 * So: try the modern API, fall back to `document.execCommand('copy')`, and
 * always resolve to a boolean instead of throwing, so the caller can tell the
 * user when it did not work.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false;

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Missing permission, a non-focused document, or an insecure context that
    // still exposes a stub. Either way the legacy path is worth a try.
  }

  return execCommandCopy(text);
}

/**
 * The pre-Clipboard-API route: select a throwaway node and let the browser
 * copy the selection.
 *
 * It deliberately selects a node rather than focusing a `<textarea>`. Every
 * caller of this lives inside a Radix dialog, whose focus scope pulls focus
 * straight back out of any element appended to the body — which would clear
 * the selection and make the copy a silent no-op. Selection needs no focus.
 */
function execCommandCopy(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false;

  const node = document.createElement('span');
  node.textContent = text;
  // `display: none` / `hidden` would leave nothing to select. Keep the node
  // rendered but invisible and out of the layout flow.
  node.style.position = 'fixed';
  node.style.top = '0';
  node.style.left = '0';
  node.style.opacity = '0';
  node.style.pointerEvents = 'none';
  node.style.whiteSpace = 'pre';
  node.setAttribute('aria-hidden', 'true');

  document.body.appendChild(node);

  const selection = typeof window !== 'undefined' ? window.getSelection() : null;
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  try {
    if (!selection) return false;
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    // Restore whatever the user had selected before the button was pressed.
    selection?.removeAllRanges();
    if (previous) selection?.addRange(previous);
    node.remove();
  }
}
