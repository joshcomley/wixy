import { describe, expect, it } from "vitest";
import { directOpTarget, findOutermostList, isItemScopeKey } from "../src/opTargeting";

function parse(html: string): Element {
  const template = document.createElement("template");
  template.innerHTML = html.trim();
  const el = template.content.firstElementChild;
  if (el === null) throw new Error("no element parsed");
  return el;
}

describe("directOpTarget", () => {
  it("targets the current page for a page-scope key", () => {
    expect(directOpTarget("hero.title", "index")).toEqual({ file: "index", path: "hero.title" });
  });

  it("targets _global for an @-prefixed key, stripping the prefix", () => {
    expect(directOpTarget("@brand.line1", "index")).toEqual({
      file: "_global",
      path: "brand.line1",
    });
  });
});

describe("isItemScopeKey", () => {
  it("is true for a dot-prefixed key", () => {
    expect(isItemScopeKey(".title")).toBe(true);
  });

  it("is false for page-scope and global-scope keys", () => {
    expect(isItemScopeKey("hero.title")).toBe(false);
    expect(isItemScopeKey("@brand.line1")).toBe(false);
  });
});

describe("findOutermostList", () => {
  it("finds the single enclosing list for a direct item field", () => {
    const root = parse(`
      <ul data-wx-list="showcase.items">
        <li data-wx-list-item><h3 data-wx=".title">Item</h3></li>
      </ul>
    `);
    const titleEl = root.querySelector('[data-wx=".title"]');
    if (titleEl === null) throw new Error("test setup broken");

    expect(findOutermostList(titleEl)).toEqual({
      container: root,
      key: "showcase.items",
    });
  });

  it("returns the OUTER list, not the nested one, for a field inside a nested list item", () => {
    const root = parse(`
      <ul data-wx-list="showcase.items">
        <li data-wx-list-item>
          <ul data-wx-list=".tags">
            <li data-wx-list-item data-wx=".label">Popular</li>
          </ul>
        </li>
      </ul>
    `);
    const labelEl = root.querySelector('[data-wx=".label"]');
    if (labelEl === null) throw new Error("test setup broken");

    const result = findOutermostList(labelEl);
    expect(result?.key).toBe("showcase.items");
    expect(result?.container).toBe(root);
  });

  it("returns null when there is no enclosing list at all", () => {
    const el = parse(`<h1 data-wx="hero.title">Title</h1>`);
    expect(findOutermostList(el)).toBeNull();
  });
});
