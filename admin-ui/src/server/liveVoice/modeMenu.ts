/**
 * The microphone button's mode switch (spec/server-chat/07 §1): long-press it, then pick
 * **Voice note** or **Live voice note**.
 *
 * The press that opens the menu must not also start a recording, so `consumeClickSuppression()`
 * tells the button's own click handler to ignore the click that follows a long press. Other ways
 * in, for keyboards, screen readers and desktop mice: the ContextMenu key / Shift+F10 / a right
 * click (all arrive as `contextmenu`), and the Up/Down arrow keys on the focused button (the
 * ordinary menu-button keys). The choice itself lives with the caller, in memory only for the
 * life of the page: nothing here touches browser storage.
 */

export type VoiceMode = "voice" | "live";

export interface VoiceModeMenuOptions {
  readonly document: Document;
  readonly win: Window;
  readonly button: HTMLButtonElement;
  getMode(): VoiceMode;
  setMode(mode: VoiceMode): void;
  /** True while recording or sending: the mode cannot change then, and no menu opens. */
  isBusy(): boolean;
  readonly longPressMs?: number;
}

export interface VoiceModeMenu {
  open(): void;
  close(): void;
  isOpen(): boolean;
  /** True once, for the click that follows a long press that opened the menu. */
  consumeClickSuppression(): boolean;
  dispose(): void;
}

export const LONG_PRESS_MS = 500;
/** A press that moves further than this is a scroll or a drag, not a long press. */
const MOVE_TOLERANCE_PX = 10;
/** A suppressed click that never arrives (the finger slid off the button) must not eat the next tap. */
const SUPPRESSION_MS = 700;

const CHOICES: ReadonlyArray<{ readonly mode: VoiceMode; readonly label: string }> = [
  { mode: "voice", label: "Voice note" },
  { mode: "live", label: "Live voice note" },
];

