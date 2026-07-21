import { describe, expect, it } from "vitest";
import { demoteHtmlToMarkdown, renderMarkdownInline } from "../src/markdownText";
import fixtureRaw from "../../builder/tests/fixtures/markdown-inline.json?raw";

// THE parity lock (Inv 20): the same fixture JSON `builder/tests/
// test_markdown_inline.py` runs against the Python half. Any drift between
// `builder/markdown_inline.py` and `editor/src/markdownText.ts` fails one
// side's suite with the same case names. Read via vite's `?raw` (vitest
// resolves it; the file lives outside this package's rootDir).
const cases = JSON.parse(fixtureRaw) as Array<{
  name: string;
  source: string;
  expected: string;
}>;

describe("renderMarkdownInline (shared fixture parity with builder/markdown_inline.py)", () => {
  for (const c of cases) {
    it(c.name, () => {
      expect(renderMarkdownInline(c.source)).toBe(c.expected);
    });
  }

  it("output is idempotent over already-rendered allowlist html", () => {
    const once = renderMarkdownInline("**bold** and *italic* with [a](/x.html)");
    expect(renderMarkdownInline(once)).toBe(once);
  });
});

function parse(html: string): Element {
  const template = document.createElement("template");
  template.innerHTML = html.trim();
  const el = template.content.firstElementChild;
  if (el === null) throw new Error("no element parsed");
  return el;
}

describe("demoteHtmlToMarkdown", () => {
  it("plain text round-trips", () => {
    expect(demoteHtmlToMarkdown(parse(`<p>Hello world</p>`))).toBe("Hello world");
  });

  it("strong/em/br/a demote to their markdown forms", () => {
    expect(
      demoteHtmlToMarkdown(
        parse(`<p><strong>bold</strong> and <em>italic</em><br><a href="/x.html">link</a></p>`),
      ),
    ).toBe("**bold** and *italic*\n[link](/x.html)");
  });

  it("text is decoded for the user (entities become real chars)", () => {
    expect(demoteHtmlToMarkdown(parse(`<p>R&amp;D &amp; co</p>`))).toBe("R&D & co");
  });

  it("spans keep their verbatim tag form (render half re-protects them)", () => {
    expect(
      demoteHtmlToMarkdown(parse(`<p>a <span class="js-book">book</span> b</p>`)),
    ).toBe('a <span class="js-book">book</span> b');
  });

  it("round-trip: demote(render(x)) is content-stable", () => {
    const source = "**bold** and *italic*\nwith [a link](/x.html) & more";
    const rendered = renderMarkdownInline(source);
    const demoted = demoteHtmlToMarkdown(parse(`<p>${rendered}</p>`));
    expect(renderMarkdownInline(demoted)).toBe(rendered);
  });
});
