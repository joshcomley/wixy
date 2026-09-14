// A single reusable full-screen media lightbox (extracted from chatPanel.ts,
// decisions/00110 — workspace #29 sec.10 P5a): backdrop click, ✕ button, and
// Esc all close it; focus returns to whatever was focused before it opened.
// Shared by the AI chat panel's attachment thumbnails and, going forward, the
// server chat's photo grid (spec/server-chat/00-brief.md §10 P6a).

export interface Lightbox {
  /** Opens (replacing any already-open instance) showing `src` as an <img>,
   * with `alt` as both its alt text and the dialog's aria-label. */
  open(src: string, alt: string): void;
  close(): void;
  /** Alias for `close()` — the panel-teardown call site reads more clearly
   * as "dispose whatever's open" than "close". */
  teardown(): void;
}

export function mountLightbox(host?: HTMLElement): Lightbox {
  let cleanup: (() => void) | null = null;

  function close(): void {
    cleanup?.();
    cleanup = null;
  }

  function open(src: string, alt: string): void {
    close();
    const overlay = document.createElement("div");
    overlay.className = "wx-chat-lightbox";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", alt || "Attached image");
    const image = document.createElement("img");
    image.src = src;
    image.alt = alt;
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "wx-chat-lightbox-close";
    closeButton.textContent = "✕";
    closeButton.setAttribute("aria-label", "Close image viewer");
    overlay.append(image, closeButton);
    const previouslyFocused = document.activeElement;
    const onKeydown = (evt: KeyboardEvent) => {
      if (evt.key === "Escape") {
        evt.preventDefault();
        close();
      }
    };
    overlay.addEventListener("click", (evt) => {
      if (evt.target === overlay || evt.target === closeButton) close();
    });
    document.addEventListener("keydown", onKeydown);
    (host ?? document.body).appendChild(overlay);
    cleanup = () => {
      document.removeEventListener("keydown", onKeydown);
      overlay.remove();
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
    closeButton.focus();
  }

  return { open, close, teardown: close };
}
