// Shared "old → new" diff rendering (decisions/00070): the publish review
// drawer (draft vs live) and the history panel's per-version Changes view
// (version vs its predecessor) both render the same
// `{file_key: PublishDiffEntry[]}` shape — one component, one stylesheet
// block (`.wx-diff-*` in style.css). Extracted from publishDrawer.ts, whose
// own DOM/classes are preserved exactly so its rendering is unchanged.
//
// List entries (whole-array ops — opening hours, footer links, treatment
// cards) render as per-item human lines rather than a raw JSON dump or an
// uninformative "7 item(s)" count (decisions/00081): aligned by index, each
// changed item shows its identity label (day/title/label/name, else its first
// string value) and the fields that changed — "Wednesday: value: By phone
// enquiry → Closed" — with added/removed items summarised on one line each.

import type { PublishDiffEntry } from "./api";

export interface DiffGroupsOptions {
  /** Shown (as `.wx-diff-empty`) when there are no changes at all. */
  emptyText: string;
  /** Optional trailing action per change row (the history panel's Reinstate
   * button); return `null` for rows that should get none. */
  renderRowAction?: (fileKey: string, entry: PublishDiffEntry) => HTMLElement | null;
}

/** Beyond this many changed-item lines a list row truncates to "…and N more"
 * (a 7-day hours edit is typical; a 60-card gallery reorder shouldn't bury
 * the rest of the review). */
const MAX_LIST_LINES = 10;

/** Keys that usually NAME an item (checked first for the per-item label, in
 * order) before falling back to the item's first string value. */
const IDENTITY_KEYS = ["day", "title", "label", "name", "heading"];

const MAX_SCALAR_CHARS = 80;

function isImageKind(kind: string): boolean {
  return kind === "img" || kind === "bg";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") {
    return value.length > MAX_SCALAR_CHARS ? `${value.slice(0, MAX_SCALAR_CHARS - 1)}…` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const json = JSON.stringify(value);
  return json.length > MAX_SCALAR_CHARS ? `${json.slice(0, MAX_SCALAR_CHARS - 1)}…` : json;
}

/** The per-item label ("Wednesday", "Privacy") — identity-ish keys first,
 * then the item's first non-empty string, then its first primitive, then a
 * positional fallback. */
function itemLabel(item: unknown, index: number): string {
  if (isRecord(item)) {
    for (const key of IDENTITY_KEYS) {
      const value = item[key];
      if (typeof value === "string" && value.trim() !== "") return value;
    }
    for (const value of Object.values(item)) {
      if (typeof value === "string" && value.trim() !== "") return value;
    }
    for (const value of Object.values(item)) {
      if (typeof value === "number" || typeof value === "boolean") return String(value);
    }
    return `Item ${index + 1}`;
  }
  return formatScalar(item);
}

/** The one-line summary for an added/removed item: its string values in key
 * order ("Monday, 10:00 – 19:00"), falling back to primitives/JSON. */
function summarizeItem(item: unknown): string {
  if (isRecord(item)) {
    const strings = Object.values(item).filter(
      (v): v is string => typeof v === "string" && v.trim() !== "",
    );
    if (strings.length > 0) return strings.slice(0, 3).join(", ");
    const primitives = Object.values(item)
      .filter((v) => typeof v === "number" || typeof v === "boolean")
      .map(String);
    if (primitives.length > 0) return primitives.slice(0, 3).join(", ");
    return "entry";
  }
  return formatScalar(item);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Field-level change lines for one aligned item pair ("value: Closed → By
 * phone enquiry"); empty when the items are equal. */
function diffItemFields(oldItem: unknown, newItem: unknown): string[] {
  if (isRecord(oldItem) && isRecord(newItem)) {
    const keys = [...new Set([...Object.keys(oldItem), ...Object.keys(newItem)])].sort();
    const lines: string[] = [];
    for (const key of keys) {
      const oldValue = oldItem[key];
      const newValue = newItem[key];
      if (deepEqual(oldValue, newValue)) continue;
      lines.push(`${key}: ${formatScalar(oldValue)} → ${formatScalar(newValue)}`);
    }
    return lines;
  }
  return deepEqual(oldItem, newItem) ? [] : [`${formatScalar(oldItem)} → ${formatScalar(newItem)}`];
}

/** The per-item change lines for a whole-array op, aligned by index. */
function diffLists(oldValue: unknown[], newValue: unknown[]): Array<{ label: string; detail: string }> {
  const changes: Array<{ label: string; detail: string }> = [];
  const length = Math.max(oldValue.length, newValue.length);
  for (let i = 0; i < length; i += 1) {
    const oldItem: unknown = i < oldValue.length ? oldValue[i] : undefined;
    const newItem: unknown = i < newValue.length ? newValue[i] : undefined;
    if (oldItem === undefined) {
      changes.push({ label: itemLabel(newItem, i), detail: `Added: ${summarizeItem(newItem)}` });
    } else if (newItem === undefined) {
      changes.push({ label: itemLabel(oldItem, i), detail: `Removed: ${summarizeItem(oldItem)}` });
    } else {
      for (const line of diffItemFields(oldItem, newItem)) {
        changes.push({ label: itemLabel(newItem, i), detail: line });
      }
    }
  }
  return changes;
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

/** A whole-array op's row: the key as a subheading, then one line per changed
 * item (capped). Only used when each side is an array or null (null = the key
 * didn't exist on that side → every item reads Added/Removed) — anything else
 * keeps the plain old → new row (the "N item(s)" summary still covers the
 * array side there). */
function renderListRow(
  key: string,
  oldValue: unknown[] | null,
  newValue: unknown[] | null,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "wx-diff-row wx-diff-row-list";
  const keyEl = document.createElement("span");
  keyEl.className = "wx-diff-key";
  keyEl.textContent = key;
  row.appendChild(keyEl);

  const lines = diffLists(oldValue ?? [], newValue ?? []);
  const holder = document.createElement("div");
  holder.className = "wx-diff-list-lines";
  if (lines.length === 0) {
    const line = document.createElement("div");
    line.className = "wx-diff-list-line";
    line.textContent = "No visible change";
    holder.appendChild(line);
  }
  for (const change of lines.slice(0, MAX_LIST_LINES)) {
    const line = document.createElement("div");
    line.className = "wx-diff-list-line";
    const label = document.createElement("span");
    label.className = "wx-diff-list-label";
    label.textContent = `${change.label}: `;
    line.append(label, document.createTextNode(change.detail));
    holder.appendChild(line);
  }
  if (lines.length > MAX_LIST_LINES) {
    const more = document.createElement("div");
    more.className = "wx-diff-list-line wx-diff-list-more";
    more.textContent = `…and ${lines.length - MAX_LIST_LINES} more`;
    holder.appendChild(more);
  }
  row.appendChild(holder);
  return row;
}

function groupLabel(fileKey: string): string {
  if (fileKey === "theme") return "Theme";
  if (fileKey === "_global") return "Global";
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
      if (
        entry.kind === "list" &&
        (entry.old === null || Array.isArray(entry.old)) &&
        (entry.new === null || Array.isArray(entry.new)) &&
        (entry.old !== null || entry.new !== null)
      ) {
        const listRow = renderListRow(entry.key, entry.old, entry.new);
        const action = options.renderRowAction?.(groupKey, entry) ?? null;
        if (action !== null) listRow.appendChild(action);
        group.appendChild(listRow);
        continue;
      }
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
