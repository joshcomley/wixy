// Internal-link interception (spec/05 §2): "Browsing inside the iframe stays in
// edit mode: the overlay rewrites internal link clicks to the preview equivalent
// and notifies the shell (URL hash + page dropdown follow along). External links
// are inert in edit mode (toast: 'external link')."
//
// A link is "internal" when it resolves (same-origin) to a real published page
// path this server would serve — `builder.nav.page_url`'s own convention: "/" for
// the home page, "/<slug>.html" for everything else (the ONLY shape the builder
// ever emits for an internal href, spec/02 §3's nav derivation). Anything else (a
// different origin, an /admin/* or /api/* path, a path that doesn't match that
// convention, or a non-http(s) scheme like mailto:/tel:) is left alone or treated
// as external — never hijacked into a preview navigation.

const PAGE_PATH = /^\/([A-Za-z0-9_-]+)\.html$/;

/** The preview-equivalent page slug for an anchor's href, or `null` if the link
 * isn't a same-origin real-page link. Reads the raw `href` ATTRIBUTE (not the
 * resolved IDL property) — same portability reasoning as this package's other
 * `getAttribute` uses (popovers.ts, opTargeting.ts) — and resolves it against
 * the SITE ROOT (`win.location.origin + "/"`), not the current window path:
 * the preview document carries a `<base href="/">` (wixy_server/preview.py), so
 * a real browser resolves even a bare relative href like "about.html" against
 * the root, not against /admin/preview/. Matching that resolution base here is
 * what makes this agree with what a real click would actually navigate to. */
export function resolveInternalPageSlug(anchor: Element, win: Window): string | null {
  const href = anchor.getAttribute("href");
  if (href === null || href === "") return null;

  // A pure same-page fragment (e.g. "#contact") must stay a native in-page
  // scroll, never a navigation. This matters specifically because of the same
  // <base href="/"> above — with a <base> present, resolving "#contact"
  // against it would otherwise produce "/#contact" (a DIFFERENT page, the site
  // root), not "stay here and scroll."
  if (href.startsWith("#")) return null;

  let url: URL;
  try {
    url = new URL(href, `${win.location.origin}/`);
  } catch {
    return null;
  }
  if (url.origin !== win.location.origin) return null;
  if (url.pathname === "/") return "index";
  const match = PAGE_PATH.exec(url.pathname);
  return match?.[1] ?? null;
}

const TOAST_CLASS = "wx-toast";
const TOAST_DURATION_MS = 2200;

/** A transient, self-dismissing toast (spec/05 §2's "toast: 'external link'") —
 * pure DOM chrome local to the overlay's own document, same pattern as the hover
 * chip/item toolbar (no shell round-trip needed for this, so no injectable
 * `win` seam either — always the real global `document`/`setTimeout`). */
export function showToast(message: string): void {
  const toast = document.createElement("div");
  toast.className = TOAST_CLASS;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), TOAST_DURATION_MS);
}
