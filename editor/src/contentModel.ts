// Reading the CURRENT value of a bound element/subtree back out of the live DOM.
//
// The overlay never receives actual content values over postMessage (`init` only
// sends the bindings-map SHAPE, spec/05 §2) — the live-rendered iframe DOM already
// carries the real values (that's the whole point of `data-wx-*` staying in published
// HTML, spec/02 §2), so reading it back is how the overlay reconstructs a list's whole
// array before emitting the one collection-rule `op` a structural list edit requires
// (spec/02 §6/§8: "collections overlay as the whole array").
//
// This is necessarily a best-effort reconstruction, not a perfect inverse of the
// builder's own render — see `readIfValue`'s doc comment for the one real fidelity
// gap. Spec/05 §2's own words license this: "a hard iframe reload always
// reconverges (server render is the same merge)" — an imperfect in-memory guess that
// preserves observable behavior is corrected for free on the next reload regardless.

import { OVERLAY_CHROME_SELECTOR } from "./dom";
import { demoteHtmlToMarkdown } from "./markdownText";
import type { BindingField, JsonValue } from "./protocol";

/** `el` cloned with every injected overlay-chrome node removed (the data-wx-if
 * eye toggle is inserted INTO content elements at boot, overlay.ts
 * `ensureIfToggle`). Reading values from the clone — never the live element —
 * is what keeps chrome markup/label text out of committed draft values
 * (decisions/00073). Exported for the composer's demote-seed, which needs the
 * element tree rather than a serialized string. */
export function chromeFreeElement(el: Element): Element {
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll(OVERLAY_CHROME_SELECTOR).forEach((node) => node.remove());
  return clone;
}

/** textContent of `el` minus overlay chrome (the eye toggle's own 👁️ label is
 * part of its textContent, so plain-text reads need the strip too). */
export function chromeFreeTextContent(el: Element): string {
  return chromeFreeElement(el).textContent ?? "";
}

const BG_URL_RE = /background-image\s*:\s*url\(([^)]*)\)/i;

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readBgSrc(el: Element): string {
  const style = el.getAttribute("style") ?? "";
  const match = BG_URL_RE.exec(style);
  return match?.[1] !== undefined ? unquote(match[1]) : "";
}

/** `data-wx-if`'s original value could be any JS-falsy-rule type (spec/02 §2: `false`
 * / `null` / `""` / `[]` are all falsy) — the DOM only tells us whether it was
 * falsy-or-not (via `data-wx-hidden`'s presence), not the exact original value. This
 * reconstructs a plain boolean, which preserves the one thing that actually drives
 * rendering (truthiness) but does NOT round-trip an exotic original value's exact
 * type — acceptable per this module's own doc comment (a reload always reconverges
 * to the server's real value regardless of what an untouched sibling field guesses
 * here in the meantime). */
function readIfValue(el: Element): boolean {
  return !el.hasAttribute("data-wx-hidden");
}

/** Find `selector` within `root` — checking `root` itself first. A list item's own
 * root element can simultaneously be `data-wx-list-item` AND directly carry a scalar
 * binding (e.g. `<li data-wx-list-item data-wx=".label">`, exactly like the mini-site
 * fixture's nav/tag items) — `Element.querySelector` only searches DESCENDANTS, so a
 * self-bound root would otherwise never be found. Mirrors `builder.bindings._walk`'s
 * own control flow, which applies scalar bindings to the CURRENT element before ever
 * recursing into children. Exported for overlay.ts's list-item DOM writes (the Q&A
 * control's applyQaToDom), which must resolve item fields the same way. */
export function queryOwn(root: Element, selector: string): Element | null {
  if (root.matches(selector)) return root;
  return root.querySelector(selector);
}

/** Every element within `root` (self first, then descendants in document order)
 * matching `selector` — the "find all candidates" counterpart to `queryOwn`. */
function queryOwnAll(root: Element, selector: string): Element[] {
  const own = root.matches(selector) ? [root] : [];
  return [...own, ...Array.from(root.querySelectorAll(selector))];
}

