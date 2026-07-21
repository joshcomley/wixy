import { afterEach, describe, expect, it, vi } from "vitest";
import { openComposer, type ComposerCallbacks } from "../src/composer";

afterEach(() => {
  document.body.innerHTML = "";
});

function makeCallbacks(): ComposerCallbacks & { preview: ReturnType<typeof vi.fn> } {
  const preview = vi.fn();
  return { preview, onPreview: preview, onCommit: vi.fn(), onCancel: vi.fn() };
}

function mount(seed: string, callbacks = makeCallbacks(), scale = 1) {
  const composer = openComposer({ seed, scale, callbacks });
  document.body.appendChild(composer.element);
  const textarea = composer.element.querySelector("textarea") as HTMLTextAreaElement;
  return { composer, textarea, callbacks };
}

describe("openComposer", () => {
  it("seeds the textarea with the demoted source", () => {
    const { textarea } = mount("**bold** seed");
    expect(textarea.value).toBe("**bold** seed");
  });

  it("Enter inserts a newline (does not commit); Ctrl+Enter commits", () => {
    const { textarea, callbacks } = mount("line1");
    textarea.value = "line1\nline2";
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(callbacks.onCommit).not.toHaveBeenCalled();

    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
    );
    expect(callbacks.onCommit).toHaveBeenCalledWith("line1\nline2");
  });

  it("Escape cancels without committing", () => {
    const { textarea, callbacks } = mount("draft");
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(callbacks.onCancel).toHaveBeenCalled();
    expect(callbacks.onCommit).not.toHaveBeenCalled();
  });

  it("every input fires onPreview with the current source (live preview)", () => {
    const { textarea, callbacks } = mount("");
    textarea.value = "typed *italic*";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    expect(callbacks.preview).toHaveBeenCalledWith("typed *italic*");
  });

  it("the ✓ button commits and the ✕ button cancels", () => {
    const { composer, textarea, callbacks } = mount("via buttons");
    (composer.element.querySelector(".wx-composer-commit") as HTMLButtonElement).click();
    expect(callbacks.onCommit).toHaveBeenCalledWith("via buttons");
    (composer.element.querySelector(".wx-composer-cancel") as HTMLButtonElement).click();
    expect(callbacks.onCancel).toHaveBeenCalled();
    void textarea;
  });

  it("B wraps the selection in **, I in *, preserving the selection", () => {
    const { composer, textarea } = mount("make me bold");
    textarea.setSelectionRange(0, 7); // "make me"
    (composer.element.querySelector(".wx-composer-fmt-bold") as HTMLButtonElement).click();
    expect(textarea.value).toBe("**make me** bold");
    expect(textarea.selectionStart).toBe(2);
    expect(textarea.selectionEnd).toBe(9);

    textarea.setSelectionRange(12, 16); // "bold" in "**make me** bold"
    (composer.element.querySelector(".wx-composer-fmt-italic") as HTMLButtonElement).click();
    expect(textarea.value).toBe("**make me** *bold*");
  });

  it("link wraps the selection and pre-selects the placeholder URL", () => {
    const { composer, textarea } = mount("click here");
    textarea.setSelectionRange(0, 5); // "click"
    (composer.element.querySelector(".wx-composer-fmt-link") as HTMLButtonElement).click();
    expect(textarea.value).toBe("[click](https://) here");
    expect(textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)).toBe("https://");
  });

  it("auto-grows with content but caps at min(5 lines, 20% viewport)", () => {
    const { textarea } = mount("x");
    // jsdom reports scrollHeight 0 — simulate a tall one via the style path:
    // the fit() math caps height at the cap, which we verify through overflow
    // behavior on a stubbed scrollHeight.
    Object.defineProperty(textarea, "scrollHeight", { value: 500, configurable: true });
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    const cap = Math.min(5 * 20, window.innerHeight * 0.2);
    expect(parseInt(textarea.style.height, 10)).toBe(cap);
    expect(textarea.style.overflowY).toBe("auto");
  });

  it("maximize expands and restores, lifting the grow cap", () => {
    const { composer, textarea } = mount("long text");
    const maxBtn = composer.element.querySelector(".wx-composer-max-toggle") as HTMLButtonElement;
    maxBtn.click();
    expect(composer.element.classList.contains("wx-composer-max")).toBe(true);
    expect(maxBtn.getAttribute("aria-pressed")).toBe("true");
    maxBtn.click();
    expect(composer.element.classList.contains("wx-composer-max")).toBe(false);
  });

  it("counter-scales when the preview is shrunk (viewport simulation)", () => {
    const { composer } = mount("scaled", makeCallbacks(), 0.5);
    expect(composer.element.style.transform).toBe("scale(2)");
    expect(composer.element.style.width).toBe("50%");
    composer.setScale(0.25);
    expect(composer.element.style.transform).toBe("scale(4)");
    expect(composer.element.style.width).toBe("25%");
  });
});
