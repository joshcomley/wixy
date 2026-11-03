// Marks the words a search found inside the bubble it jumped to (decisions/00208), without touching
// the bubble's DOM: a playing voice note or an open menu in there must not be disturbed. Uses the
// CSS Custom Highlight API. A browser without it simply shows the bubble's own highlight instead.

const HIGHLIGHT_NAME = "wx-srv-search-match";

/** The parts of a bubble that hold words someone wrote or said. */
const TEXT_SELECTOR = ".wx-srv-bubble-text, .wx-srv-transcript";

interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

function registry(win: unknown): {
  readonly highlights: HighlightRegistry;
  readonly create: (ranges: Range[]) => unknown;
} | null {
  const scope = win as {
    CSS?: { highlights?: HighlightRegistry };
    Highlight?: new (...ranges: Range[]) => unknown;
  };
  const highlights = scope.CSS?.highlights;
  const Ctor = scope.Highlight;
  if (highlights === undefined || Ctor === undefined) return null;
  return { highlights, create: (ranges) => new Ctor(...ranges) };
}

export function clearSearchMarks(win: unknown): void {
  registry(win)?.highlights.delete(HIGHLIGHT_NAME);
}

/** Every occurrence of the matched strings in text nodes under `container`. */
export function findMarkRanges(container: Element, matched: readonly string[]): Range[] {
  const doc = container.ownerDocument;
  const ranges: Range[] = [];
  for (const block of Array.from(container.querySelectorAll(TEXT_SELECTOR))) {
    const walker = doc.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = node.nodeValue ?? "";
      for (const word of matched) {
        if (word === "") continue;
        let from = text.indexOf(word);
        while (from !== -1) {
          const range = doc.createRange();
          range.setStart(node, from);
          range.setEnd(node, from + word.length);
          ranges.push(range);
          from = text.indexOf(word, from + word.length);
        }
      }
    }
  }
  return ranges;
}

export function applySearchMarks(win: unknown, container: Element, matched: readonly string[]): void {
  const api = registry(win);
  if (api === null) return;
  api.highlights.delete(HIGHLIGHT_NAME);
  const ranges = findMarkRanges(container, matched);
  if (ranges.length > 0) api.highlights.set(HIGHLIGHT_NAME, api.create(ranges));
}
