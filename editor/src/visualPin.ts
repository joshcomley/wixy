// Pinning fixed bottom chrome (the composer, structured-control sheets) to the
// VISUAL viewport (decisions/00084) — and full-screen chrome likewise
// (pinCoverToVisualViewport, decisions/00090).
//
// `position: fixed; bottom: 0` anchors an element to the LAYOUT viewport. On a
// phone two everyday gestures move the visible region away from that anchor:
// the on-screen keyboard shrinks the visual viewport while the layout viewport
// stays put (fixed chrome ends up hidden beneath the keyboard), and pinch-zoom
// pans the visual viewport across the layout one (fixed chrome "scrolls off"
// and, once out of view, is unrecoverable — the operator's exact report). The
// fix is the standard one for mobile bottom toolbars: track window.visualViewport
// and re-anchor on every resize/scroll it reports.
//
// `ensureResizesContentMeta` is the keyboard half of the pair: with
// `interactive-widget=resizes-content` the keyboard resizes the LAYOUT viewport
// itself, so `bottom: 0` already sits above it and the pin's offsets simply
// read 0. Unsupported engines (iOS Safari) ignore the meta key and are covered
// by the pin alone. The overlay only ever rewrites the meta of the PREVIEW
// document it was injected into — never anything published.

export interface VisualPinOptions {
  /** Whole-iframe device-simulation scale (1 unscaled) — the composer counter-
   * scales by this, so its pinned width is the visual width × scale. Absent = 1. */
  widthScale?: () => number;
  /** Fired after every pin update (the composer re-fits its textarea: a width
   * change rewraps the text). */
  onUpdate?: () => void;
}

export interface VisualPin {
  /** False when the platform has no visualViewport — the pin is then inert and
   * the element keeps its stylesheet positioning. */
  readonly active: boolean;
  /** Recompute and apply the anchor now (e.g. after the counter-scale changed). */
  update: () => void;
  /** Detach the listeners and restore the element's pre-pin inline styles. */
  release: () => void;
}

export function pinToVisualViewport(
  el: HTMLElement,
  win: Window,
  options: VisualPinOptions = {},
): VisualPin {
  const vv = win.visualViewport;
  if (vv === null || vv === undefined) {
    return { active: false, update: () => {}, release: () => {} };
  }

  // Restored on release so the element falls back to exactly what it had
  // before (stylesheet bottom:0, the composer's % width, …).
  const prior = { bottom: el.style.bottom, left: el.style.left, width: el.style.width };

  function update(): void {
    if (vv === null || vv === undefined) return;
    // Distance from the LAYOUT viewport's bottom edge down to the visual one's
    // — 0 whenever the two coincide (desktop, keyboard with resizes-content).
    const bottom = Math.max(0, win.innerHeight - vv.height - vv.offsetTop);
    el.style.bottom = `${bottom}px`;
    el.style.left = `${vv.offsetLeft}px`;
    el.style.width = `${vv.width * (options.widthScale?.() ?? 1)}px`;
    options.onUpdate?.();
  }

  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  update();

  return {
    active: true,
    update,
    release: () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      el.style.bottom = prior.bottom;
      el.style.left = prior.left;
      el.style.width = prior.width;
    },
  };
}

/** Pin a FULL-VIEWPORT surface to the visual viewport (decisions/00090) — the
 * cover-mode twin of pinToVisualViewport, for the Q&A editor. Stylesheet
 * `position: fixed; inset: 0` covers the LAYOUT viewport, which on iOS extends
 * beneath the open keyboard (the sheet's lower rows unreachable) and under
 * pinch-zoom is larger than the visible region. Cover-pinning re-anchors
 * top/left/width/height to the visual rect on every resize/scroll, so the
 * surface always exactly covers what's actually visible. */
export function pinCoverToVisualViewport(el: HTMLElement, win: Window): VisualPin {
  const vv = win.visualViewport;
  if (vv === null || vv === undefined) {
    return { active: false, update: () => {}, release: () => {} };
  }

  // Restored on release so the element falls back to exactly what it had
  // before (stylesheet inset:0 — which already covers the layout viewport).
  const prior = {
    top: el.style.top,
    left: el.style.left,
    width: el.style.width,
    height: el.style.height,
  };

  function update(): void {
    if (vv === null || vv === undefined) return;
    el.style.top = `${vv.offsetTop}px`;
    el.style.left = `${vv.offsetLeft}px`;
    el.style.width = `${vv.width}px`;
    el.style.height = `${vv.height}px`;
  }

  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  update();

  return {
    active: true,
    update,
    release: () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      el.style.top = prior.top;
      el.style.left = prior.left;
      el.style.width = prior.width;
      el.style.height = prior.height;
    },
  };
}

/** Append `interactive-widget=resizes-content` to the document's viewport meta
 * (idempotent; a page without a viewport meta is left alone rather than
 * crashing the overlay over a broken page). */
export function ensureResizesContentMeta(doc: Document): void {
  const meta = doc.querySelector('meta[name="viewport"]');
  if (meta === null) return;
  const content = meta.getAttribute("content") ?? "";
  if (/interactive-widget\s*=/.test(content)) return;
  meta.setAttribute("content", `${content}, interactive-widget=resizes-content`);
}