/** Parses a `data-wx-attr` spec (`"attr:key[,attr2:key2]"`) into `(attrName, key)`
 * pairs — mirrors `builder/bindings.py:parse_attr_spec` exactly (comma-separated
 * pairs, split on the FIRST colon, whitespace-trimmed; a pair with no colon is
 * malformed and yields `null` in its slot). Kept in sync with the Python original by
 * a unit test asserting matching results on the same cases, not a byte-shared
 * fixture (Inv 20's other hand-synced pairs have one; this one doesn't need it — the
 * grammar is a few characters wide and the Python side is the only place it's
 * authored). */
export function parseAttrSpec(spec: string): Array<{ attrName: string; key: string } | null> {
  return spec.split(",").map((raw) => {
    const pair = raw.trim();
    const colon = pair.indexOf(":");
    if (colon === -1) return null;
    return { attrName: pair.slice(0, colon).trim(), key: pair.slice(colon + 1).trim() };
  });
}

/** Read an attr-kind field's current value: `builder/bindings.py:_apply_attrs` sets
 * the target HTML attribute on the SAME element that carries `data-wx-attr`, so this
 * finds the element within `root` (self first) whose spec declares `field.key` and
 * reads that attribute back — never `readScalarValue`'s selector-based lookup, which
 * only knows how to find elements by a binding's OWN `data-wx-*` attribute name and
 * has no way to express "carries a data-wx-attr spec mentioning this key" (root cause
 * of the 2026-07-28 gallery publish-corruption incident, decisions/00095: a whole-
 * array reconstruction silently dropped every attr-kind item field, e.g. `.cat`). */
function readAttrValue(root: Element, field: BindingField): string {
  for (const el of queryOwnAll(root, "[data-wx-attr]")) {
    const spec = el.getAttribute("data-wx-attr") ?? "";
    const match = parseAttrSpec(spec).find((pair) => pair !== null && pair.key === field.key);
    if (match !== undefined && match !== null) {
      return el.getAttribute(field.attr ?? match.attrName) ?? "";
    }
  }
  return "";
}

// JS regex `\s` already matches U+00A0 (NBSP is a Unicode whitespace character per
// the ECMAScript spec) — so a plain whitespace run covers the raw-character case.
// The entity below is the OTHER shape the same placeholder can take: nh3 (the
// server-side rich-lite sanitizer) re-serializes a bare U+00A0 as the literal
// 6-character entity `&nbsp;` (verified empirically: nh3.clean on a bare U+00A0
// returns `"&nbsp;"`) — a value that round-tripped through a sanitize pass carries
// that entity text, not the raw character. Both forms, and any mixture of them,
// count as "not really typed" for the purposes below.
const EMPTY_TEXT_RE = /^(?:\s|&nbsp;)*$/;

/** Collapses a demoted text value back to `""` when it's only whitespace/U+00A0/
 * literal `&nbsp;` entities — the click-target placeholder `overlay.ts:
 * blankTextLikeFields` writes into a freshly added/duplicated list item
 * (`innerHTML = "&nbsp;"`, so the item stays a real, clickable element instead of a
 * zero-height one) is real DOM content, not a value the owner ever typed. Without
 * this, any list read that happens to include a not-yet-filled-in item (every
 * structural op re-reads the WHOLE list from the DOM) stores the placeholder as if
 * it were real text — root cause B of the 2026-07-28 incident, decisions/00095. The
 * DOM-side placeholder itself is intentional and untouched; this only stops it from
 * crossing into a draft op. */
function normalizeEmptyText(value: string): string {
  return EMPTY_TEXT_RE.test(value) ? "" : value;
}

function fieldSelector(field: BindingField, attr: "data-wx" | "data-wx-img" | "data-wx-href" | "data-wx-bg" | "data-wx-list" | "data-wx-if"): string {
  return `[${attr}="${cssEscape(field.key)}"]`;
}

