import { describe, expect, it } from "vitest";
import type { AdminField, AdminFieldOption } from "../src/api";
import {
  appendItem,
  blankItem,
  cloneItems,
  decodeCommonEntities,
  deleteItemAt,
  dottedGet,
  fieldDirty,
  imageFieldValue,
  isNewItemComplete,
  itemDirty,
  itemsAt,
  itemsEqual,
  jsonValueEqual,
  moveItemDown,
  moveItemTo,
  moveItemUp,
  removeItemField,
  textFieldValue,
  updateItemField,
  type SectionItem,
} from "../src/sectionPanelModel";

const BEFORE_FIELD: AdminField = {
  key: "before",
  kind: "image",
  label: "Before photo",
  options: [],
  optionsFrom: null,
  required: false,
};
const AFTER_FIELD: AdminField = {
  key: "after",
  kind: "image",
  label: "After photo",
  options: [],
  optionsFrom: null,
  required: false,
};
const TITLE_FIELD: AdminField = {
  key: "title",
  kind: "text",
  label: "Treatment name",
  options: [],
  optionsFrom: null,
  required: true,
};
const SUB_FIELD: AdminField = {
  key: "sub",
  kind: "text",
  label: "Treatment type",
  options: [],
  optionsFrom: null,
  required: false,
};
const CAT_FIELD: AdminField = {
  key: "cat",
  kind: "choice",
  label: "Category",
  options: [
    { value: "lips", label: "Lips" },
    { value: "cheeks", label: "Cheeks" },
  ],
  optionsFrom: null,
  required: false,
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

describe("jsonValueEqual", () => {
  it("is true for identical primitives and false across types", () => {
    expect(jsonValueEqual("a", "a")).toBe(true);
    expect(jsonValueEqual(1, 1)).toBe(true);
    expect(jsonValueEqual(true, true)).toBe(true);
    expect(jsonValueEqual(null, null)).toBe(true);
    expect(jsonValueEqual("1", 1)).toBe(false);
    expect(jsonValueEqual(null, false)).toBe(false);
  });

  it("compares objects by key/value, independent of key order", () => {
    expect(jsonValueEqual({ src: "a.jpg", alt: "A" }, { alt: "A", src: "a.jpg" })).toBe(true);
  });

  it("is false when a key's value differs or a key is missing on either side", () => {
    expect(jsonValueEqual({ src: "a.jpg" }, { src: "b.jpg" })).toBe(false);
    expect(jsonValueEqual({ src: "a.jpg" }, { src: "a.jpg", alt: "A" })).toBe(false);
  });

  it("compares arrays element-wise, order-sensitive, length-sensitive", () => {
    expect(jsonValueEqual([1, 2], [1, 2])).toBe(true);
    expect(jsonValueEqual([1, 2], [2, 1])).toBe(false);
    expect(jsonValueEqual([1, 2], [1, 2, 3])).toBe(false);
  });

  it("recurses through nested objects/arrays (an item's own shape)", () => {
    const a = item({ before: { src: "b.jpg", alt: "Before" } });
    const b = item({ before: { src: "b.jpg", alt: "Before" } });
    const c = item({ before: { src: "b.jpg", alt: "Different" } });
    expect(jsonValueEqual(a, b)).toBe(true);
    expect(jsonValueEqual(a, c)).toBe(false);
  });
});

describe("itemsEqual", () => {
  it("is true for two value-identical arrays even with fresh object references", () => {
    expect(itemsEqual([item()], [item()])).toBe(true);
  });

  it("is false when lengths differ", () => {
    expect(itemsEqual([item()], [item(), item()])).toBe(false);
  });

  it("is false when any item at the same index differs", () => {
    expect(itemsEqual([item({ title: "A" })], [item({ title: "B" })])).toBe(false);
  });
});

describe("cloneItems", () => {
  it("produces a value-equal but reference-distinct copy", () => {
    const original = [item()];
    const copy = cloneItems(original);
    expect(copy).toEqual(original);
    expect(copy).not.toBe(original);
    expect(copy[0]).not.toBe(original[0]);
  });

  it("a later mutation of the source array never affects the clone (savedState safety)", () => {
    const original = [item({ title: "A" })];
    const copy = cloneItems(original);
    original[0] = { ...(original[0] as SectionItem), title: "Changed" };
    expect(copy[0]?.["title"]).toBe("A");
  });
});

describe("itemDirty", () => {
  const saved = [item({ title: "A" }), item({ title: "B" })];

  it("is false when the item at that index is value-identical to saved", () => {
    expect(itemDirty([item({ title: "A" }), item({ title: "B" })], saved, 0)).toBe(false);
  });

  it("is true when the item at that index differs from saved", () => {
    expect(itemDirty([item({ title: "Edited" }), item({ title: "B" })], saved, 0)).toBe(true);
  });

  it("is true for an index past the end of saved (a newly staged item)", () => {
    expect(itemDirty([...saved, item({ title: "New" })], saved, 2)).toBe(true);
  });

  it("is false for an index past the end of current (removed since save — the collection-level check owns that signal)", () => {
    expect(itemDirty([item({ title: "A" })], saved, 1)).toBe(false);
  });
});

describe("fieldDirty", () => {
  const saved = [item({ title: "A", sub: "Lip filler" })];

  it("is false when the field's value is unchanged", () => {
    expect(fieldDirty([item({ title: "A", sub: "Lip filler" })], saved, 0, "title")).toBe(false);
  });

  it("is true when the field's value differs", () => {
    expect(fieldDirty([item({ title: "A2", sub: "Lip filler" })], saved, 0, "title")).toBe(true);
  });

  it("does not flag a field OTHER than the one that changed", () => {
    expect(fieldDirty([item({ title: "A2", sub: "Lip filler" })], saved, 0, "sub")).toBe(false);
  });

  it("treats a missing key on either side as null (no false-dirty for absent optional fields)", () => {
    expect(fieldDirty([{ title: "A" }], [{ title: "A" }], 0, "visible")).toBe(false);
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

  it("preserves an unrelated unknown key (e.g. visible) untouched", () => {
    const items = [item({ title: "A", visible: false })];
    const result = updateItemField(items, 0, "sub", "New sub");
    expect(result[0]?.["visible"]).toBe(false);
    expect(result[0]?.["sub"]).toBe("New sub");
  });
});

describe("removeItemField", () => {
  it("drops the key entirely from the targeted item", () => {
    const items = [item({ title: "A", visible: false })];
    const result = removeItemField(items, 0, "visible");
    expect("visible" in (result[0] ?? {})).toBe(false);
  });

  it("leaves other items and other keys on the same item untouched", () => {
    const items = [item({ title: "A", visible: false }), item({ title: "B", visible: false })];
    const result = removeItemField(items, 0, "visible");
    expect(result[0]?.["title"]).toBe("A");
    expect("visible" in (result[0] ?? {})).toBe(false);
    expect(result[1]?.["visible"]).toBe(false);
  });

  it("is a no-op when the key is already absent", () => {
    const items = [item({ title: "A" })];
    const result = removeItemField(items, 0, "visible");
    expect(result[0]).toEqual(items[0]);
  });

  it("never mutates the input array or item", () => {
    const original = item({ title: "A", visible: false });
    const items = [original];
    removeItemField(items, 0, "visible");
    expect(original["visible"]).toBe(false);
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
      { key: "img", kind: "image" as const, label: "Photo", options: [], optionsFrom: null, required: false },
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

  it("an optionsFrom choice field defaults to the resolver's FIRST option, not blank (decisions/00124)", () => {
    const dynamicCatField: AdminField = {
      key: "cat",
      kind: "choice",
      label: "Category",
      options: [], // deliberately empty -- optionsFrom fields carry no static options
      optionsFrom: "gallery.categories",
      required: false,
    };
    const resolveOptions = (): AdminFieldOption[] => [
      { value: "chin", label: "Chin & Jaw" },
      { value: "lips", label: "Lips" },
    ];

    expect(blankItem([dynamicCatField], resolveOptions)["cat"]).toBe("chin");
  });

  it("an optionsFrom choice field falls back to empty string when the resolver has nothing yet", () => {
    const dynamicCatField: AdminField = {
      key: "cat",
      kind: "choice",
      label: "Category",
      options: [],
      optionsFrom: "gallery.categories",
      required: false,
    };

    expect(blankItem([dynamicCatField], () => [])["cat"]).toBe("");
  });

  it("without a resolver argument, falls back to the field's static options (unchanged default behavior)", () => {
    expect(blankItem(SLIDER_FIELDS)["cat"]).toBe("lips");
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
