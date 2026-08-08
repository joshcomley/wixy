import { describe, expect, it } from "vitest";
import type { BindingField } from "../src/protocol";
import { parseAttrSpec, readItemValue, readListValue } from "../src/contentModel";

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

  // decisions/00095: the 2026-07-28 gallery publish-corruption incident's two root
  // causes — an attr-kind item field silently dropped on every whole-array read
  // (root cause A), and the "blank new item" DOM placeholder becoming real stored
  // text on a subsequent read (root cause B).
  describe("attr-kind item fields (root cause A)", () => {
    const field: BindingField = {
      key: "items",
      kind: "list",
      items: [
        { key: ".title", kind: "text" },
        { key: ".cat", kind: "attr", attr: "data-cat" },
      ],
    };

    it("round-trips an attr binding declared on the list-item root itself", () => {
      // The exact real-site shape: <figure data-wx-list-item data-wx-attr="data-cat:.cat">.
      const container = parse(`
        <div data-wx-list="items">
          <figure data-wx-list-item data-wx-attr="data-cat:.cat" data-cat="lips">
            <span data-wx=".title">Lip Enhancement</span>
          </figure>
        </div>
      `);
      expect(readListValue(container, field)).toEqual([
        { title: "Lip Enhancement", cat: "lips" },
      ]);
    });

    it("finds an attr binding declared on a descendant of the item root", () => {
      const container = parse(`
        <div data-wx-list="items">
          <li data-wx-list-item>
            <span data-wx=".title">Item</span>
            <i data-wx-attr="data-cat:.cat" data-cat="cheeks"></i>
          </li>
        </div>
      `);
      expect(readListValue(container, field)).toEqual([{ title: "Item", cat: "cheeks" }]);
    });

    it("reads a missing attribute as an empty string, not a dropped key", () => {
      // The spec is declared but the builder never set the attribute (shouldn't
      // happen in real rendered output, but the read must stay total, not throw).
      const container = parse(`
        <div data-wx-list="items">
          <li data-wx-list-item data-wx-attr="data-cat:.cat">
            <span data-wx=".title">Item</span>
          </li>
        </div>
      `);
      expect(readListValue(container, field)).toEqual([{ title: "Item", cat: "" }]);
    });

    it("resolves the right pair out of a multi-pair data-wx-attr spec", () => {
      const multiField: BindingField = {
        key: "items",
        kind: "list",
        items: [
          { key: ".x", kind: "attr", attr: "data-a" },
          { key: ".y", kind: "attr", attr: "data-b" },
        ],
      };
      const container = parse(`
        <div data-wx-list="items">
          <li data-wx-list-item data-wx-attr="data-a:.x,data-b:.y" data-a="one" data-b="two"></li>
        </div>
      `);
      expect(readListValue(container, multiField)).toEqual([{ x: "one", y: "two" }]);
    });
  });

  describe("nbsp placeholder normalization (root cause B)", () => {
    const field: BindingField = {
      key: "items",
      kind: "list",
      items: [{ key: ".title", kind: "text" }, { key: ".sub", kind: "text" }],
    };

    it("reads a never-filled-in nbsp placeholder as an empty string", () => {
      // blankTextLikeFields writes innerHTML = "&nbsp;" (a real U+00A0 char after
      // the browser parses it), not the empty string, so a click target remains.
      const container = parse(`
        <div data-wx-list="items">
          <li data-wx-list-item>
            <h3 data-wx=".title">&nbsp;</h3>
            <p data-wx=".sub">&nbsp;</p>
          </li>
        </div>
      `);
      expect(readListValue(container, field)).toEqual([{ title: "", sub: "" }]);
    });

    it("treats the literal entity text the same as the decoded character", () => {
      // Belt-and-braces: a value that already round-tripped through the server's
      // nh3 sanitize pass (which re-serializes a bare NBSP as this literal text)
      // must not be mistaken for real content either.
      const el = parse(`<h3 data-wx="title">&amp;nbsp;</h3>`);
      expect(readItemValue(el, [{ key: "title", kind: "text" }])).toEqual({ title: "" });
    });

    it("does not touch real text merely containing whitespace", () => {
      const el = parse(`<h3 data-wx="title">  Lip Enhancement  </h3>`);
      const { title } = readItemValue(el, [{ key: "title", kind: "text" }]) as { title: string };
      expect(title.trim()).toBe("Lip Enhancement");
    });
  });

  it("regression: a reconstructed gallery-slider-shaped item satisfies its required keys", () => {
    // The exact shape builder/schemas/gallery-slider.schema.json requires
    // (cat/title/sub/before/after) — a whole-array read of an untouched,
    // fully-rendered item must never drop any of them.
    const sliderField: BindingField = {
      key: "gallery.sliders",
      kind: "list",
      items: [
        { key: ".cat", kind: "attr", attr: "data-cat" },
        { key: ".title", kind: "text" },
        { key: ".sub", kind: "text" },
        { key: ".before", kind: "img" },
        { key: ".after", kind: "img" },
      ],
    };
    const container = parse(`
      <div data-wx-list="gallery.sliders">
        <figure data-wx-list-item data-wx-attr="data-cat:.cat" data-cat="lips">
          <img data-wx-img=".after" src="images/ba-lips-1-after.jpg" alt="Lip Enhancement — after">
          <img data-wx-img=".before" src="images/ba-lips-1-before.jpg" alt="Lip Enhancement — before">
          <figcaption><span data-wx=".title">Lip Enhancement</span><span data-wx=".sub">Dermal filler</span></figcaption>
        </figure>
      </div>
    `);
    const [item] = readListValue(container, sliderField);
    expect(Object.keys(item as Record<string, unknown>).sort()).toEqual(
      ["after", "before", "cat", "sub", "title"].sort(),
    );
    expect(item).toEqual({
      cat: "lips",
      title: "Lip Enhancement",
      sub: "Dermal filler",
      before: { src: "images/ba-lips-1-before.jpg", alt: "Lip Enhancement — before" },
      after: { src: "images/ba-lips-1-after.jpg", alt: "Lip Enhancement — after" },
    });
  });

  it("a hidden item (marked data-wx-item-hidden) round-trips visible: false; an unmarked item carries no key at all", () => {
    // Preview-mode marker for `visible: false` (builder/bindings.py's
    // ATTR_ITEM_HIDDEN) — without this, every whole-array read-back would
    // silently un-hide the item, the same incident class as decisions/00095's
    // `.cat` attr-drop above.
    const field: BindingField = {
      key: "items",
      kind: "list",
      items: [{ key: ".title", kind: "text" }],
    };
    const container = parse(`
      <ul data-wx-list="items">
        <li data-wx-list-item data-wx-item-hidden="1"><span data-wx=".title">Hidden one</span></li>
        <li data-wx-list-item><span data-wx=".title">Shown one</span></li>
      </ul>
    `);

    const result = readListValue(container, field);

    expect(result).toEqual([{ title: "Hidden one", visible: false }, { title: "Shown one" }]);
    expect(Object.keys(result[0] as Record<string, unknown>).sort()).toEqual(["title", "visible"]);
    expect(Object.keys(result[1] as Record<string, unknown>).sort()).toEqual(["title"]);
  });
});

describe("parseAttrSpec", () => {
  it("parses a single attr:key pair", () => {
    expect(parseAttrSpec("data-cat:.cat")).toEqual([{ attrName: "data-cat", key: ".cat" }]);
  });

  it("parses multiple comma-separated pairs", () => {
    expect(parseAttrSpec("data-a:.x,data-b:.y")).toEqual([
      { attrName: "data-a", key: ".x" },
      { attrName: "data-b", key: ".y" },
    ]);
  });

  it("trims whitespace around each part", () => {
    expect(parseAttrSpec(" data-cat : .cat , data-b : .y ")).toEqual([
      { attrName: "data-cat", key: ".cat" },
      { attrName: "data-b", key: ".y" },
    ]);
  });

  it("splits only on the FIRST colon (a key may itself contain one)", () => {
    expect(parseAttrSpec("data-x:@a:b")).toEqual([{ attrName: "data-x", key: "@a:b" }]);
  });

  it("yields null for a pair with no colon — mirrors builder.bindings.parse_attr_spec", () => {
    expect(parseAttrSpec("no-colon-here,ok:realKey")).toEqual([
      null,
      { attrName: "ok", key: "realKey" },
    ]);
  });
});
