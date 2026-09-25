import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatRetryDuration, mountPinPad } from "../../src/server/pinPad";

describe("Server PIN pad", () => {
  it("requires a valid 4-16 digit PIN before enabling or submitting", () => {
    const onSubmit = vi.fn();
    const pad = mountPinPad({ onSubmit, onCancel: vi.fn() });
    const digits = pad.element.querySelectorAll<HTMLButtonElement>(".wx-srv-pinpad-key-digit");
    const submit = pad.element.querySelector<HTMLButtonElement>(".wx-srv-pinpad-key-submit")!;

    digits[0]?.click();
    digits[1]?.click();
    digits[2]?.click();
    expect(submit.disabled).toBe(true);
    submit.click();
    expect(onSubmit).not.toHaveBeenCalled();

    digits[3]?.click();
    expect(submit.disabled).toBe(false);
    submit.click();
    expect(onSubmit).toHaveBeenCalledWith("1234");
    pad.teardown();
  });

  it("shows the exact wrong-PIN copy with attempts remaining", () => {
    const pad = mountPinPad({ onSubmit: vi.fn(), onCancel: vi.fn() });
    pad.setError({ kind: "wrong", attemptsLeft: 2 });
    expect(pad.element.querySelector(".wx-srv-pinpad-message")?.textContent)
      .toBe("Wrong PIN — 2 attempts left");
    pad.teardown();
  });

  it("shows the exact wrong-PIN copy when attempts remaining are unknown", () => {
    const pad = mountPinPad({ onSubmit: vi.fn(), onCancel: vi.fn() });
    pad.setError({ kind: "wrong", attemptsLeft: null });
    expect(pad.element.querySelector(".wx-srv-pinpad-message")?.textContent).toBe("Wrong PIN");
    pad.teardown();
  });

  it("uses the retry copy for a changed PIN and generic failures", () => {
    const pad = mountPinPad({ onSubmit: vi.fn(), onCancel: vi.fn() });
    const message = pad.element.querySelector(".wx-srv-pinpad-message")!;

    pad.setError({ kind: "pinChanged" });
    expect(message.textContent).toBe("Please try again.");
    pad.setError({ kind: "invalid" });
    expect(message.textContent).toBe("Couldn't unlock — try again.");
    pad.setError({ kind: "unexpected" });
    expect(message.textContent).toBe("Couldn't unlock — try again.");
    pad.setError({ kind: "unavailable" });
    expect(message.textContent).toBe("Server settings unavailable.");
    pad.setError({ kind: "lockedOut", retryAfterS: 120 });
    expect(message.textContent).toBe("Too many wrong tries. Try again in 2 minutes.");
    pad.teardown();
  });
});

// F15 (audit round 4): the lockout copy used to be a hard-coded "2 minutes" that
// ignored retryAfterS. cmd's ladder starts at 60 s and doubles to a 24 h cap, so
// the copy was wrong for every real lockout. It now states the real wait and
// counts down live (spec sec.6/sec.11), keeping the frozen sec.5.1 wording.
describe("formatRetryDuration", () => {
  it.each([
    [1, "1 second"],
    [2, "2 seconds"],
    [30, "30 seconds"],
    [59, "59 seconds"],
    [60, "1 minute"],
    [61, "2 minutes"],
    [120, "2 minutes"],
    [121, "3 minutes"],
    [3540, "59 minutes"],
    [3599, "1 hour"],
    [3600, "1 hour"],
    [3601, "1 hour 1 minute"],
    [5400, "1 hour 30 minutes"],
    [7200, "2 hours"],
    [43200, "12 hours"],
    [86399, "24 hours"],
    [86400, "24 hours"],
  ])("%i s -> %s", (seconds, expected) => {
    expect(formatRetryDuration(seconds)).toBe(expected);
  });

  it("never rounds a wait down to nothing", () => {
    expect(formatRetryDuration(0)).toBe("1 second");
    expect(formatRetryDuration(0.2)).toBe("1 second");
    expect(formatRetryDuration(-5)).toBe("1 second");
    expect(formatRetryDuration(Number.NaN)).toBe("1 second");
    expect(formatRetryDuration(Number.POSITIVE_INFINITY)).toBe("1 second");
  });

  it("rounds a fractional wait up so it is never understated", () => {
    expect(formatRetryDuration(59.2)).toBe("1 minute");
    expect(formatRetryDuration(1.4)).toBe("2 seconds");
  });
});

