import { describe, expect, it, vi } from "vitest";
import { mountPinPad } from "../../src/server/pinPad";

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
