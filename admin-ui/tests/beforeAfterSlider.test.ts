import { describe, expect, it } from "vitest";
import { renderBeforeAfter } from "../src/beforeAfterSlider";

describe("renderBeforeAfter", () => {
  it("renders a before and an after image plus a range input", () => {
    const el = renderBeforeAfter({
      beforeUrl: "/images/before.jpg",
      afterUrl: "/images/after.jpg",
      beforeAlt: "Before",
      afterAlt: "After",
    });

    const before = el.querySelector<HTMLImageElement>(".wx-before-after-before");
    const after = el.querySelector<HTMLImageElement>(".wx-before-after-after");
    expect(before?.src).toContain("/images/before.jpg");
    expect(before?.alt).toBe("Before");
    expect(after?.src).toContain("/images/after.jpg");
    expect(after?.alt).toBe("After");
    expect(el.querySelector<HTMLInputElement>(".wx-before-after-range")).not.toBeNull();
  });

  it("defaults to a 50% starting reveal", () => {
    const el = renderBeforeAfter({ beforeUrl: "/b.jpg", afterUrl: "/a.jpg" });
    const range = el.querySelector<HTMLInputElement>(".wx-before-after-range");
    const before = el.querySelector<HTMLElement>(".wx-before-after-before");
    expect(range?.value).toBe("50");
    expect(before?.style.clipPath).toBe("inset(0 50% 0 0)");
  });

  it("an explicit start option sets the initial reveal position", () => {
    const el = renderBeforeAfter({ beforeUrl: "/b.jpg", afterUrl: "/a.jpg", start: 20 });
    const before = el.querySelector<HTMLElement>(".wx-before-after-before");
    const divider = el.querySelector<HTMLElement>(".wx-before-after-divider");
    expect(before?.style.clipPath).toBe("inset(0 80% 0 0)");
    expect(divider?.style.left).toBe("20%");
  });

  it("dragging the range input updates the clip-path and divider/handle position", () => {
    const el = renderBeforeAfter({ beforeUrl: "/b.jpg", afterUrl: "/a.jpg" });
    const range = el.querySelector<HTMLInputElement>(".wx-before-after-range");
    const before = el.querySelector<HTMLElement>(".wx-before-after-before");
    const divider = el.querySelector<HTMLElement>(".wx-before-after-divider");
    const handle = el.querySelector<HTMLElement>(".wx-before-after-handle");
    if (range === null) throw new Error("no range input");

    range.value = "75";
    range.dispatchEvent(new Event("input"));

    expect(before?.style.clipPath).toBe("inset(0 25% 0 0)");
    expect(divider?.style.left).toBe("75%");
    expect(handle?.style.left).toBe("75%");
  });
});
