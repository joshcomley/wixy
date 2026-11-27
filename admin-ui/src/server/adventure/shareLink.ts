// Copying and sharing a place's short link (the public Adventure Time page, spec/adventure-public §1, §2.4).
// Used by the game pane's Copy link / Share actions and by the Holiday bank's rows. Nothing here talks to a
// server: it only hands a URL to the clipboard or to the device's own share sheet.

/** What a place's link is shared as. */
export interface ShareTarget {
  /** The absolute short link (`https://adventure.cinnamons.uk/d/<code>`). */
  readonly url: string;
  /** The place's name (the share sheet's title). */
  readonly title: string;
  /** One line to go with the link (the share sheet's text). */
  readonly text: string;
}

export type ShareResult = "shared" | "cancelled" | "failed";

/** Whether the browser has a native share sheet (phones, some desktops). */
export function canNativeShare(win: Window): boolean {
  return typeof win.navigator.share === "function";
}

/**
 * Puts `text` on the clipboard. Tries the async Clipboard API, then the legacy `execCommand("copy")`
 * on a throwaway textarea (an insecure context, an older WebView). Returns whether either worked;
 * never throws.
 */
export async function copyText(win: Window, doc: Document, text: string): Promise<boolean> {
  try {
    const clipboard = win.navigator.clipboard as Clipboard | undefined;
    if (clipboard !== undefined && typeof clipboard.writeText === "function") {
      await clipboard.writeText(text);
      return true;
    }
  } catch {
    // blocked or not permitted: fall through to the legacy path
  }
  const area = doc.createElement("textarea");
  try {
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "0";
    area.style.left = "-9999px";
    area.style.opacity = "0";
    doc.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length);
    return typeof doc.execCommand === "function" && doc.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

/** Opens the device's share sheet for `target`. "cancelled" is the person closing it (not an error). */
export async function nativeShare(win: Window, target: ShareTarget): Promise<ShareResult> {
  if (!canNativeShare(win)) return "failed";
  try {
    await win.navigator.share({ title: target.title, text: target.text, url: target.url });
    return "shared";
  } catch (error) {
    return error instanceof DOMException && error.name === "AbortError" ? "cancelled" : "failed";
  }
}
