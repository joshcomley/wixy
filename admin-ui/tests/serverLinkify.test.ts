import { describe, expect, it } from "vitest";
import { linkifyInto } from "../src/server/linkify";

function render(text: string): HTMLElement {
  const container = document.createElement("div");
  linkifyInto(container, text);
  return container;
}

describe("linkifyInto", () => {
  it("plain text with no URL renders as a single text node", () => {
    const container = render("just some plain text");
    expect(container.childNodes).toHaveLength(1);
    expect(container.childNodes[0]?.nodeType).toBe(Node.TEXT_NODE);
    expect(container.textContent).toBe("just some plain text");
    expect(container.querySelector("a")).toBeNull();
  });

  it("linkifies a bare http(s) URL with the right attributes", () => {
    const container = render("see https://example.com/path?q=1 for more");
    const anchor = container.querySelector("a");
    expect(anchor).not.toBeNull();
    expect(anchor?.href).toBe("https://example.com/path?q=1");
    expect(anchor?.textContent).toBe("https://example.com/path?q=1");
    expect(anchor?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(anchor?.getAttribute("target")).toBe("_blank");
    expect(container.textContent).toBe("see https://example.com/path?q=1 for more");
  });

  it("linkifies multiple URLs in one message", () => {
    const container = render("http://a.example and https://b.example both work");
    const anchors = container.querySelectorAll("a");
    expect(anchors).toHaveLength(2);
    expect(anchors[0]?.href).toBe("http://a.example/");
    expect(anchors[1]?.href).toBe("https://b.example/");
  });

  it("peels trailing sentence punctuation off the link", () => {
    const container = render("check https://example.com/page.");
    const anchor = container.querySelector("a");
    expect(anchor?.href).toBe("https://example.com/page");
    expect(anchor?.textContent).toBe("https://example.com/page");
    expect(container.textContent).toBe("check https://example.com/page.");
  });

  it("handles a URL wrapped in parentheses", () => {
    const container = render("(https://example.com/page)");
    const anchor = container.querySelector("a");
    expect(anchor?.href).toBe("https://example.com/page");
    expect(container.textContent).toBe("(https://example.com/page)");
  });

  it("does not linkify a non-http(s) scheme", () => {
    const container = render("try javascript:alert(1) or ftp://example.com/x");
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("try javascript:alert(1) or ftp://example.com/x");
  });

  describe("XSS safety", () => {
    it("renders a <script> tag in the message as literal text, never executed markup", () => {
      const container = render('<script>window.__pwned = true</script> hello');
      expect(container.querySelector("script")).toBeNull();
      expect(container.innerHTML).not.toContain("<script>");
      expect(container.textContent).toBe('<script>window.__pwned = true</script> hello');
    });

    it("renders an inline event-handler payload as literal text", () => {
      const container = render('<img src=x onerror="window.__pwned=true">');
      expect(container.querySelector("img")).toBeNull();
      expect(container.textContent).toBe('<img src=x onerror="window.__pwned=true">');
    });

    it("a URL adjacent to HTML-looking text still only creates a safe <a>, nothing else", () => {
      const container = render('<b>bold</b> https://example.com/<script>bad</script>');
      const anchors = container.querySelectorAll("a");
      expect(anchors).toHaveLength(1);
      expect(container.querySelector("script")).toBeNull();
      expect(container.querySelector("b")).toBeNull();
      // The </script> text run after the URL renders as literal text, not markup.
      expect(container.textContent).toContain("<script>bad</script>");
    });

    it("a javascript: URL embedded in text is never turned into a clickable link", () => {
      const container = render('click javascript:alert(document.cookie) now');
      expect(container.querySelector("a")).toBeNull();
    });

    it("an https URL with an embedded quote never breaks out of the href attribute", () => {
      // The URL_RE excludes `"` and `'` from a matched URL by construction,
      // so a quote character always terminates the match rather than being
      // absorbed into `href`.
      const container = render(`https://example.com/"onmouseover="alert(1)`);
      const anchor = container.querySelector("a");
      expect(anchor?.href).toBe("https://example.com/");
      expect(anchor?.getAttribute("onmouseover")).toBeNull();
      expect(container.textContent).toBe(`https://example.com/"onmouseover="alert(1)`);
    });
  });
});
