// Markdown-inline rendering for text bindings (decisions/00075) — the EDITOR
// half of a hand-synced pair with `builder/markdown_inline.py` (Inv 20): both
// must produce byte-identical output, enforced by both suites loading
// `builder/tests/fixtures/markdown-inline.json`. Read that Python module's
// docstring for the subset definition; the algorithm below mirrors it step for
// step (protect legacy allowlist tags → escape text → links → bold → italic →
// newlines → restore).
//
// Also home to `demoteHtmlToMarkdown`, the inverse used to SEED the composer
// from a rendered element (build lanes never need it — the stored source IS
// markdown). Demote is editor-only by design and has its own tests.

const TAG_RE = /<\/?(?:strong|em|br|span|a)(?:\s[^<>]*?)?\/?>/g;
const BARE_AMP_RE = /&(?!(?:#\d+|#x[0-9a-fA-F]+|\w+);)/g;
const LINK_RE = /\[([^\]]+)\]\(([^)\s"]+)\)/g;
const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
const ALLOWED_SCHEMES = new Set(["http", "https", "mailto", "tel"]);
const BOLD_RE = /\*\*([^*]+)\*\*/g;
const ITALIC_RE = /\*([^*]+)\*/g;

// Placeholder delimiters — byte-identical to the Python half (written as
// escapes: literal PUA chars don't survive every editing tool).
const OPEN = "";
const CLOSE = "";

function escapeText(text: string): string {
  return text
    .replace(BARE_AMP_RE, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function renderMarkdownInline(source: string): string {
  let text = source.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");

  const protectedTags: string[] = [];
  text = text.replace(TAG_RE, (tag) => {
    protectedTags.push(tag);
    return `${OPEN}${protectedTags.length - 1}${CLOSE}`;
  });

  text = escapeText(text);

  text = text.replace(LINK_RE, (whole, label: string, url: string) => {
    const scheme = SCHEME_RE.exec(url);
    if (scheme !== null && !ALLOWED_SCHEMES.has((scheme[1] ?? "").toLowerCase())) {
      return whole; // unsafe scheme — render the source literally
    }
    // nh3's default link_rel adds rel="noopener noreferrer" to every <a> at
    // sanitize time; emitting it here keeps the preview byte-identical to the
    // build's output for markdown-authored links.
    return `<a href="${url}" rel="noopener noreferrer">${label}</a>`;
  });
  text = text.replace(BOLD_RE, "<strong>$1</strong>");
  text = text.replace(ITALIC_RE, "<em>$1</em>");

  text = text.replace(/\n/g, "<br>");
  protectedTags.forEach((tag, index) => {
    text = text.replace(`${OPEN}${index}${CLOSE}`, tag);
  });
  return text;
}

// ---------------------------------------------------------------------------
// Demote (rendered HTML -> markdown source) — composer seeding
// ---------------------------------------------------------------------------

/** Serialize an attribute-bearing allowlist tag verbatim (span/a with attrs we
 * don't demote are kept as literal HTML — the render half protects them on the
 * way back in, so round-trips are stable). */
function outerTagOnly(el: Element, closing: boolean): string {
  if (closing) return `</${el.tagName.toLowerCase()}>`;
  const attrs = Array.from(el.attributes)
    .map((attr) => `${attr.name}="${attr.value.replace(/"/g, "&quot;")}"`)
    .join(" ");
  return attrs === "" ? `<${el.tagName.toLowerCase()}>` : `<${el.tagName.toLowerCase()} ${attrs}>`;
}

function demoteChildren(el: Element, out: string[]): void {
  el.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      // Decoded text (the user sees real `&`, not `&amp;`) — the render half's
      // escape step re-encodes on commit, so storage stays canonical.
      out.push(node.nodeValue ?? "");
      return;
    }
    if (!(node instanceof Element)) return;
    const tag = node.tagName.toLowerCase();
    if (tag === "strong") {
      out.push("**");
      demoteChildren(node, out);
      out.push("**");
      return;
    }
    if (tag === "em") {
      out.push("*");
      demoteChildren(node, out);
      out.push("*");
      return;
    }
    if (tag === "br") {
      out.push("\n");
      return;
    }
    if (tag === "a") {
      const href = node.getAttribute("href") ?? "";
      out.push("[");
      demoteChildren(node, out);
      out.push(`](${href})`);
      return;
    }
    // span (and any unexpected-but-harmless tag): keep verbatim, recurse inside.
    out.push(outerTagOnly(node, false));
    demoteChildren(node, out);
    out.push(outerTagOnly(node, true));
  });
}

/** Rendered element HTML -> markdown source for the composer's textarea. The
 * caller passes a chrome-stripped CLONE (contentModel.chromeFreeElement —
 * chrome never reaches a seed, Inv 23). */
export function demoteHtmlToMarkdown(el: Element): string {
  const out: string[] = [];
  demoteChildren(el, out);
  return out.join("");
}
