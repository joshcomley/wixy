// Pure array-transform logic for the list item toolbar (spec/05 §2: "hovering an item
// shows an item toolbar (↑ ↓ ✚ duplicate, ✖ delete, ⠿ drag handle); ✚ appends a
// blank-ish item cloned from the first item's shape (02 §6)"). No DOM here at all —
// `contentModel.ts` reads the starting array out of the DOM, this module computes the
// new array, and the caller emits it as one whole-array `op`.

import type { JsonValue } from "./protocol";

export type ListStructuralOp =
  | { kind: "add" }
  | { kind: "duplicate"; index: number }
  | { kind: "moveUp"; index: number }
  | { kind: "moveDown"; index: number }
  | { kind: "delete"; index: number };

/** "Text fields blanked" (spec/02 §6), applied structurally rather than by binding
 * kind: every STRING leaf (recursively, through nested objects/arrays) becomes `""`;
 * every other JSON type (booleans, numbers, array length/shape) is copied verbatim
 * from the source item. This needs no bindings-map lookup — a plain structural walk
 * of the value itself — and produces a reasonable "unset" placeholder for every kind
 * (an empty `src`/`alt` renders as a broken-image placeholder until the owner picks a
 * real one, which is expected for a just-added draft item). */
function blankStrings(value: JsonValue): JsonValue {
  if (typeof value === "string") return "";
  if (Array.isArray(value)) return value.map(blankStrings);
  if (value !== null && typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = blankStrings(v);
    }
    return out;
  }
  return value; // number, boolean, null
}

export function applyListStructuralOp(
  items: readonly JsonValue[],
  op: ListStructuralOp,
): JsonValue[] {
  switch (op.kind) {
    case "add": {
      const first = items[0];
      return [...items, first !== undefined ? blankStrings(first) : {}];
    }
    case "duplicate": {
      const source = items[op.index];
      if (source === undefined) return [...items];
      const copy = [...items];
      copy.splice(op.index + 1, 0, structuredCloneJson(source));
      return copy;
    }
    case "moveUp": {
      if (op.index <= 0 || op.index >= items.length) return [...items];
      return swap(items, op.index, op.index - 1);
    }
    case "moveDown":
      return applyListStructuralOp(items, { kind: "moveUp", index: op.index + 1 });
    case "delete":
      return items.filter((_, i) => i !== op.index);
  }
}

function swap(items: readonly JsonValue[], a: number, b: number): JsonValue[] {
  const copy = [...items];
  const itemA = copy[a] as JsonValue;
  const itemB = copy[b] as JsonValue;
  copy[a] = itemB;
  copy[b] = itemA;
  return copy;
}

function structuredCloneJson(value: JsonValue): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
