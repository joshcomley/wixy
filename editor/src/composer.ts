// The bottom-anchored text composer (decisions/00075) — the overlay's single
// text-editing surface, replacing the inline popovers (plain + rich-lite both).
// Modelled on cmd's chat composer: a bar pinned to the bottom of the viewport
// with a functions row (B / I / link / maximize / save / cancel), an
// auto-growing textarea (capped at ~5 lines / ~20% of the viewport, whichever
// is smaller), Enter = newline with Ctrl+Enter / ✓ committing, and a maximize
// mode (~80% of the viewport) for long-form text. Live preview fires on every
// input so the page shows the markdown-rendered result as you type.
//
// Auto-grow lifecycle (decisions/00079): the composer is built DETACHED, where
// scrollHeight is always 0, so no sizing can happen inside openComposer — the
// caller MUST call refit() once the element is attached (and destroy() when
// tearing it down). fit() then re-runs on every input, on setScale (the
// counter-scale changes the width, so the text rewraps), and on window resize.

export interface ComposerCallbacks {
  /** Fired on every keystroke with the current markdown source — the caller
   * live-renders it into the target element (no op is emitted). */
  onPreview: (value: string) => void;
  onCommit: (value: string) => void;
  onCancel: () => void;
}

export interface ComposerOptions {
  /** Markdown source to seed the textarea with (demoted from the live element
   * by the caller — see markdownText.demoteHtmlToMarkdown). */
  seed: string;
  /** Whole-iframe viewport scale from the shell's device simulation (1 when
   * unscaled). The composer counter-scales so it stays legible/full-width on
   * screen when the preview itself is shrunk. */
  scale: number;
  /** Extra buttons inserted at the START of the functions row (e.g. a
   * structured-control launcher for control-bound fields). */
  leadingActions?: HTMLElement[];
  callbacks: ComposerCallbacks;
}

export interface Composer {
  element: HTMLElement;
  /** Update the counter-scale (shell changed device mid-edit). Re-fits: the
   * width changes, so the text rewraps. */
  setScale: (scale: number) => void;
  /** (Re)size the textarea to its content. MUST be called once the element is
   * attached — the composer is built detached, where scrollHeight is always 0. */
  refit: () => void;
  focus: () => void;
  /** Remove the window resize listener. Call when tearing the composer down. */
  destroy: () => void;
}

const LINE_HEIGHT_PX = 20;
const MAX_LINES = 5;
const MAX_VH_FRACTION = 0.2;

/** Wrap the textarea's current selection in `before`/`after` markers (or drop
 * the markers at the caret when nothing is selected), preserving the undo
 * stack where the platform allows it. Returns nothing; the caller re-fits. */
