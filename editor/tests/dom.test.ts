import { describe, expect, it } from "vitest";
import { chipLabel, closestBoundElement, detectBinding, isRichLiteContent } from "../src/dom";

function parse(html: string): Element {
  const template = document.createElement("template");
  template.innerHTML = html.trim();
  const el = template.content.firstElementChild;
  if (el === null) throw new Error("no element parsed");
  return el;
}

describe("detectBinding", () => {
  it("detects a plain text binding", () => {
    const el = parse(`<h1 data-wx="hero.title">Title</h1>`);
    expect(detectBinding(el)).toEqual({ element: el, key: "hero.title", kind: "text" });
  });

  it("detects an image binding", () => {
    const el = parse(`<img data-wx-img="hero.img">`);
    expect(detectBinding(el)?.kind).toBe("img");
  });

  it("detects a bg binding", () => {
    const el = parse(`<section data-wx-bg="hero.bg"></section>`);
    expect(detectBinding(el)?.kind).toBe("bg");
  });

  it("a list container is detected as list even when other attrs are absent", () => {
    const el = parse(`<ul data-wx-list="showcase.items"></ul>`);
    expect(detectBinding(el)).toEqual({ element: el, key: "showcase.items", kind: "list" });
  });

  it("an element with both data-wx-href and data-wx is treated as Link, not Text", () => {
    const el = parse(`<a href="#" data-wx-href="hero.ctaHref" data-wx="hero.ctaLabel">CTA</a>`);
    const detected = detectBinding(el);
    expect(detected?.kind).toBe("href");
    expect(detected?.key).toBe("hero.ctaHref");
  });

  it("returns null for an unbound element", () => {
    expect(detectBinding(parse(`<div>plain</div>`))).toBeNull();
  });
});

describe("closestBoundElement", () => {
  it("finds the nearest bound ancestor when the click lands on a nested child", () => {
    const root = parse(`<h1 data-wx="hero.title"><strong>bold</strong> text</h1>`);
    const strong = root.querySelector("strong");
    if (strong === null) throw new Error("test setup broken");
    expect(closestBoundElement(strong)?.key).toBe("hero.title");
  });

  it("returns null when nothing bound is in the ancestor chain", () => {
    const root = parse(`<div><span>plain</span></div>`);
    const span = root.querySelector("span");
    if (span === null) throw new Error("test setup broken");
    expect(closestBoundElement(span)).toBeNull();
  });
});

describe("chipLabel", () => {
  it("labels img and bg both as Image", () => {
    expect(chipLabel("img")).toBe("Image");
    expect(chipLabel("bg")).toBe("Image");
  });

  it("labels the remaining kinds distinctly", () => {
    expect(chipLabel("text")).toBe("Text");
    expect(chipLabel("href")).toBe("Link");
    expect(chipLabel("list")).toBe("List");
  });
});

describe("isRichLiteContent", () => {
  it("is false for plain text content", () => {
    expect(isRichLiteContent(parse(`<h1 data-wx="x">Plain title</h1>`))).toBe(false);
  });

  it("is true when the element has element children (e.g. an inline <strong>)", () => {
    expect(
      isRichLiteContent(parse(`<p data-wx="x">Learn <strong>more</strong> today</p>`)),
    ).toBe(true);
  });
});
