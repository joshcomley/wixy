// Shared "old → new" diff rendering (decisions/00070): the publish review
// drawer (draft vs live) and the history panel's per-version Changes view
// (version vs its predecessor) both render the same
// `{file_key: PublishDiffEntry[]}` shape — one component, one stylesheet
// block (`.wx-diff-*` in style.css). Extracted from publishDrawer.ts, whose
// own DOM/classes are preserved exactly so its rendering is unchanged.

import type { PublishDiffEntry } from "./api";

export interface DiffGroupsOptions {
  /** Shown (as `.wx-diff-empty`) when there are no changes at all. */
  emptyText: string;
  /** Optional trailing action per change row (the history panel's Reinstate
   * button); return `null` for rows that should get none. */
  renderRowAction?: (fileKey: string, entry: PublishDiffEntry) => HTMLElement | null;
}

function isImageKind(kind: string): boolean {
  return kind === "img" || kind === "bg";
}

function renderDiffValue(kind: string, value: unknown): HTMLElement {
  if (isImageKind(kind) && value !== null && typeof value === "object") {
    const src = (value as Record<string, unknown>)["src"];
    if (typeof src === "string" && src.length > 0) {
      const img = document.createElement("img");
      img.className = "wx-diff-thumb";
      img.src = src;
      img.alt = "";
      return img;
    }
  }
  const span = document.createElement("span");
  span.className = "wx-diff-value";
  span.textContent =
    value === null || value === undefined
      ? "—"
      : typeof value === "string"
        ? value
        : kind === "list"
          ? `${Array.isArray(value) ? value.length : 0} item(s)`
          : JSON.stringify(value);
  return span;
}

function groupLabel(fileKey: string): string {
  if (fileKey === "theme") return "Theme";
  // Layman labels (decisions/00081): `_global` holds site-wide things (contact
  // details, opening hours, nav) and `index` is the home page — the raw slugs
  // meant nothing to a non-developer reviewing their changes.
  if (fileKey === "_global") return "Site-wide";
  if (fileKey === "index") return "Home";
  return fileKey;
}

export function renderDiffGroups(
  changes: Record<string, PublishDiffEntry[]>,
  options: DiffGroupsOptions,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "wx-diff-groups";
  const groupKeys = Object.keys(changes).sort();
  if (groupKeys.length === 0) {
    const empty = document.createElement("p");
    empty.className = "wx-diff-empty";
    empty.textContent = options.emptyText;
    wrap.appendChild(empty);
    return wrap;
  }
  for (const groupKey of groupKeys) {
    const group = document.createElement("div");
    group.className = "wx-diff-group";
    const title = document.createElement("h4");
    title.textContent = groupLabel(groupKey);
    group.appendChild(title);
    for (const entry of changes[groupKey] ?? []) {
      const row = document.createElement("div");
      row.className = "wx-diff-row";
      const key = document.createElement("span");
      key.className = "wx-diff-key";
      key.textContent = entry.key;
      const arrow = document.createElement("span");
      arrow.className = "wx-diff-arrow";
      arrow.textContent = "→";
      row.append(
        key,
        renderDiffValue(entry.kind, entry.old),
        arrow,
        renderDiffValue(entry.kind, entry.new),
      );
      const action = options.renderRowAction?.(groupKey, entry) ?? null;
      if (action !== null) row.appendChild(action);
      group.appendChild(row);
    }
    wrap.appendChild(group);
  }
  return wrap;
}