function cssEscape(value: string): string {
  // CSS.escape isn't guaranteed in every jsdom test environment; attribute selector
  // values here are always our own known-shape binding keys (letters/digits/./@/_-),
  // never arbitrary user text, so a minimal manual escape is enough.
  return value.replace(/(["\\])/g, "\\$1");
}

/** Read one scalar-kind field's current value from within `root` (the element
 * carrying the binding, found by the caller). */
function readScalarValue(el: Element, kind: BindingField["kind"]): JsonValue {
  switch (kind) {
    case "text":
      // Text values are stored as markdown SOURCE (decisions/00075): the DOM
      // shows the rendered form (the composer's live preview just wrote
      // <strong>/<em>/<a> into this element), so reads demote back to source —
      // otherwise an unrelated sibling edit would silently rewrite this field
      // from `**x**` to `<strong>x</strong>` in the store. normalizeEmptyText
      // cancels the click-target placeholder (see its doc comment) — never a
      // value the owner actually typed.
      return normalizeEmptyText(demoteHtmlToMarkdown(chromeFreeElement(el)));
    case "href":
      return el.getAttribute("href") ?? "";
    case "img": {
      const img = el as HTMLImageElement;
      return { src: img.getAttribute("src") ?? "", alt: img.getAttribute("alt") ?? "" };
    }
    case "bg":
      // No alt is ever written back into the DOM for a bg binding (`_apply_bg` only
      // sets the CSS background-image, per builder/bindings.py) — there is no way to
      // recover an original alt from the DOM alone; empty is the only honest guess.
      return { src: readBgSrc(el), alt: "" };
    case "if":
      return readIfValue(el);
    case "attr":
      // Unreachable in practice: readItemValue routes "attr" through readAttrValue
      // instead (a data-wx-attr spec never sits on the same selector this function's
      // caller resolves an "attr" field's element by — see readAttrValue's doc
      // comment). A page-scope attr field (e.g. `<body data-wx-attr="…:@bookingUrl">`)
      // isn't hover-targetable either (spec/05 §2 reaches it via the page-settings
      // drawer only) and never reaches this path. Kept for switch exhaustiveness.
      return null;
    case "list":
      return []; // callers needing a list's value use readListValue, not this path
  }
}

/** Recursively read one list ITEM element's fields, matching the bindings-map's
 * `items` shape (decisions/00012) — the inverse of `builder.bindings._expand_list`'s
 * per-item render, in DOM terms. */
export function readItemValue(itemRoot: Element, fields: readonly BindingField[]): JsonValue {
  const result: Record<string, JsonValue> = {};
  for (const field of fields) {
    const bareKey = field.key.startsWith(".") ? field.key.slice(1) : field.key;
    if (field.kind === "list") {
      const container = queryOwn(itemRoot, fieldSelector(field, "data-wx-list"));
      result[bareKey] = container !== null ? readListValue(container, field) : [];
      continue;
    }
    if (field.kind === "attr") {
      // data-wx-attr never matches fieldSelector's own data-wx/data-wx-* selectors
      // (it's a DIFFERENT attribute carrying a "attr:key" spec, not the field's key
      // directly) — readAttrValue is the dedicated lookup for this kind.
      result[bareKey] = readAttrValue(itemRoot, field);
      continue;
    }
    const attr =
      field.kind === "img"
        ? "data-wx-img"
        : field.kind === "href"
          ? "data-wx-href"
          : field.kind === "bg"
            ? "data-wx-bg"
            : field.kind === "if"
              ? "data-wx-if"
              : "data-wx";
    const el = queryOwn(itemRoot, fieldSelector(field, attr));
    if (el !== null) {
      result[bareKey] = readScalarValue(el, field.kind);
    }
  }
  return result;
}

/** Preview-mode marker for a `visible: false` list item — mirrors
 * `builder/bindings.py`'s `ATTR_ITEM_HIDDEN` exactly, a hand-synced pair
 * (Inv 20). The item is otherwise rendered/walked normally (so the editor can
 * still reach it and its bindings still resolve); this is what tells the
 * whole-array DOM read-back below to write `visible: false` back into the
 * reconstructed item, rather than silently un-hiding it. Exported so
 * `listOps.ts` and `overlay.ts` share the exact same string. */
export const ATTR_ITEM_HIDDEN = "data-wx-item-hidden";

/** Read every current item under a `data-wx-list` container, in document order —
 * the "whole array" a structural list edit (add/reorder/delete) must re-emit
 * (spec/02 §6/§8's collection rule). */
export function readListValue(container: Element, field: BindingField): JsonValue[] {
  const items = container.querySelectorAll(":scope > [data-wx-list-item]");
  const values: JsonValue[] = [];
  for (const item of Array.from(items)) {
    const value = readItemValue(item, field.items ?? []) as Record<string, JsonValue>;
    if (item.hasAttribute(ATTR_ITEM_HIDDEN)) value["visible"] = false;
    values.push(value);
  }
  return values;
}
