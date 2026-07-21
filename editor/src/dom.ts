// DOM-level binding discovery (spec/05 §2's hover/click targeting). Pure lookups over
// the live iframe DOM — no state of its own.

import type { BindingKind } from "./protocol";

/** The CSS selector spec/05 §2 gives for hover targeting — deliberately excludes
 * `data-wx-attr` (reachable only via the page-settings drawer, since attribute
 * bindings can sit on non-hoverable elements like `<body>`) and `data-wx-if` (which
 * gets its own opacity+eye-toggle treatment, not the outline+chip). */
export const HOVER_TARGET_SELECTOR =
  "[data-wx], [data-wx-img], [data-wx-bg], [data-wx-href], [data-wx-list]";

export interface DetectedBinding {
  element: Element;
  key: string;
  kind: BindingKind;
}

/** Which binding this element represents for hover/click purposes, applying the same
 * precedence the real render walk implies: a `data-wx-list` container never also
 * carries a scalar binding on itself (`builder.bindings._walk` returns immediately
 * after `_expand_list`, per M6); an anchor that's both `data-wx-href` and `data-wx`
 * (the CTA pattern, spec/05 §2: "popover with label (if the same element is also
 * data-wx) + href field") is treated as a Link, with the text becoming an extra field
 * in that same popover rather than a competing click target. */
export function detectBinding(element: Element): DetectedBinding | null {
  const list = element.getAttribute("data-wx-list");
  if (list !== null) return { element, key: list, kind: "list" };

  const href = element.getAttribute("data-wx-href");
  if (href !== null) return { element, key: href, kind: "href" };

  const img = element.getAttribute("data-wx-img");
  if (img !== null) return { element, key: img, kind: "img" };

  const bg = element.getAttribute("data-wx-bg");
  if (bg !== null) return { element, key: bg, kind: "bg" };

  const text = element.getAttribute("data-wx");
  if (text !== null) return { element, key: text, kind: "text" };

  return null;
}

/** The nearest hoverable bound element at or above `start` (a click/hover often
 * lands on a text node or nested inline element inside the bound one). */
export function closestBoundElement(start: Element): DetectedBinding | null {
  const el = start.closest(HOVER_TARGET_SELECTOR);
  return el !== null ? detectBinding(el) : null;
}

/** Human label for the hover chip (spec/05 §2: "Text"/"Image"/"Link"/"List" — `bg`
 * shares "Image"'s label since both resolve the same `{src, alt}` shape and get the
 * same media-replace treatment). */
export function chipLabel(kind: BindingKind): string {
  switch (kind) {
    case "text":
      return "Text";
    case "img":
    case "bg":
      return "Image";
    case "href":
      return "Link";
    case "list":
      return "List";
    case "if":
      return "Visibility";
    case "attr":
      return "Attribute";
  }
}

/** Overlay chrome injected INTO content elements (today: the data-wx-if eye
 * toggle's button — overlay.ts `ensureIfToggle`). Every value read/seed path
 * excludes nodes matching this so editor chrome can never leak into committed
 * content (the 2026-07-21 incident, decisions/00073). */
export const OVERLAY_CHROME_SELECTOR = ".wx-if-eye-toggle";

/** A text binding is "rich-lite" (spec/05 §2) when its current rendered content has
 * any element children (the `em`/`strong`/`a`/`span`/`br` allowlist, spec/02 §5) —
 * plain text alone gets the simple input/textarea popover instead. Injected overlay
 * chrome (an eye toggle inside an if-bound text element) is NOT content and never
 * makes a binding rich-lite. */
export function isRichLiteContent(element: Element): boolean {
  return Array.from(element.children).some((child) => !child.matches(OVERLAY_CHROME_SELECTOR));
}
