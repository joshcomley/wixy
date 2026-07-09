import { describe, expect, it, vi } from "vitest";
import {
  buildImagePopover,
  buildLinkPopover,
  buildPlainTextPopover,
  buildRichLiteTextPopover,
  positionNear,
} from "../src/popovers";

function fireKeydown(el: Element, key: string, extra: Partial<KeyboardEventInit> = {}): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...extra }));
}

describe("buildPlainTextPopover", () => {
  it("renders an input pre-filled with the current text", () => {
    const el = buildPlainTextPopover("Hello", { onCommit: vi.fn(), onCancel: vi.fn() });
    const input = el.querySelector("input");
    expect(input?.value).toBe("Hello");
  });

  it("uses a textarea for long text", () => {
    const long = "x".repeat(80);
    const el = buildPlainTextPopover(long, { onCommit: vi.fn(), onCancel: vi.fn() });
    expect(el.querySelector("textarea")).not.toBeNull();
    expect(el.querySelector("input")).toBeNull();
  });

  it("commits the current value on Enter", () => {
    const onCommit = vi.fn();
    const el = buildPlainTextPopover("Original", { onCommit, onCancel: vi.fn() });
    const input = el.querySelector("input");
    if (input === null) throw new Error("expected an input");
    input.value = "Edited";
    fireKeydown(input, "Enter");
    expect(onCommit).toHaveBeenCalledWith("Edited");
  });

  it("cancels on Escape without committing", () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    const el = buildPlainTextPopover("Original", { onCommit, onCancel });
    const input = el.querySelector("input");
    if (input === null) throw new Error("expected an input");
    fireKeydown(input, "Escape");
    expect(onCancel).toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe("buildRichLiteTextPopover", () => {
  it("renders a contenteditable seeded with the current HTML", () => {
    const el = buildRichLiteTextPopover("Learn <strong>more</strong>", {
      onCommit: vi.fn(),
      onCancel: vi.fn(),
    });
    const editable = el.querySelector('[contenteditable]');
    expect(editable?.innerHTML).toBe("Learn <strong>more</strong>");
  });

  it("has exactly a Bold, Italic, and Link toolbar button", () => {
    const el = buildRichLiteTextPopover("text", { onCommit: vi.fn(), onCancel: vi.fn() });
    const labels = Array.from(el.querySelectorAll(".wx-popover-toolbar button")).map(
      (b) => b.textContent,
    );
    expect(labels).toEqual(["B", "I", "Link"]);
  });

  it("commits the editable's current innerHTML on Enter", () => {
    const onCommit = vi.fn();
    const el = buildRichLiteTextPopover("text", { onCommit, onCancel: vi.fn() });
    const editable = el.querySelector('[contenteditable]');
    if (editable === null) throw new Error("expected contenteditable");
    editable.innerHTML = "edited <em>text</em>";
    fireKeydown(editable, "Enter");
    expect(onCommit).toHaveBeenCalledWith("edited <em>text</em>");
  });
});

describe("buildLinkPopover", () => {
  it("renders both a label and href input when a label is present", () => {
    const el = buildLinkPopover("/about.html", "Learn more", {
      onCommitHref: vi.fn(),
      onCommitLabel: vi.fn(),
      onCancel: vi.fn(),
    });
    const inputs = el.querySelectorAll("input");
    expect(inputs).toHaveLength(2);
    expect(inputs[0]?.value).toBe("Learn more");
    expect(inputs[1]?.value).toBe("/about.html");
  });

  it("renders only an href input when there is no co-located label", () => {
    const el = buildLinkPopover("/about.html", null, {
      onCommitHref: vi.fn(),
      onCancel: vi.fn(),
    });
    expect(el.querySelectorAll("input")).toHaveLength(1);
  });

  it("commits the href on Enter", () => {
    const onCommitHref = vi.fn();
    const el = buildLinkPopover("/old.html", null, { onCommitHref, onCancel: vi.fn() });
    const input = el.querySelector("input");
    if (input === null) throw new Error("expected an input");
    input.value = "/new.html";
    fireKeydown(input, "Enter");
    expect(onCommitHref).toHaveBeenCalledWith("/new.html");
  });
});

describe("buildImagePopover", () => {
  it("renders a Replace button and an alt input pre-filled", () => {
    const el = buildImagePopover("Current alt", {
      onReplace: vi.fn(),
      onCommitAlt: vi.fn(),
      onCancel: vi.fn(),
    });
    const button = el.querySelector("button");
    const input = el.querySelector("input");
    expect(button?.textContent).toBe("Replace image");
    expect(input?.value).toBe("Current alt");
  });

  it("calls onReplace when the Replace button is clicked", () => {
    const onReplace = vi.fn();
    const el = buildImagePopover("alt", { onReplace, onCommitAlt: vi.fn(), onCancel: vi.fn() });
    el.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onReplace).toHaveBeenCalled();
  });

  it("commits the alt text on Enter", () => {
    const onCommitAlt = vi.fn();
    const el = buildImagePopover("old alt", {
      onReplace: vi.fn(),
      onCommitAlt,
      onCancel: vi.fn(),
    });
    const input = el.querySelector("input");
    if (input === null) throw new Error("expected an input");
    input.value = "new alt";
    fireKeydown(input, "Enter");
    expect(onCommitAlt).toHaveBeenCalledWith("new alt");
  });
});

describe("positionNear", () => {
  it("sets left/top from the anchor's bounding rect", () => {
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue({
      left: 10,
      bottom: 20,
      top: 0,
      right: 0,
      width: 0,
      height: 0,
      x: 10,
      y: 0,
      toJSON: () => ({}),
    });
    const popover = document.createElement("div");
    positionNear(popover, anchor);
    expect(popover.style.left).toBe("10px");
    expect(popover.style.top).toBe("24px");
  });
});
