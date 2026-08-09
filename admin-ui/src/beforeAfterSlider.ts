// A lightweight, READ-ONLY drag-to-compare before/after preview (decisions/
// 00119, PR3) — ported from the PUBLIC site's own gallery slider
// (cottage-aesthetics-preview `pages/gallery.html`'s `.bas-frame`/
// `.bas-before`/`.bas-range`: two stacked `object-fit: cover` images, the
// BEFORE one clipped from the right via `clip-path`, driven by a transparent
// full-frame `<input type="range">` for free mouse+touch+keyboard drag).
// Distinct from `alignerDialog.ts`, a heavyweight canvas EDITOR this never
// reuses or replaces — this component has no editing controls at all.

export interface BeforeAfterOptions {
  beforeUrl: string;
  afterUrl: string;
  beforeAlt?: string;
  afterAlt?: string;
  /** Starting reveal position, 0-100 (default 50, matching the public site). */
  start?: number;
}

export function renderBeforeAfter(options: BeforeAfterOptions): HTMLElement {
  const frame = document.createElement("div");
  frame.className = "wx-before-after";

  const after = document.createElement("img");
  after.className = "wx-before-after-img wx-before-after-after";
  after.src = options.afterUrl;
  after.alt = options.afterAlt ?? "";

  const before = document.createElement("img");
  before.className = "wx-before-after-img wx-before-after-before";
  before.src = options.beforeUrl;
  before.alt = options.beforeAlt ?? "";

  const divider = document.createElement("div");
  divider.className = "wx-before-after-divider";

  const handle = document.createElement("div");
  handle.className = "wx-before-after-handle";

  const range = document.createElement("input");
  range.type = "range";
  range.className = "wx-before-after-range";
  range.min = "0";
  range.max = "100";
  range.setAttribute("aria-label", "Drag to compare before and after");

  function set(value: number): void {
    before.style.clipPath = `inset(0 ${100 - value}% 0 0)`;
    divider.style.left = `${value}%`;
    handle.style.left = `${value}%`;
  }

  range.addEventListener("input", () => set(Number(range.value)));

  const start = options.start ?? 50;
  range.value = String(start);
  set(start);

  frame.append(after, before, divider, handle, range);
  return frame;
}
