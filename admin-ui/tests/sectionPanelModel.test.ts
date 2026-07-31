import { describe, expect, it } from "vitest";
import type { AdminField } from "../src/api";
import {
  appendItem,
  blankItem,
  decodeCommonEntities,
  deleteItemAt,
  dottedGet,
  imageFieldValue,
  isNewItemComplete,
  itemsAt,
  moveItemDown,
  moveItemTo,
  moveItemUp,
  textFieldValue,
  updateItemField,
  type SectionItem,
} from "../src/sectionPanelModel";

const BEFORE_FIELD: AdminField = { key: "before", kind: "image", label: "Before photo", options: [] };
const AFTER_FIELD: AdminField = { key: "after", kind: "image", label: "After photo", options: [] };
const TITLE_FIELD: AdminField = { key: "title", kind: "text", label: "Treatment name", options: [] };
const SUB_FIELD: AdminField = { key: "sub", kind: "text", label: "Treatment type", options: [] };
const CAT_FIELD: AdminField = {
  key: "cat",
  kind: "choice",
  label: "Category",
  options: [
    { value: "lips", label: "Lips" },
    { value: "cheeks", label: "Cheeks" },
  ],
};
const SLIDER_FIELDS: AdminField[] = [BEFORE_FIELD, AFTER_FIELD, TITLE_FIELD, SUB_FIELD, CAT_FIELD];

function item(overrides: Partial<SectionItem> = {}): SectionItem {
  return {
    before: { src: "images/b.jpg", alt: "Before" },
    after: { src: "images/a.jpg", alt: "After" },
    title: "Filler",
    sub: "Lip filler",
    cat: "lips",
    ...overrides,
  };
}

describe("dottedGet", () => {
  it("reads a nested path", () => {
    expect(dottedGet({ gallery: { sliders: [1, 2] } }, "gallery.sliders")).toEqual([1, 2]);
  });

  it("returns undefined for a missing top-level key", () => {
    expect(dottedGet({}, "gallery.sliders")).toBeUndefined();
  });

  it("returns undefined when a middle segment is not an object", () => {
    expect(dottedGet({ gallery: "not an object" }, "gallery.sliders")).toBeUndefined();
  });

  it("returns undefined when a middle segment is an array", () => {
    expect(dottedGet({ gallery: [1, 2] }, "gallery.sliders")).toBeUndefined();
  });
});

describe("itemsAt", () => {
  it("returns the array at the path", () => {
    const content = { gallery: { sliders: [item()] } };
    expect(itemsAt(content, "gallery.sliders")).toEqual([item()]);
  });

  it("returns an empty array when the path is missing entirely", () => {
    expect(itemsAt({}, "gallery.sliders")).toEqual([]);
  });

  it("returns an empty array when the value at the path isn't an array", () => {
    expect(itemsAt({ gallery: { sliders: "oops" } }, "gallery.sliders")).toEqual([]);
  });

  it("drops non-object entries rather than crashing on a malformed draft", () => {
    const content = { gallery: { sliders: [item(), "garbage", 42, null, [1, 2]] } };
    expect(itemsAt(content, "gallery.sliders")).toEqual([item()]);
  });
});

describe("moveItemUp / moveItemDown / moveItemTo", () => {
  const items = [item({ title: "A" }), item({ title: "B" }), item({ title: "C" })];

  it("moves an item up one position", () => {
    const result = moveItemUp(items, 1);
    expect(result.map((i) => i["title"])).toEqual(["B", "A", "C"]);
  });

  it("moves an item down one position", () => {
    const result = moveItemDown(items, 1);
    expect(result.map((i) => i["title"])).toEqual(["A", "C", "B"]);
  });

  it("moving the first item up is a no-op (clamped, not an error)", () => {
    const result = moveItemUp(items, 0);
    expect(result.map((i) => i["title"])).toEqual(["A", "B", "C"]);
  });

  it("moving the last item down is a no-op (clamped, not an error)", () => {
    const result = moveItemDown(items, 2);
    expect(result.map((i) => i["title"])).toEqual(["A", "B", "C"]);
  });

  it("moveItemTo jumps an item directly to an arbitrary later index", () => {
    const result = moveItemTo(items, 0, 2);
    expect(result.map((i) => i["title"])).toEqual(["B", "C", "A"]);
  });

  it("moveItemTo jumps an item directly to an arbitrary earlier index", () => {
    const result = moveItemTo(items, 2, 0);
    expect(result.map((i) => i["title"])).toEqual(["C", "A", "B"]);
  });

  it("moveItemTo clamps an out-of-range target index instead of throwing", () => {
    const result = moveItemTo(items, 0, 99);
    expect(result.map((i) => i["title"])).toEqual(["B", "C", "A"]);
  });

  it("moveItemTo with an out-of-range source index returns the array unchanged", () => {
    expect(moveItemTo(items, 99, 0)).toBe(items);
  });

  it("never mutates the input array", () => {
    const original = [item({ title: "A" }), item({ title: "B" })];
    const copy = [...original];
    moveItemUp(original, 1);
    expect(original).toEqual(copy);
  });
});