describe("Server PIN pad lockout copy and countdown (F15)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T10:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function mountLocked(retryAfterS: number) {
    const onSubmit = vi.fn();
    const pad = mountPinPad({ onSubmit, onCancel: vi.fn() });
    pad.setError({ kind: "lockedOut", retryAfterS });
    const message = pad.element.querySelector(".wx-srv-pinpad-message")!;
    return { pad, message, onSubmit };
  }

  it.each([
    [60, "Too many wrong tries. Try again in 1 minute."],
    [120, "Too many wrong tries. Try again in 2 minutes."],
    [3600, "Too many wrong tries. Try again in 1 hour."],
    [86400, "Too many wrong tries. Try again in 24 hours."],
    [45, "Too many wrong tries. Try again in 45 seconds."],
  ])("a %i s lockout says the real wait", (retryAfterS, expected) => {
    const { pad, message } = mountLocked(retryAfterS);
    expect(message.textContent).toBe(expected);
    pad.teardown();
  });

  it("counts down live, once a second, and re-enables the keys at zero", () => {
    const { pad, message } = mountLocked(65);
    const keys = () => [...pad.element.querySelectorAll<HTMLButtonElement>(".wx-srv-pinpad-keys button")];
    expect(message.textContent).toBe("Too many wrong tries. Try again in 2 minutes.");
    expect(keys().every((button) => button.disabled)).toBe(true);

    vi.advanceTimersByTime(5000);
    expect(message.textContent).toBe("Too many wrong tries. Try again in 1 minute.");
    vi.advanceTimersByTime(1000);
    expect(message.textContent).toBe("Too many wrong tries. Try again in 59 seconds.");
    vi.advanceTimersByTime(30_000);
    expect(message.textContent).toBe("Too many wrong tries. Try again in 29 seconds.");
    vi.advanceTimersByTime(28_000);
    expect(message.textContent).toBe("Too many wrong tries. Try again in 1 second.");
    expect(keys().some((button) => !button.disabled && !button.classList.contains("wx-srv-pinpad-key-submit"))).toBe(
      false,
    );

    vi.advanceTimersByTime(1000);
    expect(message.textContent).toBe("");
    const digitButtons = [...pad.element.querySelectorAll<HTMLButtonElement>(".wx-srv-pinpad-key-digit")];
    expect(digitButtons.every((button) => !button.disabled)).toBe(true);
    // The pad is usable again: digits register and the dots show them.
    digitButtons[0]?.click();
    expect(pad.element.querySelectorAll(".wx-srv-pinpad-dot")).toHaveLength(1);
    pad.teardown();
  });

  it("ignores digits and submit while locked", () => {
    const { pad, onSubmit } = mountLocked(30);
    for (const digit of ["1", "2", "3", "4"]) {
      pad.element.dispatchEvent(new KeyboardEvent("keydown", { key: digit, bubbles: true }));
    }
    pad.element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(pad.element.querySelectorAll(".wx-srv-pinpad-dot")).toHaveLength(0);
    expect(onSubmit).not.toHaveBeenCalled();
    pad.teardown();
  });

  it("only rewrites the countdown when its text changes (no per-tick DOM churn)", () => {
    const { pad, message } = mountLocked(600);
    const before = message.firstChild;
    const span = message.querySelector(".wx-srv-pinpad-countdown");
    expect(span?.getAttribute("aria-live")).toBe("off");
    vi.advanceTimersByTime(5000);
    expect(message.firstChild).toBe(before);
    expect(message.querySelector(".wx-srv-pinpad-countdown")).toBe(span);
    pad.teardown();
  });

  // L1 (reviewer): a 429 with no parseable wait (a proxy/WAF 429 with no JSON body and no
  // Retry-After) reached the pad as retryAfterS 0, which read as an already-expired lock:
  // the digits cleared and the owner saw nothing at all. It must show a generic wait.
  it.each([0, -3, Number.NaN, Number.POSITIVE_INFINITY])(
    "a lockout with no usable wait (%s) still says so and holds the keys for a generic wait",
    (retryAfterS) => {
      const { pad, message, onSubmit } = mountLocked(retryAfterS);
      expect(message.textContent).toBe("Too many wrong tries. Try again in 30 seconds.");
      const digits = [...pad.element.querySelectorAll<HTMLButtonElement>(".wx-srv-pinpad-key-digit")];
      expect(digits.every((button) => button.disabled)).toBe(true);
      pad.element.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
      pad.element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(onSubmit).not.toHaveBeenCalled();

      vi.advanceTimersByTime(29_000);
      expect(message.textContent).toBe("Too many wrong tries. Try again in 1 second.");
      vi.advanceTimersByTime(1_000);
      expect(message.textContent).toBe("");
      expect(digits.every((button) => !button.disabled)).toBe(true);
      pad.teardown();
    },
  );

  it("a fresh lockout restarts the countdown from the new wait", () => {
    const { pad, message } = mountLocked(30);
    vi.advanceTimersByTime(10_000);
    expect(message.textContent).toBe("Too many wrong tries. Try again in 20 seconds.");
    pad.setError({ kind: "lockedOut", retryAfterS: 120 });
    expect(message.textContent).toBe("Too many wrong tries. Try again in 2 minutes.");
    vi.advanceTimersByTime(60_000);
    expect(message.textContent).toBe("Too many wrong tries. Try again in 1 minute.");
    pad.teardown();
  });

  it("a different error, or reset, stops the countdown and clears the lockout copy", () => {
    const { pad, message } = mountLocked(30);
    pad.setError({ kind: "unavailable" });
    expect(message.textContent).toBe("Server settings unavailable.");
    vi.advanceTimersByTime(5000);
    expect(message.textContent).toBe("Server settings unavailable.");

    pad.setError({ kind: "lockedOut", retryAfterS: 30 });
    pad.reset();
    expect(message.textContent).toBe("");
    vi.advanceTimersByTime(5000);
    expect(message.textContent).toBe("");
    pad.teardown();
  });
});

