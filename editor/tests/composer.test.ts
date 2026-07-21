import { afterEach, describe, expect, it, vi } from "vitest";
import { openComposer, type ComposerCallbacks } from "../src/composer";
import { installFakeVisualViewport, uninstallFakeVisualViewport } from "./fakeVisualViewport";

afterEach(() => {
  uninstallFakeVisualViewport();
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

  it("refit() sizes the textarea to its content once attached (decisions/00079)", () => {
    const { composer, textarea } = mount("seed");
    Object.defineProperty(textarea, "scrollHeight", { value: 80, configurable: true });
    composer.refit();
    expect(textarea.style.height).toBe("80px");
    expect(textarea.style.overflowY).toBe("hidden");
  });

  it("never sizes a DETACHED textarea (scrollHeight is 0 before attach — decisions/00079)", () => {
    const composer = openComposer({ seed: "x", scale: 1, callbacks: makeCallbacks() });
    const textarea = composer.element.querySelector("textarea") as HTMLTextAreaElement;
    composer.refit();
    expect(textarea.style.height).toBe(""); // not "0px" — the sliver bug
  });

  it("setScale re-fits (counter-scale changes the width, so wrapping changes)", () => {
    const { composer, textarea } = mount("seed");
    Object.defineProperty(textarea, "scrollHeight", { value: 64, configurable: true });
    composer.setScale(0.5);
    expect(textarea.style.height).toBe("64px");
  });

  it("re-fits on window resize; destroy() removes the listener", () => {
    const { composer, textarea } = mount("seed");
    const sh = { value: 72 };
    Object.defineProperty(textarea, "scrollHeight", {
      get: () => sh.value,
      configurable: true,
    });
    window.dispatchEvent(new Event("resize"));
    expect(textarea.style.height).toBe("72px");
    sh.value = 48;
    composer.destroy();
    window.dispatchEvent(new Event("resize"));
    expect(textarea.style.height).toBe("72px"); // unchanged after destroy
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

  it("the maximize toggle renders a real SVG icon, not a tiny text glyph (decisions/00084)", () => {
    const { composer } = mount("seed");
    const maxBtn = composer.element.querySelector(".wx-composer-max-toggle") as HTMLButtonElement;
    expect(maxBtn.querySelector("svg")).not.toBeNull();
    expect(maxBtn.getAttribute("aria-label")).toBe("Maximize editor");
    const collapsed = maxBtn.innerHTML;
    maxBtn.click();
    expect(maxBtn.querySelector("svg")).not.toBeNull();
    expect(maxBtn.innerHTML).not.toBe(collapsed);
    expect(maxBtn.getAttribute("aria-label")).toBe("Restore editor");
  });

  describe("visual-viewport pinning (decisions/00084)", () => {
    it("pins itself to the visual viewport bottom — keyboard/pinch can never scroll it off", () => {
      const vv = installFakeVisualViewport({ width: 390, height: 500 });
      const { composer } = mount("seed");
      expect(composer.element.style.bottom).toBe(`${window.innerHeight - 500}px`);
      expect(composer.element.style.left).toBe("0px");
      expect(composer.element.style.width).toBe("390px");
      vv.height = 600;
      vv.fire("resize");
      expect(composer.element.style.bottom).toBe(`${window.innerHeight - 600}px`);
    });

    it("the pinned width tracks the counter-scale (squished device simulation)", () => {
      installFakeVisualViewport({ width: 400, height: 700 });
      const { composer } = mount("seed", makeCallbacks(), 0.5);
      expect(composer.element.style.width).toBe("200px");
      composer.setScale(0.25);
      expect(composer.element.style.width).toBe("100px");
    });

    it("destroy() releases the pin — no listener leak, inline styles restored", () => {
      const vv = installFakeVisualViewport({ width: 390, height: 500 });
      const { composer } = mount("seed");
      composer.destroy();
      vv.height = 700;
      vv.fire("resize");
      expect(composer.element.style.bottom).toBe("");
    });
  });
});
