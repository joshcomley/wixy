// Per-binding-kind editing popovers (spec/05 §2). Kept as plain DOM construction (no
// framework) — each builder returns a detached element the caller positions and
// mounts; callbacks fire on commit/cancel, the caller owns emitting the resulting op.
//
// Rich-lite's mini-toolbar is hand-rolled over the Selection/Range API rather than
// `document.execCommand` — jsdom (this package's test environment) doesn't implement
// `execCommand` at all, and a small, deterministic wrap/unwrap over Range is easier to
// get right for the narrow 02 §5 allowlist (`strong`/`em`/`a`/`span`/`br`) than relying
// on a deprecated, browser-inconsistent command API anyway.

const POPOVER_CLASS = "wx-popover";

export interface PopoverCallbacks {
  onCancel: () => void;
}

function baseContainer(): HTMLDivElement {
  const el = document.createElement("div");
  el.className = POPOVER_CLASS;
  el.style.position = "fixed";
  el.style.zIndex = "2147483647";
  return el;
}

export function positionNear(el: HTMLElement, anchor: Element): void {
  const rect = anchor.getBoundingClientRect();
  el.style.left = `${Math.round(rect.left)}px`;
  el.style.top = `${Math.round(rect.bottom + 4)}px`;
}

function commitOnEnterCancelOnEsc(
  input: HTMLInputElement | HTMLTextAreaElement,
  onCommit: () => void,
  onCancel: () => void,
): void {
  input.addEventListener("keydown", (rawEvent: Event) => {
    const event = rawEvent as KeyboardEvent;
    if (event.key === "Enter" && !(input instanceof HTMLTextAreaElement && event.shiftKey)) {
      event.preventDefault();
      onCommit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  });
}

// ---------------------------------------------------------------------------
// Text — plain mode
// ---------------------------------------------------------------------------

export interface TextPopoverCallbacks extends PopoverCallbacks {
  onCommit: (value: string) => void;
}

/** Plain mode (spec/05 §2): "single input or autosizing textarea; Enter commits, Esc
 * cancels." A textarea is used once the current text is long or already
 * multi-line — a single-line input covers the common heading/label/price case. */
export function buildPlainTextPopover(
  currentText: string,
  callbacks: TextPopoverCallbacks,
): HTMLElement {
  const container = baseContainer();
  const useTextarea = currentText.length > 60 || currentText.includes("\n");
  const input = document.createElement(useTextarea ? "textarea" : "input");
  input.value = currentText;
  container.appendChild(input);
  commitOnEnterCancelOnEsc(input, () => callbacks.onCommit(input.value), callbacks.onCancel);
  queueMicrotask(() => input.focus());
  return container;
}

// ---------------------------------------------------------------------------
// Text — rich-lite mode
// ---------------------------------------------------------------------------

export interface RichLitePopoverCallbacks extends PopoverCallbacks {
  onCommit: (html: string) => void;
}

/** Pasted content becomes plain text only (spec/05 §2) — the wrap helpers below only
 * ever create `strong`/`em`/`a` elements themselves, matching the 02 §5 allowlist by
 * construction; the server's `sanitize_rich_lite` remains the authoritative enforcer
 * (02 §5: "enforced server-side on every draft write with a proper sanitizer"), this
 * is just never generating anything that would need stripping in the first place. */
function plainTextFromClipboard(event: ClipboardEvent): string {
  return event.clipboardData?.getData("text/plain") ?? "";
}

function wrapSelection(root: HTMLElement, tagName: "strong" | "em"): void {
  const selection = root.ownerDocument.getSelection();
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return;
  const wrapper = root.ownerDocument.createElement(tagName);
  wrapper.appendChild(range.extractContents());
  range.insertNode(wrapper);
  selection.removeAllRanges();
}

function wrapSelectionAsLink(root: HTMLElement, href: string): void {
  const selection = root.ownerDocument.getSelection();
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return;
  const anchor = root.ownerDocument.createElement("a");
  anchor.href = href;
  anchor.rel = "noopener noreferrer";
  anchor.appendChild(range.extractContents());
  range.insertNode(anchor);
  selection.removeAllRanges();
}

/** Rich-lite mode (spec/05 §2): "contenteditable clone of the element styled as-is,
 * mini-toolbar B / I / link / ↵ only." Building the actual "styled as-is" visual
 * clone (matching the live element's computed styles exactly) is left to slice 3's
 * real wiring/manual verification — this builds the functional contenteditable +
 * toolbar; a caller applies whatever positioning/styling context it has. */
export function buildRichLiteTextPopover(
  currentHtml: string,
  callbacks: RichLitePopoverCallbacks,
): HTMLElement {
  const container = baseContainer();

  const toolbar = document.createElement("div");
  toolbar.className = "wx-popover-toolbar";
  const boldBtn = document.createElement("button");
  boldBtn.type = "button";
  boldBtn.textContent = "B";
  const italicBtn = document.createElement("button");
  italicBtn.type = "button";
  italicBtn.textContent = "I";
  const linkBtn = document.createElement("button");
  linkBtn.type = "button";
  linkBtn.textContent = "Link";
  toolbar.append(boldBtn, italicBtn, linkBtn);

  const editable = document.createElement("div");
  // Set the attribute directly rather than the `contentEditable` IDL property — more
  // portable, and (found by testing) not every DOM implementation reflects the
  // property setter back onto the attribute the same way a real browser does.
  editable.setAttribute("contenteditable", "true");
  editable.innerHTML = currentHtml;
  editable.addEventListener("paste", (event) => {
    event.preventDefault();
    document.getSelection()?.getRangeAt(0)?.insertNode(document.createTextNode(plainTextFromClipboard(event)));
  });
  editable.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      callbacks.onCommit(editable.innerHTML);
    } else if (event.key === "Escape") {
      event.preventDefault();
      callbacks.onCancel();
    }
  });

  boldBtn.addEventListener("click", () => wrapSelection(editable, "strong"));
  italicBtn.addEventListener("click", () => wrapSelection(editable, "em"));

  const hrefRow = document.createElement("div");
  hrefRow.className = "wx-popover-href-row";
  hrefRow.hidden = true;
  const hrefInput = document.createElement("input");
  hrefInput.placeholder = "https://…";
  const hrefApply = document.createElement("button");
  hrefApply.type = "button";
  hrefApply.textContent = "Apply";
  hrefApply.addEventListener("click", () => {
    wrapSelectionAsLink(editable, hrefInput.value);
    hrefRow.hidden = true;
  });
  hrefRow.append(hrefInput, hrefApply);
  linkBtn.addEventListener("click", () => {
    hrefRow.hidden = false;
    queueMicrotask(() => hrefInput.focus());
  });

  container.append(toolbar, editable, hrefRow);
  queueMicrotask(() => editable.focus());
  return container;
}

