// Per-binding-kind editing popovers (spec/05 §2). Kept as plain DOM construction (no
// framework) — each builder returns a detached element the caller positions and
// mounts; callbacks fire on commit/cancel, the caller owns emitting the resulting op.
//
// TEXT bindings no longer get a popover at all: they open the bottom-anchored
// composer (composer.ts, decisions/00075) — a chat-style sheet with a growing
// textarea, formatting row and maximize mode, which superseded both the plain
// input/textarea popover and the rich-lite contenteditable one (deleted here
// with it; the wrapSelection Range helpers died too — markdown markers replaced
// them). Link and image/background bindings keep the popovers below.

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
  // Flip above the anchor when the element wouldn't fit below it — a bottom-
  // edge item's toolbar/popover must never land outside the viewport (found
  // via the E2E 4 reorder click missing the move-up button by 27px,
  // decisions/00076). offsetHeight is 0 in jsdom, so tests keep the
  // below-anchor behavior there.
  const below = rect.bottom + 4;
  const height = el.offsetHeight;
  const top = below + height > window.innerHeight ? Math.max(0, rect.top - height - 4) : below;
  el.style.top = `${Math.round(top)}px`;
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
