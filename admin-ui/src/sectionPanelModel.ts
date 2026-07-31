// Pure, DOM-free array/content-shape helpers for `sectionPanel.ts` — kept
// separate so the guided-add gating, reorder, and content-path logic are
// unit-testable with vitest without mounting real DOM (mirrors opQueue.ts's
// "framework-free core, unit-testable without a real iframe" convention).

import type { AdminField } from "./api";
import type { JsonValue } from "./protocol";

export type SectionItem = Record<string, JsonValue>;

/** Reads a dotted content path (e.g. "gallery.sliders") out of a page's
 * `content` object — the client-side mirror of `builder.content.dotted_get`.
 * Missing/wrong-shape at any hop reads as `undefined` (never throws) so a
 * section whose page content hasn't been touched yet just starts empty. */
export function dottedGet(
  content: Record<string, JsonValue>,
  path: string,
): JsonValue | undefined {
  const segments = path.split(".");
  let current: JsonValue | undefined = content;
  for (const segment of segments) {
    if (
      current === undefined ||
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current)
    ) {
      return undefined;
    }
    current = (current as Record<string, JsonValue>)[segment];
  }
  return current;
}

/** The array at a collection's path, or `[]` if absent/wrong-shape — a
 * collection the owner has never touched has no key in content at all yet
 * (spec 3c: "missing -> empty array"). Non-object entries (a malformed
 * draft) are dropped rather than crashing the panel. */
export function itemsAt(content: Record<string, JsonValue>, path: string): SectionItem[] {
  const raw = dottedGet(content, path);
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is SectionItem =>
      typeof item === "object" && item !== null && !Array.isArray(item),
  );
}

export function moveItemUp(items: SectionItem[], index: number): SectionItem[] {
  return moveItemTo(items, index, index - 1);
}

export function moveItemDown(items: SectionItem[], index: number): SectionItem[] {
  return moveItemTo(items, index, index + 1);
}

/** Reorders `items` by moving the item at `fromIndex` to `toIndex` —
 * out-of-range moves are clamped to the nearest valid position (or left
 * untouched entirely for an out-of-range `fromIndex`), so a boundary ↑/↓
 * click or a drag dropped past either end never throws or drops an item. */
export function moveItemTo(items: SectionItem[], fromIndex: number, toIndex: number): SectionItem[] {
  if (fromIndex < 0 || fromIndex >= items.length) return items;
  const clampedTo = Math.max(0, Math.min(items.length - 1, toIndex));
  if (clampedTo === fromIndex) return items;
  const next = items.slice();
  const [moved] = next.splice(fromIndex, 1);
  if (moved === undefined) return items;
  next.splice(clampedTo, 0, moved);
  return next;
}

export function deleteItemAt(items: SectionItem[], index: number): SectionItem[] {
  return items.filter((_, i) => i !== index);
}

export function updateItemField(
  items: SectionItem[],
  index: number,
  key: string,
  value: JsonValue,
): SectionItem[] {
  return items.map((item, i) => (i === index ? { ...item, [key]: value } : item));
}

export function appendItem(items: SectionItem[], item: SectionItem): SectionItem[] {
  return [...items, item];
}

/** A picked image field's `{src, alt}` — or `null` if the field is unset or
 * malformed (e.g. a hand-edited draft), read defensively rather than
 * throwing so one bad item never breaks the whole card list. */
export function imageFieldValue(item: SectionItem, key: string): { src: string; alt: string } | null {
  const value = item[key];
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, JsonValue>;
  const src = record["src"];
  const alt = record["alt"];
  if (typeof src !== "string" || src.trim() === "") return null;
  return { src, alt: typeof alt === "string" ? alt : "" };
}

export function textFieldValue(item: SectionItem, key: string): string {
  const value = item[key];
  return typeof value === "string" ? value : "";
}

/** The guided add flow's Save gate (spec 3c): every `image` field must carry
 * a non-blank src, and the field literally named "title" (if the collection
 * has one) must be non-blank text — the one text field the brief singles
 * out as required. Other text/choice fields (`sub`, `cat`) never block
 * Save — `cat` always starts pre-filled from the first option, so it's
 * never genuinely blank in practice. */
export function isNewItemComplete(fields: readonly AdminField[], item: SectionItem): boolean {
  for (const field of fields) {
    if (field.kind === "image" && imageFieldValue(item, field.key) === null) return false;
    if (field.key === "title" && textFieldValue(item, field.key).trim() === "") return false;
  }
  return true;
}

/** A brand-new item's starting shape: text/choice fields get an explicit
 * default (choice pre-fills the first option per spec 3c: "category
 * defaults to the first option"); an image field gets NO key at all until a
 * photo is actually picked, so `imageFieldValue` correctly reads it as
 * "unset" rather than needing a second blank-src special case. */
export function blankItem(fields: readonly AdminField[]): SectionItem {
  const item: SectionItem = {};
  for (const field of fields) {
    if (field.kind === "choice") {
      item[field.key] = field.options[0]?.value ?? "";
    } else if (field.kind === "text") {
      item[field.key] = "";
    }
  }
  return item;
}

// -- Entity decoding for display (spec 3c) -----------------------------------
// A collection item's text value is stored PLAIN — the builder's BeautifulSoup
// render pass HTML-escapes it at serialization time (decisions/00095's
// contentModel.ts precedent: DOM `.textContent` already returns decoded text,
// so the inline editor's own composer never stores escaped entities). A value
// written through some OTHER path (hand-edited JSON, a future import) could
// still carry literal entity text though — decoding on display, and never
// re-encoding on save, keeps both paths converging on the same plain form
// instead of a value silently accumulating extra escaping every round-trip.

const _ENTITY_RE = /&(amp|lt|gt|quot|apos|#39|nbsp);/g;
const _ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
  nbsp: " ",
};

export function decodeCommonEntities(text: string): string {
  return text.replace(_ENTITY_RE, (match, name: string) => _ENTITY_MAP[name] ?? match);
}
