// The "Unlock server" PIN pad (spec/server-chat/00-brief.md §6). Deliberately
// has NO `<input type="password">` anywhere — that invites the browser's own
// password-manager prompt ("save this password?"), which would be a giant
// tell that this isn't really a settings page. Digit entry is handled
// entirely by this module's own keydown listener plus the on-screen keypad;
// there is no text input of any kind to carry `autocomplete` semantics.

import type { PinError } from "./lockModel";

export interface PinPadDeps {
  win?: Window;
  onSubmit: (pin: string) => void;
  onCancel: () => void;
}

export interface PinPadView {
  readonly element: HTMLElement;
  /** Clears entered digits, error and busy state — call each time the pad is
   * (re)shown (the `revealed -> pin` transition). */
  reset(): void;
  setError(error: PinError | null): void;
  setBusy(busy: boolean): void;
  /** Moves focus onto the pad so physical digit keys work immediately
   * (`lockModel`'s `focusPin` effect). */
  focus(): void;
  teardown(): void;
}

/** §5.1: "the PIN must be 1–16 digits" — the client-side cap exists purely so
 * a fat-fingered long paste-equivalent can't build an oversized request; the
 * real validation is server-side. */
const MAX_PIN_LENGTH = 16;

function errorMessageFor(error: PinError, retryRemainingS: number): string {
  switch (error.kind) {
    case "wrong":
      return "Incorrect PIN";
    case "lockedOut":
      return `Too many attempts — try again in ${retryRemainingS}s`;
    case "unavailable":
      return "Server settings unavailable";
  }
}

export function mountPinPad(deps: PinPadDeps): PinPadView {
  const win = deps.win ?? window;

  const root = document.createElement("div");
  root.className = "wx-srv-pinpad";
  root.tabIndex = -1;

  const title = document.createElement("h2");
  title.className = "wx-srv-pinpad-title";
  title.textContent = "Unlock server";
  root.appendChild(title);

  const dots = document.createElement("div");
  dots.className = "wx-srv-pinpad-dots";
  dots.setAttribute("aria-hidden", "true");
  root.appendChild(dots);

  const message = document.createElement("p");
  message.className = "wx-srv-pinpad-message";
  message.setAttribute("role", "alert");
  root.appendChild(message);

  const keys = document.createElement("div");
  keys.className = "wx-srv-pinpad-keys";
  root.appendChild(keys);

  let pin = "";
  let busy = false;
  let currentError: PinError | null = null;
  let lockedOutUntilMs = 0;
  let countdownTimer: ReturnType<typeof win.setInterval> | null = null;

  function stopCountdown(): void {
    if (countdownTimer !== null) {
      win.clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  function renderDots(): void {
    dots.innerHTML = "";
    for (let i = 0; i < pin.length; i++) {
      const dot = document.createElement("span");
      dot.className = "wx-srv-pinpad-dot";
      dots.appendChild(dot);
    }
  }

  function renderMessage(): void {
    if (currentError === null) {
      message.textContent = "";
      return;
    }
    const remaining =
      currentError.kind === "lockedOut" ? Math.max(0, Math.ceil((lockedOutUntilMs - Date.now()) / 1000)) : 0;
    message.textContent = errorMessageFor(currentError, remaining);
    if (currentError.kind === "lockedOut" && remaining <= 0) {
      currentError = null;
      stopCountdown();
      message.textContent = "";
    }
  }

  function renderKeysState(): void {
    const lockedOut = currentError?.kind === "lockedOut" && Date.now() < lockedOutUntilMs;
    keys.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
      btn.disabled = busy || lockedOut;
    });
  }

  function appendDigit(digit: string): void {
    if (busy || pin.length >= MAX_PIN_LENGTH) return;
    if (currentError?.kind === "lockedOut" && Date.now() < lockedOutUntilMs) return;
    pin += digit;
    renderDots();
  }

  function backspace(): void {
    if (busy) return;
    pin = pin.slice(0, -1);
    renderDots();
  }

  function submit(): void {
    if (busy || pin.length === 0) return;
    if (currentError?.kind === "lockedOut" && Date.now() < lockedOutUntilMs) return;
    deps.onSubmit(pin);
  }

  function keyButton(label: string, className: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `wx-srv-pinpad-key ${className}`;
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }

  const grid = document.createElement("div");
  grid.className = "wx-srv-pinpad-grid";
  for (const digit of ["1", "2", "3", "4", "5", "6", "7", "8", "9"]) {
    grid.appendChild(keyButton(digit, "wx-srv-pinpad-key-digit", () => appendDigit(digit)));
  }
  grid.appendChild(keyButton("⌫", "wx-srv-pinpad-key-backspace", backspace));
  grid.appendChild(keyButton("0", "wx-srv-pinpad-key-digit", () => appendDigit("0")));
  grid.appendChild(keyButton("✓", "wx-srv-pinpad-key-submit", submit));
  keys.appendChild(grid);

  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "wx-srv-pinpad-cancel";
  cancelButton.textContent = "Cancel";
  cancelButton.addEventListener("click", () => deps.onCancel());
  root.appendChild(cancelButton);

  function onKeyDown(event: KeyboardEvent): void {
    if (/^[0-9]$/.test(event.key)) {
      event.preventDefault();
      appendDigit(event.key);
      return;
    }
    if (event.key === "Backspace") {
      event.preventDefault();
      backspace();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
      return;
    }
    // Escape is deliberately NOT handled here: it's one of R6's generic
    // instant-lock causes, dispatched centrally by `panel.ts` for every
    // state (not just the pin pad) rather than duplicated per-view.
  }
  root.addEventListener("keydown", onKeyDown);

  return {
    element: root,
    reset(): void {
      pin = "";
      busy = false;
      currentError = null;
      stopCountdown();
      renderDots();
      renderMessage();
      renderKeysState();
    },
    setError(error: PinError | null): void {
      currentError = error;
      stopCountdown();
      if (error?.kind === "lockedOut") {
        lockedOutUntilMs = Date.now() + error.retryAfterS * 1000;
        countdownTimer = win.setInterval(() => {
          renderMessage();
          renderKeysState();
        }, 1000);
      }
      // A fresh error always means the pad is no longer busy and the entered
      // digits were wrong/rejected — clear them so the next attempt starts
      // empty rather than silently resubmitting the same rejected PIN.
      pin = "";
      renderDots();
      renderMessage();
      renderKeysState();
    },
    setBusy(next: boolean): void {
      busy = next;
      renderKeysState();
    },
    focus(): void {
      root.focus();
    },
    teardown(): void {
      stopCountdown();
      root.removeEventListener("keydown", onKeyDown);
    },
  };
}