function wrapSelection(
  textarea: HTMLTextAreaElement,
  before: string,
  after: string,
  selectInner: { start: number; end: number } | null = null,
): void {
  const { selectionStart, selectionEnd, value } = textarea;
  const selected = value.slice(selectionStart, selectionEnd);
  const next = value.slice(0, selectionStart) + before + selected + after + value.slice(selectionEnd);
  textarea.value = next;
  if (selectInner !== null) {
    textarea.setSelectionRange(selectionStart + selectInner.start, selectionStart + selectInner.end);
  } else if (selected === "") {
    const caret = selectionStart + before.length;
    textarea.setSelectionRange(caret, caret);
  } else {
    textarea.setSelectionRange(selectionStart + before.length, selectionEnd + before.length);
  }
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function toolbarButton(label: string, ariaLabel: string, cssClass: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = cssClass;
  button.setAttribute("aria-label", ariaLabel);
  button.title = ariaLabel;
  button.textContent = label;
  return button;
}

export function openComposer(options: ComposerOptions): Composer {
  const { callbacks } = options;

  const root = document.createElement("div");
  root.className = "wx-composer";
  const inner = document.createElement("div");
  inner.className = "wx-composer-inner";
  root.appendChild(inner);

  // -- Functions row ----------------------------------------------------------
  const toolbar = document.createElement("div");
  toolbar.className = "wx-composer-toolbar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Text editing tools");

  const textarea = document.createElement("textarea");
  textarea.className = "wx-composer-input";
  textarea.rows = 1;
  textarea.value = options.seed;
  textarea.setAttribute("aria-label", "Edit text (Markdown supported)");

  const boldBtn = toolbarButton("B", "Bold", "wx-composer-fmt wx-composer-fmt-bold");
  const italicBtn = toolbarButton("I", "Italic", "wx-composer-fmt wx-composer-fmt-italic");
  const linkBtn = toolbarButton("🔗", "Insert link", "wx-composer-fmt wx-composer-fmt-link");

  boldBtn.addEventListener("click", () => {
    wrapSelection(textarea, "**", "**");
    textarea.focus();
  });
  italicBtn.addEventListener("click", () => {
    wrapSelection(textarea, "*", "*");
    textarea.focus();
  });
  linkBtn.addEventListener("click", () => {
    // [selection](https://) with the placeholder URL pre-selected so typing
    // replaces it immediately.
    const selected = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
    wrapSelection(textarea, "[", "](https://)", {
      start: 1 + selected.length + 2,
      end: 1 + selected.length + 2 + "https://".length,
    });
    textarea.focus();
  });

  const spacer = document.createElement("span");
  spacer.className = "wx-composer-spacer";

  const maxBtn = toolbarButton("⤢", "Maximize editor", "wx-composer-max-toggle");
  maxBtn.setAttribute("aria-pressed", "false");
  const commitBtn = toolbarButton("✓", "Save (Ctrl+Enter)", "wx-composer-commit");
  const cancelBtn = toolbarButton("✕", "Cancel (Esc)", "wx-composer-cancel");

  toolbar.append(boldBtn, italicBtn, linkBtn);
  for (const extra of options.leadingActions ?? []) toolbar.prepend(extra);
  toolbar.append(spacer, maxBtn, commitBtn, cancelBtn);
  inner.append(toolbar, textarea);

  // -- Auto-grow (capped) -------------------------------------------------------

  function capPx(): number {
    return Math.min(MAX_LINES * LINE_HEIGHT_PX, window.innerHeight * MAX_VH_FRACTION);
  }

  function fit(): void {
    // Detached (or already torn down): scrollHeight is 0 without a layout box,
    // so sizing here would collapse the textarea to a 0px sliver — the bug
    // behind decisions/00079. A detached composer simply keeps its natural
    // rows=1 height until the caller's post-attach refit().
    if (!root.isConnected) return;
    if (root.classList.contains("wx-composer-max")) return;
    textarea.style.height = "auto";
    const cap = capPx();
    // scrollHeight measures content+padding, but `height` under border-box
    // sets the BORDER box — add the borders back (offsetHeight - clientHeight)
    // or the last line sits permanently ~2px clipped. The overflow decision
    // uses the same `needed` figure so the two never disagree at the cap edge.
    const needed = textarea.scrollHeight + (textarea.offsetHeight - textarea.clientHeight);
    textarea.style.height = `${Math.min(needed, cap)}px`;
    textarea.style.overflowY = needed > cap ? "auto" : "hidden";
  }

  // -- Scale -------------------------------------------------------------------

  function applyScale(scale: number): void {
    const safe = scale > 0 ? scale : 1;
    root.style.transform = `scale(${1 / safe})`;
    root.style.transformOrigin = "bottom left";
    root.style.width = `${100 * safe}%`;
    // The width just changed, so the text rewraps — re-fit. A no-op while
    // detached (the constructor's own call below) via fit()'s guard.
    fit();
  }
  applyScale(options.scale);

  // -- Events -------------------------------------------------------------------

  let maximized = false;
  function setMaximized(next: boolean): void {
    maximized = next;
    root.classList.toggle("wx-composer-max", next);
    maxBtn.setAttribute("aria-pressed", String(next));
    maxBtn.textContent = next ? "⤡" : "⤢";
    maxBtn.title = next ? "Restore editor" : "Maximize editor";
    if (next) {
      textarea.style.height = "";
      textarea.style.overflowY = "auto";
    } else {
      fit();
    }
  }
  maxBtn.addEventListener("click", () => setMaximized(!maximized));

  textarea.addEventListener("input", () => {
    fit();
    callbacks.onPreview(textarea.value);
  });
  textarea.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      callbacks.onCommit(textarea.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      callbacks.onCancel();
    }
  });
  commitBtn.addEventListener("click", () => callbacks.onCommit(textarea.value));
  cancelBtn.addEventListener("click", () => callbacks.onCancel());

  // Viewport resize changes the cap (20vh) and usually the width (rewrap).
  window.addEventListener("resize", fit);

  return {
    element: root,
    setScale: applyScale,
    refit: fit,
    focus: () => textarea.focus(),
    destroy: () => window.removeEventListener("resize", fit),
  };
}
