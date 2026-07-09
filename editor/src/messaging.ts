// Origin-checked postMessage helpers (spec/05 §2: "both directions, origin-checked").
// The overlay always talks to its own immediate parent frame, which is always the
// same origin as the overlay itself (both served by the one wixy FastAPI app) — so
// "the expected origin" is simply this window's own origin, never a wildcard.

import type { OverlayToShellMessage, ShellToOverlayMessage } from "./protocol";
import { parseShellToOverlayMessage } from "./protocol";

export function expectedShellOrigin(win: Window = window): string {
  return win.location.origin;
}

export function sendToShell(message: OverlayToShellMessage, win: Window = window): void {
  const parent = win.parent;
  if (parent === win) return; // not actually embedded in an iframe — nothing to send to
  parent.postMessage(message, expectedShellOrigin(win));
}

/** Registers the shell -> overlay listener, rejecting any message whose `event.origin`
 * doesn't match this window's own origin, or whose payload isn't a recognized
 * protocol message. Returns an unsubscribe function. */
export function onShellMessage(
  handler: (message: ShellToOverlayMessage) => void,
  win: Window = window,
): () => void {
  const expected = expectedShellOrigin(win);
  const listener = (event: MessageEvent): void => {
    if (event.origin !== expected) return;
    const message = parseShellToOverlayMessage(event.data);
    if (message !== null) handler(message);
  };
  win.addEventListener("message", listener);
  return () => win.removeEventListener("message", listener);
}
