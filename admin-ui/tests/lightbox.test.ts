import { afterEach, describe, expect, it } from "vitest";
import { mountLightbox } from "../src/lightbox";

describe("mountLightbox", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("opens onto document.body by default, with the image, alt, and close button", () => {
    const lightbox = mountLightbox();
    lightbox.open("https://example.test/photo.webp", "a garden gnome");

    const overlay = document.body.querySelector<HTMLElement>(".wx-chat-lightbox");
    expect(overlay).not.toBeNull();
    expect(overlay?.getAttribute("role")).toBe("dialog");
    expect(overlay?.getAttribute("aria-modal")).toBe("true");
    expect(overlay?.getAttribute("aria-label")).toBe("a garden gnome");
    const img = overlay?.querySelector<HTMLImageElement>("img");
    expect(img?.src).toBe("https://example.test/photo.webp");
    expect(img?.alt).toBe("a garden gnome");
    expect(overlay?.querySelector(".wx-chat-lightbox-close")).not.toBeNull();
    lightbox.teardown();
  });

  it("falls back to a generic aria-label when alt is empty", () => {
    const lightbox = mountLightbox();
    lightbox.open("https://example.test/a.jpg", "");
    expect(document.body.querySelector(".wx-chat-lightbox")?.getAttribute("aria-label")).toBe(
      "Attached image",
    );
    lightbox.teardown();
  });

  it("opens into a custom host element when one is given", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const lightbox = mountLightbox(host);
    lightbox.open("https://example.test/x.jpg", "x");

    expect(host.querySelector(".wx-chat-lightbox")).not.toBeNull();
    expect(document.body.querySelectorAll(".wx-chat-lightbox")).toHaveLength(1);
    lightbox.teardown();
  });

  it("close() removes the overlay", () => {
    const lightbox = mountLightbox();
    lightbox.open("https://example.test/a.jpg", "a");
    lightbox.close();
    expect(document.body.querySelector(".wx-chat-lightbox")).toBeNull();
  });

  it("Escape closes it", () => {
    const lightbox = mountLightbox();
    lightbox.open("https://example.test/a.jpg", "a");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(document.body.querySelector(".wx-chat-lightbox")).toBeNull();
  });

  it("a backdrop click closes it; a click on the image does not", () => {
    const lightbox = mountLightbox();
    lightbox.open("https://example.test/a.jpg", "a");
    const overlay = document.body.querySelector<HTMLElement>(".wx-chat-lightbox")!;

    overlay.querySelector("img")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.body.querySelector(".wx-chat-lightbox")).not.toBeNull();

    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.body.querySelector(".wx-chat-lightbox")).toBeNull();
  });

  it("the close button closes it", () => {
    const lightbox = mountLightbox();
    lightbox.open("https://example.test/a.jpg", "a");
    document.body.querySelector<HTMLButtonElement>(".wx-chat-lightbox-close")?.click();
    expect(document.body.querySelector(".wx-chat-lightbox")).toBeNull();
  });

  it("opening a second image replaces the first, not stacks it", () => {
    const lightbox = mountLightbox();
    lightbox.open("https://example.test/first.jpg", "first");
    lightbox.open("https://example.test/second.jpg", "second");

    const overlays = document.body.querySelectorAll<HTMLElement>(".wx-chat-lightbox");
    expect(overlays).toHaveLength(1);
    expect(overlays[0]?.querySelector("img")?.src).toBe("https://example.test/second.jpg");
    lightbox.teardown();
  });

  it("restores focus to whatever was focused before opening", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const lightbox = mountLightbox();
    lightbox.open("https://example.test/a.jpg", "a");
    expect(document.activeElement).not.toBe(trigger);

    lightbox.close();
    expect(document.activeElement).toBe(trigger);
  });

  it("teardown closes an open lightbox and stops listening for Escape", () => {
    const lightbox = mountLightbox();
    lightbox.open("https://example.test/a.jpg", "a");
    lightbox.teardown();
    expect(document.body.querySelector(".wx-chat-lightbox")).toBeNull();

    // A stray Escape after teardown must not throw (no dangling listener
    // referencing a removed overlay).
    expect(() =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })),
    ).not.toThrow();
  });
});
