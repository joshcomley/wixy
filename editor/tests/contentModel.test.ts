import { describe, expect, it } from "vitest";
import type { BindingField } from "../src/protocol";
import { readItemValue, readListValue } from "../src/contentModel";

function parse(html: string): Element {
  const template = document.createElement("template");
  template.innerHTML = html.trim();
  const el = template.content.firstElementChild;
  if (el === null) throw new Error("no element parsed");
  return el;
}

describe("readListValue / readItemValue", () => {
  // Mirrors builder/tests/fixtures/mini-site/pages/index.html's showcase.items,
  // AFTER rendering (i.e. items are real siblings, each still carrying
  // data-wx-list-item per builder/bindings.py's _expand_list, which never strips it).
  const showcaseField: BindingField = {
    key: "showcase.items",
    kind: "list",
    items: [
      { key: ".img", kind: "img" },
      { key: ".title", kind: "text" },
      { key: ".book", kind: "if" },
      { key: ".tags", kind: "list", items: [{ key: ".label", kind: "text" }] },
    ],
  };

  it("reconstructs a whole array from rendered list-item siblings", () => {
    const container = parse(`
      <ul data-wx-list="showcase.items">
        <li data-wx-list-item>
          <img data-wx-img=".img" src="images/icon.jpg" alt="Item one">
          <h3 data-wx=".title">Item One</h3>
          <ul data-wx-list=".tags">
            <li data-wx-list-item data-wx=".label">Popular</li>
            <li data-wx-list-item data-wx=".label">New</li>
          </ul>
        </li>
        <li data-wx-list-item>
          <img data-wx-img=".img" src="images/icon.jpg" alt="Item two">
          <h3 data-wx=".title">Item Two</h3>
          <ul data-wx-list=".tags"></ul>
        </li>
      </ul>
    `);

    const result = readListValue(container, showcaseField);

    expect(result).toEqual([
      {
        img: { src: "images/icon.jpg", alt: "Item one" },
        title: "Item One",
        tags: [{ label: "Popular" }, { label: "New" }],
      },
      {
        img: { src: "images/icon.jpg", alt: "Item two" },
        title: "Item Two",
        tags: [],
      },
    ]);
  });

  it("reconstructs data-wx-if as a plain boolean from data-wx-hidden presence", () => {
    const container = parse(`
      <ul data-wx-list="showcase.items">
        <li data-wx-list-item>
          <span data-wx-if=".book">visible, so book is truthy</span>
        </li>
        <li data-wx-list-item>
          <span data-wx-if=".book" data-wx-hidden="1">hidden, so book is falsy</span>
        </li>
      </ul>
    `);
    const field: BindingField = {
      key: "showcase.items",
      kind: "list",
      items: [{ key: ".book", kind: "if" }],
    };

    const result = readListValue(container, field);

    expect(result).toEqual([{ book: true }, { book: false }]);
  });

  it("reads href values via getAttribute, not the resolved absolute URL", () => {
    const container = parse(`
      <ul data-wx-list="items">
        <li data-wx-list-item><a data-wx-href=".bookHref" href="/about.html#one">Book</a></li>
      </ul>
    `);
    const field: BindingField = {
      key: "items",
      kind: "list",
      items: [{ key: ".bookHref", kind: "href" }],
    };

    expect(readListValue(container, field)).toEqual([{ bookHref: "/about.html#one" }]);
  });

  it("reads bg src from the inline background-image style, alt defaults empty", () => {
    const container = parse(`
      <ul data-wx-list="items">
        <li data-wx-list-item><div data-wx-bg=".bg" style="background-image:url(images/hero.jpg)"></div></li>
      </ul>
    `);
    const field: BindingField = {
      key: "items",
      kind: "list",
      items: [{ key: ".bg", kind: "bg" }],
    };

    expect(readListValue(container, field)).toEqual([{ bg: { src: "images/hero.jpg", alt: "" } }]);
  });

  it("readItemValue omits a field whose element is missing from this item", () => {
    const el = parse(`<li><h3 data-wx=".title">Only title</h3></li>`);
    const result = readItemValue(el, [
      { key: ".title", kind: "text" },
      { key: ".subtitle", kind: "text" },
    ]);
    expect(result).toEqual({ title: "Only title" });
  });

  it("excludes injected eye-toggle chrome (markup AND label text) from text values", () => {
    // The 2026-07-21 production incident (decisions/00073): boot injects a
    // .wx-if-eye-toggle button into every [data-wx-if] element — including spans
    // that are ALSO text-bound (the ca hours/price templates) — and a whole-array
    // read then committed the button's markup and its 👁️ label into the draft.
    const container = parse(`
      <ul data-wx-list="@hours">
        <li data-wx-list-item>
          <span data-wx=".day">Monday</span>
          <span class="closed" data-wx-if=".closed" data-wx=".value" data-wx-hidden="1"><button type="button" class="wx-if-eye-toggle" aria-label="Show hidden section">👁️</button>10:00 – 19:00</span>
          <span data-wx-if="!.closed" data-wx=".value"><button type="button" class="wx-if-eye-toggle" aria-label="Show hidden section">👁️</button>10:00 – 19:00</span>
        </li>
      </ul>
    `);
    const field: BindingField = {
      key: "@hours",
      kind: "list",
      items: [
        { key: ".day", kind: "text" },
        { key: ".value", kind: "text" },
        { key: ".closed", kind: "if" },
      ],
    };

    expect(readListValue(container, field)).toEqual([
      { day: "Monday", value: "10:00 – 19:00", closed: false },
    ]);
  });
});