// ---------------------------------------------------------------------------
// Link
// ---------------------------------------------------------------------------

export interface LinkPopoverCallbacks extends PopoverCallbacks {
  onCommitHref: (href: string) => void;
  onCommitLabel?: (label: string) => void;
}

/** spec/05 §2: "popover with label (if the same element is also `data-wx`) + href
 * field with page-picker (internal pages listed) / raw URL / tel: / mailto:." The
 * page-picker dropdown needs a page list the overlay doesn't have (the protocol has
 * no message carrying one, spec/05 §2's five shell->overlay messages are exhaustive)
 * — deferred; this ships the raw-URL input, which covers URL/tel:/mailto: already. */
export function buildLinkPopover(
  currentHref: string,
  currentLabel: string | null,
  callbacks: LinkPopoverCallbacks,
): HTMLElement {
  const container = baseContainer();

  if (currentLabel !== null && callbacks.onCommitLabel) {
    const labelInput = document.createElement("input");
    labelInput.value = currentLabel;
    labelInput.placeholder = "Link text";
    const onCommitLabel = callbacks.onCommitLabel;
    commitOnEnterCancelOnEsc(
      labelInput,
      () => onCommitLabel(labelInput.value),
      callbacks.onCancel,
    );
    container.appendChild(labelInput);
  }

  const hrefInput = document.createElement("input");
  hrefInput.value = currentHref;
  hrefInput.placeholder = "https://… / tel:… / mailto:…";
  commitOnEnterCancelOnEsc(
    hrefInput,
    () => callbacks.onCommitHref(hrefInput.value),
    callbacks.onCancel,
  );
  container.appendChild(hrefInput);
  queueMicrotask(() => hrefInput.focus());
  return container;
}

// ---------------------------------------------------------------------------
// Image / background
// ---------------------------------------------------------------------------

export interface ImagePopoverCallbacks extends PopoverCallbacks {
  onReplace: () => void;
  onCommitAlt: (alt: string) => void;
}

/** spec/05 §2: "'Replace image' button + alt input; Replace opens the shell's media
 * dialog." Opening the actual dialog and answering with `applyOps` is the shell's job
 * (spec/05 §4, milestone 8's media panel) — this only emits `mediaRequest` and lets
 * the caller wire the alt-text commit. The direct-file-drop target is a nice-to-have
 * left for when the media dialog itself exists to receive the drop. */
export function buildImagePopover(
  currentAlt: string,
  callbacks: ImagePopoverCallbacks,
): HTMLElement {
  const container = baseContainer();

  const replaceBtn = document.createElement("button");
  replaceBtn.type = "button";
  replaceBtn.textContent = "Replace image";
  replaceBtn.addEventListener("click", callbacks.onReplace);

  const altInput = document.createElement("input");
  altInput.value = currentAlt;
  altInput.placeholder = "Alt text";
  commitOnEnterCancelOnEsc(
    altInput,
    () => callbacks.onCommitAlt(altInput.value),
    callbacks.onCancel,
  );

  container.append(replaceBtn, altInput);
  return container;
}
