import { describe, expect, it } from "vitest";
import type { JsonValue } from "../src/protocol";
import { applyListStructuralOp } from "../src/listOps";

describe("applyListStructuralOp", () => {
  const items: JsonValue[] = [
    { title: "One", book: true, tags: ["a", "b"] },
    { title: "Two", book: false, tags: [] },
  ];

  it("add appends a blank-ish clone of the first item, strings blanked", () => {
    const result = applyListStructuralOp(items, { kind: "add" });
    expect(result).toHaveLength(3);
    expect(result[2]).toEqual({ title: "", book: true, tags: ["", ""] });
    // originals untouched
    expect(result[0]).toEqual(items[0]);
  });

  it("add on an empty list produces an empty object, not a crash", () => {
    expect(applyListStructuralOp([], { kind: "add" })).toEqual([{}]);
  });

  it("add strips a hidden item[0]'s visible key -- a new item is always born shown", () => {
    const hiddenFirst: JsonValue[] = [{ title: "One", visible: false }, { title: "Two" }];
    const result = applyListStructuralOp(hiddenFirst, { kind: "add" });
    expect(result).toHaveLength(3);
    expect(result[2]).toEqual({ title: "" });
    expect("visible" in (result[2] as Record<string, unknown>)).toBe(false);
    // the source item's own visible: false is untouched
    expect(result[0]).toEqual({ title: "One", visible: false });
  });

  it("duplicate inserts a deep copy right after the source item", () => {
    const result = applyListStructuralOp(items, { kind: "duplicate", index: 0 });
    expect(result).toHaveLength(3);
    expect(result[1]).toEqual(items[0]);
    expect(result[1]).not.toBe(items[0]); // must be a real copy, not the same reference
    expect(result[2]).toEqual(items[1]);
  });

  it("duplicate KEEPS a hidden source item's visible: false -- the copy stays hidden too", () => {
    const hidden: JsonValue[] = [{ title: "One", visible: false }];
    const result = applyListStructuralOp(hidden, { kind: "duplicate", index: 0 });
    expect(result).toEqual([
      { title: "One", visible: false },
      { title: "One", visible: false },
    ]);
  });

  it("moveUp swaps with the previous item", () => {
    const result = applyListStructuralOp(items, { kind: "moveUp", index: 1 });
    expect(result.map((i) => (i as { title: string }).title)).toEqual(["Two", "One"]);
  });

  it("moveUp on index 0 is a no-op", () => {
    const result = applyListStructuralOp(items, { kind: "moveUp", index: 0 });
    expect(result).toEqual(items);
  });

  it("moveDown swaps with the next item", () => {
    const result = applyListStructuralOp(items, { kind: "moveDown", index: 0 });
    expect(result.map((i) => (i as { title: string }).title)).toEqual(["Two", "One"]);
  });

  it("moveDown on the last index is a no-op", () => {
    const result = applyListStructuralOp(items, { kind: "moveDown", index: 1 });
    expect(result).toEqual(items);
  });

  it("delete removes exactly the item at the given index", () => {
    const result = applyListStructuralOp(items, { kind: "delete", index: 0 });
    expect(result).toEqual([items[1]]);
  });

  it("never mutates the input array", () => {
    const original = JSON.parse(JSON.stringify(items));
    applyListStructuralOp(items, { kind: "add" });
    applyListStructuralOp(items, { kind: "delete", index: 0 });
    applyListStructuralOp(items, { kind: "moveUp", index: 1 });
    expect(items).toEqual(original);
  });
});