describe("deleteItemAt", () => {
  it("removes exactly the item at the given index", () => {
    const items = [item({ title: "A" }), item({ title: "B" }), item({ title: "C" })];
    expect(deleteItemAt(items, 1).map((i) => i["title"])).toEqual(["A", "C"]);
  });
});

describe("updateItemField", () => {
  it("replaces one field on one item, leaving the rest untouched", () => {
    const items = [item({ title: "A" }), item({ title: "B" })];
    const result = updateItemField(items, 1, "title", "B2");
    expect(result[0]).toEqual(items[0]);
    expect(result[1]?.["title"]).toBe("B2");
  });
});

describe("appendItem", () => {
  it("adds the item to the end", () => {
    const items = [item({ title: "A" })];
    const result = appendItem(items, item({ title: "B" }));
    expect(result.map((i) => i["title"])).toEqual(["A", "B"]);
  });
});

describe("imageFieldValue", () => {
  it("reads a well-formed picked image", () => {
    expect(imageFieldValue(item(), "before")).toEqual({ src: "images/b.jpg", alt: "Before" });
  });

  it("is null for a field that was never set", () => {
    expect(imageFieldValue({}, "before")).toBeNull();
  });

  it("is null for a blank-src object", () => {
    expect(imageFieldValue({ before: { src: "  ", alt: "x" } }, "before")).toBeNull();
  });

  it("is null for a malformed (non-object) value rather than throwing", () => {
    expect(imageFieldValue({ before: "oops" }, "before")).toBeNull();
  });

  it("defaults alt to empty string when missing", () => {
    expect(imageFieldValue({ before: { src: "x.jpg" } }, "before")).toEqual({ src: "x.jpg", alt: "" });
  });
});

describe("textFieldValue", () => {
  it("reads a string field", () => {
    expect(textFieldValue(item(), "title")).toBe("Filler");
  });

  it("defaults to empty string for a missing or non-string field", () => {
    expect(textFieldValue({}, "title")).toBe("");
    expect(textFieldValue({ title: 5 }, "title")).toBe("");
  });
});

describe("isNewItemComplete (the guided-add Save gate)", () => {
  it("is true once every image field and the title field are filled", () => {
    expect(isNewItemComplete(SLIDER_FIELDS, item())).toBe(true);
  });

  it("is false when an image field is unset", () => {
    expect(isNewItemComplete(SLIDER_FIELDS, item({ before: undefined }))).toBe(false);
  });

  it("is false when title is blank", () => {
    expect(isNewItemComplete(SLIDER_FIELDS, item({ title: "" }))).toBe(false);
    expect(isNewItemComplete(SLIDER_FIELDS, item({ title: "   " }))).toBe(false);
  });

  it("does not block on a blank sub or cat -- only title and images are required", () => {
    expect(isNewItemComplete(SLIDER_FIELDS, item({ sub: "" }))).toBe(true);
  });

  it("a single-image collection (tiles-shaped) only requires that one image + title", () => {
    const tileFields = [
      { key: "img", kind: "image" as const, label: "Photo", options: [] },
      TITLE_FIELD,
      CAT_FIELD,
    ];
    expect(isNewItemComplete(tileFields, { img: { src: "x.jpg", alt: "" }, title: "Cheek filler" })).toBe(
      true,
    );
    expect(isNewItemComplete(tileFields, { title: "Cheek filler" })).toBe(false);
  });
});

describe("blankItem", () => {
  it("pre-fills choice fields with the first option's value", () => {
    expect(blankItem(SLIDER_FIELDS)["cat"]).toBe("lips");
  });

  it("pre-fills text fields with an empty string", () => {
    expect(blankItem(SLIDER_FIELDS)["title"]).toBe("");
    expect(blankItem(SLIDER_FIELDS)["sub"]).toBe("");
  });

  it("gives image fields no key at all until a photo is picked", () => {
    const blank = blankItem(SLIDER_FIELDS);
    expect("before" in blank).toBe(false);
    expect("after" in blank).toBe(false);
  });

  it("a fresh blank item is never already complete", () => {
    expect(isNewItemComplete(SLIDER_FIELDS, blankItem(SLIDER_FIELDS))).toBe(false);
  });
});

describe("decodeCommonEntities", () => {
  it("decodes a plain ampersand entity", () => {
    expect(decodeCommonEntities("Mummy &amp; Me")).toBe("Mummy & Me");
  });

  it("decodes the other standard XML/HTML entities", () => {
    expect(decodeCommonEntities("&lt;tag&gt; &quot;quoted&quot; &apos;s&apos;")).toBe(
      `<tag> "quoted" 's'`,
    );
  });

  it("leaves plain text with no entities untouched", () => {
    expect(decodeCommonEntities("Just a normal title")).toBe("Just a normal title");
  });

  it("leaves an unrecognized ampersand sequence untouched rather than guessing", () => {
    expect(decodeCommonEntities("Tom & Jerry")).toBe("Tom & Jerry");
    expect(decodeCommonEntities("A&Bcorp;")).toBe("A&Bcorp;");
  });
});
