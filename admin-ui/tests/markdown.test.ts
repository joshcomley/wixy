import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/markdown";

describe("renderMarkdown", () => {
  it("renders a plain paragraph", () => {
    const el = renderMarkdown("hello world");
    expect(el.querySelectorAll("p")).toHaveLength(1);
    expect(el.querySelector("p")?.textContent).toBe("hello world");
  });

  it("never uses innerHTML with message content -- a literal tag is inert text", () => {
    const el = renderMarkdown("<img src=x onerror=alert(1)>");
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("renders bold text", () => {
    const el = renderMarkdown("this is **bold** text");
    const strong = el.querySelector("strong");
    expect(strong?.textContent).toBe("bold");
  });

  it("renders italic text with both * and _ delimiters", () => {
    const el1 = renderMarkdown("this is *italic*");
    expect(el1.querySelector("em")?.textContent).toBe("italic");
    const el2 = renderMarkdown("this is _also italic_");
    expect(el2.querySelector("em")?.textContent).toBe("also italic");
  });

  it("renders inline code", () => {
    const el = renderMarkdown("run `python -m builder validate`");
    expect(el.querySelector("code")?.textContent).toBe("python -m builder validate");
  });

  it("renders an http(s) link with safe attributes", () => {
    const el = renderMarkdown("see [the docs](https://example.com/docs)");
    const a = el.querySelector("a");
    expect(a?.textContent).toBe("the docs");
    expect(a?.getAttribute("href")).toBe("https://example.com/docs");
    expect(a?.getAttribute("target")).toBe("_blank");
    expect(a?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("refuses a non-http(s) link scheme -- no href is set", () => {
    const el = renderMarkdown("[click me](javascript:alert(1))");
    const a = el.querySelector("a");
    expect(a?.textContent).toBe("click me");
    expect(a?.hasAttribute("href")).toBe(false);
  });

  it("renders a fenced code block with a language tag", () => {
    const el = renderMarkdown("```python\nprint('hi')\n```");
    const pre = el.querySelector("pre.wx-markdown-code");
    const code = pre?.querySelector("code");
    expect(code?.textContent).toBe("print('hi')");
    expect(code?.dataset["lang"]).toBe("python");
  });

  it("renders a fenced code block with no language and multiple lines", () => {
    const el = renderMarkdown("```\nline one\nline two\n```");
    const code = el.querySelector("code");
    expect(code?.textContent).toBe("line one\nline two");
    expect(code?.dataset["lang"]).toBeUndefined();
  });

  it("does not interpret markdown syntax inside a fenced code block", () => {
    const el = renderMarkdown("```\n**not bold** `not code`\n```");
    const code = el.querySelector("code");
    expect(code?.textContent).toBe("**not bold** `not code`");
    expect(code?.querySelector("strong")).toBeNull();
  });

  it("renders an unordered list", () => {
    const el = renderMarkdown("- first\n- second\n- third");
    const ul = el.querySelector("ul.wx-markdown-list");
    const items = ul?.querySelectorAll("li");
    expect(items).toHaveLength(3);
    expect(items?.[0]?.textContent).toBe("first");
    expect(items?.[2]?.textContent).toBe("third");
  });

  it("renders an ordered list", () => {
    const el = renderMarkdown("1. first\n2. second");
    const ol = el.querySelector("ol.wx-markdown-list");
    expect(ol?.querySelectorAll("li")).toHaveLength(2);
  });

  it("renders headings, demoted below the shell's own h1-h3", () => {
    const el1 = renderMarkdown("# Top level");
    expect(el1.querySelector("h4")?.textContent).toBe("Top level");
    const el3 = renderMarkdown("### Third level");
    expect(el3.querySelector("h6")?.textContent).toBe("Third level");
  });

  it("renders multiple paragraphs separated by a blank line", () => {
    const el = renderMarkdown("first paragraph\n\nsecond paragraph");
    const paragraphs = el.querySelectorAll("p");
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]?.textContent).toBe("first paragraph");
    expect(paragraphs[1]?.textContent).toBe("second paragraph");
  });

  it("joins consecutive lines within one paragraph with a line break", () => {
    const el = renderMarkdown("line one\nline two");
    const p = el.querySelector("p");
    expect(p?.querySelectorAll("br")).toHaveLength(1);
    expect(p?.textContent).toBe("line oneline two");
  });

  it("a list interrupts a paragraph without requiring a blank line", () => {
    const el = renderMarkdown("intro text\n- item one\n- item two");
    expect(el.querySelector("p")?.textContent).toBe("intro text");
    expect(el.querySelectorAll("ul li")).toHaveLength(2);
  });
});
