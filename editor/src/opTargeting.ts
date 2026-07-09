// Translating an edited DOM element into the `{file, path}` an overlay `op` targets
// (spec/02 §8's `<file>:<dotted.path>` key format).
//
// The load-bearing fact this module encodes: `dotted_get` (the server's own path
// resolver, builder/content.py) never indexes into a list — "hitting a list before
// the path is exhausted is not found." So there is NO valid dotted path that reaches
// INSIDE an array at all, at any depth. A field bound with a `.`-prefixed (item-
// relative) key — however deeply nested, even inside a list-within-a-list-item — can
// only ever be expressed as part of the OUTERMOST list's own whole-array value; there
// is no per-item or per-nested-list path to PATCH directly. Concretely: editing
// `.tags[].label` (itself nested inside `showcase.items[]`) must re-emit the ENTIRE
// `showcase.items` array, not just the `.tags` sub-array — `.tags` alone isn't a valid
// overlay path either.

export interface OpTarget {
  file: string;
  path: string;
}

/** A page-scope (`hero.title`) or global-scope (`@brand.line1`) key's direct overlay
 * target. Never call this with an item-scope (`.`-prefixed) key — there is no direct
 * target for one; use `findOutermostListContainer` + re-emit that list's whole array
 * instead (see module doc comment). */
export function directOpTarget(key: string, currentPage: string): OpTarget {
  if (key.startsWith("@")) return { file: "_global", path: key.slice(1) };
  return { file: currentPage, path: key };
}

export function isItemScopeKey(key: string): boolean {
  return key.startsWith(".");
}

export interface OutermostList {
  container: Element;
  key: string;
}

/** Walks outward from `el` through every ancestor `[data-wx-list]` container,
 * returning the OUTERMOST one — the only one whose own key can be a direct overlay
 * target (module doc comment). `el` itself is included in the search start (an
 * item-scope field is never itself a list container it needs to escape). */
export function findOutermostList(el: Element): OutermostList | null {
  let current: Element | null = el;
  let found: OutermostList | null = null;
  while (current !== null) {
    const container: Element | null = current.closest("[data-wx-list]");
    if (container === null) break;
    const key = container.getAttribute("data-wx-list");
    if (key !== null) found = { container, key };
    current = container.parentElement;
  }
  return found;
}