describe("Server PIN pad options", () => {
  it("defaults its heading to 'Unlock server'", () => {
    const pad = mountPinPad({ onSubmit: vi.fn(), onCancel: vi.fn() });
    expect(pad.element.querySelector(".wx-srv-pinpad-title")?.textContent).toBe("Unlock server");
    pad.teardown();
  });

  it("uses the title it is given", () => {
    const pad = mountPinPad({
      title: "Enter PIN to keep this device unlocked",
      onSubmit: vi.fn(),
      onCancel: vi.fn(),
    });
    expect(pad.element.querySelector(".wx-srv-pinpad-title")?.textContent).toBe(
      "Enter PIN to keep this device unlocked",
    );
    pad.teardown();
  });

  it("is marked gesture-exempt only when asked, so its keys never count toward a multi-tap lock", () => {
    const plain = mountPinPad({ onSubmit: vi.fn(), onCancel: vi.fn() });
    const exempt = mountPinPad({ gestureExempt: true, onSubmit: vi.fn(), onCancel: vi.fn() });
    expect(plain.element.hasAttribute("data-srv-gesture-exempt")).toBe(false);
    expect(exempt.element.hasAttribute("data-srv-gesture-exempt")).toBe(true);
    expect(exempt.element.querySelectorAll(".wx-srv-pinpad-key").length).toBeGreaterThan(0);
    plain.teardown();
    exempt.teardown();
  });

  it("an explicit gestureExempt: false is not marked", () => {
    const pad = mountPinPad({ gestureExempt: false, onSubmit: vi.fn(), onCancel: vi.fn() });
    expect(pad.element.hasAttribute("data-srv-gesture-exempt")).toBe(false);
    pad.teardown();
  });
});
