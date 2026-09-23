// Plain-text linkification for message bubbles (spec/server-chat/00-brief.md
// §10 P5b) — http(s)-only, `rel="noopener noreferrer"` (paired with
// `target="_blank"`, its usual companion: a chat message link must open a new
// tab rather than navigating the admin away entirely), and XSS-safe by
// construction: every text run is a `Text` node and every link's visible
// label is `.textContent`, never `.innerHTML` with unsanitized input, so
// there is no way for message text (however hostile) to be parsed as markup.

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;

/** Trailing characters that usually belong to the SENTENCE, not the URL
 * itself (e.g. "see https://example.com." or "(https://example.com)") —
 * peeled back into plain text after the link. */
const TRAILING_PUNCTUATION_RE = /[).,!?;:'"\]]$/;

/** Appends `text`'s content into `container` as a mix of plain `Text` nodes
 * and `<a>` elements for every `http(s)://` run found. Non-URL text (which,
 * for a hostile message, may itself look like markup) is never parsed as
 * anything but literal characters. */
export function linkifyInto(container: HTMLElement, text: string, documentRef: Document = document): void {
  URL_RE.lastIndex = 0;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      container.appendChild(documentRef.createTextNode(text.slice(lastIndex, match.index)));
    }
    let url = match[0];
    let trailing = "";
    while (url.length > 0 && TRAILING_PUNCTUATION_RE.test(url)) {
      trailing = url.slice(-1) + trailing;
      url = url.slice(0, -1);
    }
    if (url.length > 0) {
      const anchor = documentRef.createElement("a");
      anchor.href = url;
      anchor.rel = "noopener noreferrer";
      anchor.target = "_blank";
      anchor.textContent = url;
      container.appendChild(anchor);
    }
    if (trailing.length > 0) {
      container.appendChild(documentRef.createTextNode(url.length > 0 ? trailing : match[0]));
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    container.appendChild(documentRef.createTextNode(text.slice(lastIndex)));
  }
}
