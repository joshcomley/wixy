// The "Unlock server" PIN pad (spec/server-chat/00-brief.md §6). Deliberately
// has NO `<input type="password">` anywhere — that invites the browser's own
// password-manager prompt ("save this password?"), which would be a giant
// tell that this isn't really a settings page. Digit entry is handled
// entirely by this module's own keydown listener plus the on-screen keypad;
// there is no text input of any kind to carry `autocomplete` semantics.

import type { PinError } from "./lockModel";

export interface PinPadDeps {
  win?: Window;
  /** The heading; defaults to "Unlock server". */
  title?: string;
  /** Marks the pad so its digit keys never count toward the multi-tap lock gesture
   * (`gestures.ts`) — for a pad shown INSIDE the unlocked chat. */
  gestureExempt?: boolean;
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

/** §5.1 validates the allowed 4–16 digit range locally. */
const MIN_PIN_LENGTH = 4;
const MAX_PIN_LENGTH = 16;
/** The wait shown for a lockout that carries no usable retry time (a proxy/WAF 429). */
const UNKNOWN_LOCKOUT_WAIT_S = 30;

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/** A lockout wait as the owner reads it: whole seconds under a minute, whole minutes
 * under an hour, then hours (plus leftover minutes). Always rounds UP, so the copy never
 * tells someone to retry before cmd will let them, and never shows less than a second.
 * cmd's ladder runs from 60 s up to a 24 h cap, so all three units occur (F15). */
export function formatRetryDuration(totalSeconds: number): string {
  const seconds = Math.max(1, Math.ceil(Number.isFinite(totalSeconds) ? totalSeconds : 1));
  if (seconds < 60) return plural(seconds, "second");
  const totalMinutes = Math.ceil(seconds / 60);
  if (totalMinutes < 60) return plural(totalMinutes, "minute");
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? plural(hours, "hour") : `${plural(hours, "hour")} ${plural(minutes, "minute")}`;
}

function errorMessageFor(error: Exclude<PinError, { kind: "lockedOut" }>): string {
  switch (error.kind) {
    case "wrong":
      return error.attemptsLeft === null ? "Wrong PIN" : `Wrong PIN — ${error.attemptsLeft} attempts left`;
    case "pinChanged":
      return "Please try again.";
    case "invalid":
    case "unexpected":
      return "Couldn't unlock — try again.";
    case "unavailable":
      return "Server settings unavailable.";
  }
}

export function mountPinPad(deps: PinPadDeps): PinPadView {
  const win = deps.win ?? window;

  const root = document.createElement("div");
  root.className = "wx-srv-pinpad";
  root.tabIndex = -1;
  if (deps.gestureExempt === true) root.dataset["srvGestureExempt"] = "";

  const title = document.createElement("h2");
  title.className = "wx-srv-pinpad-title";
  title.textContent = deps.title ?? "Unlock server";
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
  let countdownEl: HTMLSpanElement | null = null;

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

  function setPlainMessage(text: string): void {
    countdownEl = null;
    message.textContent = text;
  }

  /** The lockout copy keeps sec.5.1's wording but states cmd's real wait, and only the
   * duration inside it changes on each tick. It sits in its own `aria-live="off"` span so
   * a screen reader hears the alert once instead of every second. */
  function renderLockoutMessage(remainingS: number): void {
    const duration = formatRetryDuration(remainingS);
    if (countdownEl !== null && countdownEl.parentNode === message) {
      if (countdownEl.textContent !== duration) countdownEl.textContent = duration;
      return;
    }
    const el = document.createElement("span");
    el.className = "wx-srv-pinpad-countdown";
    el.setAttribute("aria-live", "off");
    el.textContent = duration;
    message.replaceChildren("Too many wrong tries. Try again in ", el, ".");
    countdownEl = el;
  }

  function renderMessage(): void {
    if (currentError === null) {
      setPlainMessage("");
      return;
    }
    if (currentError.kind === "lockedOut") {
      const remaining = Math.ceil((lockedOutUntilMs - Date.now()) / 1000);
      if (remaining <= 0) {
        currentError = null;
        stopCountdown();
        setPlainMessage("");
        return;
      }
      renderLockoutMessage(remaining);
      return;
    }
    setPlainMessage(errorMessageFor(currentError));
  }

  function renderKeysState(): void {
    const lockedOut = currentError?.kind === "lockedOut" && Date.now() < lockedOutUntilMs;
    keys.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
      btn.disabled = busy || lockedOut;
    });
    const submitButton = keys.querySelector<HTMLButtonElement>(".wx-srv-pinpad-key-submit");
    if (submitButton !== null) submitButton.disabled = busy || lockedOut || pin.length < MIN_PIN_LENGTH;
  }

  function appendDigit(digit: string): void {
    if (busy || pin.length >= MAX_PIN_LENGTH) return;
    if (currentError?.kind === "lockedOut" && Date.now() < lockedOutUntilMs) return;
    pin += digit;
    renderDots();
    renderKeysState();
  }

  function backspace(): void {
    if (busy) return;
    pin = pin.slice(0, -1);
    renderDots();
    renderKeysState();
  }

  function submit(): void {
    if (busy || pin.length < MIN_PIN_LENGTH || pin.length > MAX_PIN_LENGTH) return;
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
  renderKeysState();

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
        // A 429 from a proxy or WAF can arrive with no parseable wait (retryAfterS 0). That
        // is still a lockout, not an expired one: hold the keys for a generic wait and say
        // so, rather than silently clearing the digits.
        const waitS =
          Number.isFinite(error.retryAfterS) && error.retryAfterS > 0 ? error.retryAfterS : UNKNOWN_LOCKOUT_WAIT_S;
        lockedOutUntilMs = Date.now() + waitS * 1000;
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