export function createVoiceModeMenu(options: VoiceModeMenuOptions): VoiceModeMenu {
  const { document: doc, win, button } = options;
  /** The real browser window (events and size); `win` supplies the timers. */
  const view: Window = doc.defaultView ?? win;
  const longPressMs = options.longPressMs ?? LONG_PRESS_MS;
  let timer: number | null = null;
  let suppressTimer: number | null = null;
  let suppressClick = false;
  let startX = 0;
  let startY = 0;
  let menu: HTMLElement | null = null;
  let disposed = false;

  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");

  function clearTimer(): void {
    if (timer !== null) win.clearTimeout(timer);
    timer = null;
  }

  function armSuppression(): void {
    suppressClick = true;
    if (suppressTimer !== null) win.clearTimeout(suppressTimer);
    suppressTimer = win.setTimeout(() => {
      suppressClick = false;
      suppressTimer = null;
    }, SUPPRESSION_MS);
  }

  function items(): HTMLButtonElement[] {
    return menu === null ? [] : Array.from(menu.querySelectorAll<HTMLButtonElement>("[role='menuitemradio']"));
  }

  function close(returnFocus = false): void {
    if (menu === null) return;
    menu.remove();
    menu = null;
    button.setAttribute("aria-expanded", "false");
    doc.removeEventListener("pointerdown", onOutside, true);
    doc.removeEventListener("keydown", onDocumentKey, true);
    view.removeEventListener("resize", onResize);
    if (returnFocus) button.focus();
  }

  function onOutside(event: Event): void {
    if (menu !== null && event.target instanceof Node && !menu.contains(event.target) && event.target !== button) close();
  }

  function onResize(): void {
    close();
  }

  function onDocumentKey(event: KeyboardEvent): void {
    if (menu === null) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") {
      close();
    }
  }

  function open(): void {
    if (disposed || menu !== null || options.isBusy()) return;
    const el = doc.createElement("div");
    el.className = "wx-srv-voice-mode-menu";
    el.setAttribute("role", "menu");
    el.setAttribute("aria-label", "Voice note type");
    // A surface that appears from the press that opened it: a gesture boundary like the other
    // surface-opening controls (gestures.ts).
    el.setAttribute("data-srv-gesture-boundary", "");
    const current = options.getMode();
    for (const choice of CHOICES) {
      const item = doc.createElement("button");
      item.type = "button";
      item.className = `wx-srv-voice-mode-item wx-srv-voice-mode-item-${choice.mode}`;
      item.setAttribute("role", "menuitemradio");
      item.setAttribute("aria-checked", String(choice.mode === current));
      item.setAttribute("data-srv-gesture-boundary", "");
      item.tabIndex = choice.mode === current ? 0 : -1;
      if (choice.mode === "live") {
        const dot = doc.createElement("span");
        dot.className = "wx-srv-live-dot";
        dot.setAttribute("aria-hidden", "true");
        item.appendChild(dot);
      }
      const text = doc.createElement("span");
      text.textContent = choice.label;
      item.appendChild(text);
      item.addEventListener("click", (event) => {
        event.stopPropagation();
        options.setMode(choice.mode);
        close(true);
      });
      el.appendChild(item);
    }
    el.addEventListener("keydown", (event) => {
      const all = items();
      const at = all.indexOf(doc.activeElement as HTMLButtonElement);
      let next = -1;
      if (event.key === "ArrowDown") next = (at + 1) % all.length;
      else if (event.key === "ArrowUp") next = (at - 1 + all.length) % all.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = all.length - 1;
      if (next < 0) return;
      event.preventDefault();
      all[next]?.focus();
    });
    doc.body.appendChild(el);
    menu = el;
    button.setAttribute("aria-expanded", "true");
    // Fixed, anchored above the button and kept inside the viewport (320 px phones included).
    const rect = button.getBoundingClientRect();
    const viewportWidth = view.innerWidth || doc.documentElement.clientWidth || 360;
    const viewportHeight = view.innerHeight || doc.documentElement.clientHeight || 640;
    const width = Math.min(220, viewportWidth - 16);
    el.style.width = `${width}px`;
    el.style.left = `${Math.max(8, Math.min(rect.left, viewportWidth - width - 8))}px`;
    el.style.bottom = `${Math.max(8, viewportHeight - rect.top + 6)}px`;
    doc.addEventListener("pointerdown", onOutside, true);
    doc.addEventListener("keydown", onDocumentKey, true);
    view.addEventListener("resize", onResize);
    (items().find((item) => item.getAttribute("aria-checked") === "true") ?? items()[0])?.focus();
  }

  const onPointerDown = (event: PointerEvent): void => {
    suppressClick = false;
    if (event.button !== 0 || options.isBusy()) return;
    startX = event.clientX;
    startY = event.clientY;
    clearTimer();
    timer = win.setTimeout(() => {
      timer = null;
      armSuppression();
      open();
    }, longPressMs);
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (timer === null) return;
    if (Math.abs(event.clientX - startX) > MOVE_TOLERANCE_PX || Math.abs(event.clientY - startY) > MOVE_TOLERANCE_PX) clearTimer();
  };
  const onPointerEnd = (): void => clearTimer();
  const onContextMenu = (event: Event): void => {
    // Also what a touch long-press, the ContextMenu key and Shift+F10 raise.
    event.preventDefault();
    if (options.isBusy()) return;
    clearTimer();
    armSuppression();
    open();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    if (options.isBusy()) return;
    event.preventDefault();
    open();
  };

  button.addEventListener("pointerdown", onPointerDown);
  button.addEventListener("pointermove", onPointerMove);
  button.addEventListener("pointerup", onPointerEnd);
  button.addEventListener("pointercancel", onPointerEnd);
  button.addEventListener("pointerleave", onPointerEnd);
  button.addEventListener("contextmenu", onContextMenu);
  button.addEventListener("keydown", onKeyDown);

  return {
    open,
    close: () => close(),
    isOpen: () => menu !== null,
    consumeClickSuppression(): boolean {
      const was = suppressClick;
      suppressClick = false;
      return was;
    },
    dispose(): void {
      disposed = true;
      clearTimer();
      if (suppressTimer !== null) win.clearTimeout(suppressTimer);
      close();
      button.removeEventListener("pointerdown", onPointerDown);
      button.removeEventListener("pointermove", onPointerMove);
      button.removeEventListener("pointerup", onPointerEnd);
      button.removeEventListener("pointercancel", onPointerEnd);
      button.removeEventListener("pointerleave", onPointerEnd);
      button.removeEventListener("contextmenu", onContextMenu);
      button.removeEventListener("keydown", onKeyDown);
    },
  };
}
