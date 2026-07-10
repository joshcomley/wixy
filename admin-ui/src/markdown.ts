// A minimal, hand-rolled markdown-to-DOM renderer (spec/05-editor.md §6: "markdown
// rendering incl. fenced code") for the chat panel's message bubbles.
//
// Deliberately NOT a third-party markdown library: admin-ui has zero runtime npm
// dependencies today, and this repo generally prefers a small hand-rolled parser
// over a new dependency for a well-scoped subset (see builder/theme.py,
// builder/jsonschema_lite.py on the Python side). Deliberately NEVER uses
// innerHTML with message content — every node is built via
// document.createElement/textContent, so untrusted text can never be interpreted
// as markup no matter what it contains.
//
// Supported: paragraphs, headings, fenced code blocks, unordered/ordered lists,
// inline code, bold, italic, links (http(s) only). Not a full CommonMark
// implementation, and does not support nested emphasis (e.g. bold containing
// italic) — covers what a chat assistant's replies actually use, not the full
// spec.

const INLINE_PATTERN =
  /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|\[[^\]\n]+\]\([^)\n]+\))/;

function appendInline(parent: HTMLElement, text: string): void {
  for (const part of text.split(INLINE_PATTERN)) {
    if (part === "") continue;
    if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
      const code = document.createElement("code");
      code.textContent = part.slice(1, -1);
      parent.appendChild(code);
      continue;
    }
    if (
      (part.startsWith("**") && part.endsWith("**") && part.length >= 4) ||
      (part.startsWith("__") && part.endsWith("__") && part.length >= 4)
    ) {
      const strong = document.createElement("strong");
      appendInline(strong, part.slice(2, -2));
      parent.appendChild(strong);
      continue;
    }
    if (
      (part.startsWith("*") && part.endsWith("*") && part.length >= 2) ||
      (part.startsWith("_") && part.endsWith("_") && part.length >= 2)
    ) {
      const em = document.createElement("em");
      appendInline(em, part.slice(1, -1));
      parent.appendChild(em);
      continue;
    }
    if (part.startsWith("[")) {
      const match = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
      if (match) {
        const label = match[1] ?? "";
        const href = match[2] ?? "";
        const a = document.createElement("a");
        a.textContent = label;
        // Only http(s) targets become real links — never javascript:/data:/etc
        // (defense in depth; href is set as an attribute, never evaluated as
        // markup, but a malicious scheme is still worth refusing outright).
        if (/^https?:\/\//i.test(href)) {
          a.href = href;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
        }
        parent.appendChild(a);
        continue;
      }
    }
    parent.appendChild(document.createTextNode(part));
  }
}

function isFenceLine(line: string): boolean {
  return line.startsWith("```");
}

function matchOrderedItem(line: string): string | null {
  const match = /^\d+\.\s+(.*)$/.exec(line);
  return match ? (match[1] ?? "") : null;
}

function matchUnorderedItem(line: string): string | null {
  const match = /^[-*+]\s+(.*)$/.exec(line);
  return match ? (match[1] ?? "") : null;
}

function matchHeading(line: string): { level: number; text: string } | null {
  const match = /^(#{1,6})\s+(.*)$/.exec(line);
  if (!match) return null;
  return { level: (match[1] ?? "").length, text: match[2] ?? "" };
}

function isBlockStart(line: string): boolean {
  return (
    line.trim() === "" ||
    isFenceLine(line) ||
    matchHeading(line) !== null ||
    matchUnorderedItem(line) !== null ||
    matchOrderedItem(line) !== null
  );
}

/** Chat bubbles demote headings below the admin shell's own h1-h3 (visual
 * hierarchy: a message's "# Heading" shouldn't outrank real page chrome). */
function headingTag(level: number): string {
  return `h${Math.min(level + 3, 6)}`;
}

export function renderMarkdown(source: string): HTMLElement {
  const container = document.createElement("div");
  container.className = "wx-markdown";
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (line.trim() === "") {
      i++;
      continue;
    }

    if (isFenceLine(line)) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !isFenceLine(lines[i] ?? "")) {
        codeLines.push(lines[i] ?? "");
        i++;
      }
      i++; // skip the closing fence (or end of input if unterminated)
      const pre = document.createElement("pre");
      pre.className = "wx-markdown-code";
      const code = document.createElement("code");
      if (lang !== "") code.dataset["lang"] = lang;
      code.textContent = codeLines.join("\n");
      pre.appendChild(code);
      container.appendChild(pre);
      continue;
    }

    const heading = matchHeading(line);
    if (heading !== null) {
      const el = document.createElement(headingTag(heading.level));
      appendInline(el, heading.text);
      container.appendChild(el);
      i++;
      continue;
    }

    const orderedItem = matchOrderedItem(line);
    const unorderedItem = matchUnorderedItem(line);
    if (orderedItem !== null || unorderedItem !== null) {
      const ordered = orderedItem !== null;
      const list = document.createElement(ordered ? "ol" : "ul");
      list.className = "wx-markdown-list";
      while (i < lines.length) {
        const itemText = ordered ? matchOrderedItem(lines[i] ?? "") : matchUnorderedItem(lines[i] ?? "");
        if (itemText === null) break;
        const li = document.createElement("li");
        appendInline(li, itemText);
        list.appendChild(li);
        i++;
      }
      container.appendChild(list);
      continue;
    }

    const paraLines: string[] = [];
    while (i < lines.length && !isBlockStart(lines[i] ?? "")) {
      paraLines.push(lines[i] ?? "");
      i++;
    }
    const p = document.createElement("p");
    paraLines.forEach((paraLine, idx) => {
      if (idx > 0) p.appendChild(document.createElement("br"));
      appendInline(p, paraLine);
    });
    container.appendChild(p);
  }

  return container;
}
