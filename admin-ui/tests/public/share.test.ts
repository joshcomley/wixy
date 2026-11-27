import { afterEach, describe, expect, it, vi } from "vitest";
import { canNativeShare, copyText, nativeShare, type ShareTarget } from "../../src/server/adventure/shareLink";

const TARGET: ShareTarget = { url: "https://adventure.cinnamons.uk/d/abcdef", title: "Alpha", text: "Alpha, Aland" };

afterEach(() => {
  Reflect.deleteProperty(window.navigator, "clipboard");
  Reflect.deleteProperty(window.navigator, "share");
  Reflect.deleteProperty(document, "execCommand");
  document.body.replaceChildren();
});

describe("copyText", () => {
  it("uses the Clipboard API when there is one", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
    expect(await copyText(window, document, "hello")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to a throwaway textarea and the copy command, and cleans it up", async () => {
    let selected = "";
    Object.defineProperty(document, "execCommand", {
      value: (command: string) => {
        selected = (document.querySelector("textarea") as HTMLTextAreaElement).value;
        return command === "copy";
      },
      configurable: true,
    });
    expect(await copyText(window, document, "hello")).toBe(true);
    expect(selected).toBe("hello");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("falls back when the Clipboard API refuses", async () => {
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText: async () => Promise.reject(new Error("denied")) }, configurable: true });
    Object.defineProperty(document, "execCommand", { value: () => true, configurable: true });
    expect(await copyText(window, document, "x")).toBe(true);
  });

  it("is false (never a throw) when nothing can copy", async () => {
    expect(await copyText(window, document, "x")).toBe(false);
    Object.defineProperty(document, "execCommand", { value: () => { throw new Error("no"); }, configurable: true });
    expect(await copyText(window, document, "x")).toBe(false);
    expect(document.querySelector("textarea")).toBeNull();
  });
});

describe("native share", () => {
  it("is only offered where the browser has navigator.share", () => {
    expect(canNativeShare(window)).toBe(false);
    Object.defineProperty(window.navigator, "share", { value: async () => {}, configurable: true });
    expect(canNativeShare(window)).toBe(true);
  });

  it("shares the title, text and link", async () => {
    const share = vi.fn(async () => {});
    Object.defineProperty(window.navigator, "share", { value: share, configurable: true });
    expect(await nativeShare(window, TARGET)).toBe("shared");
    expect(share).toHaveBeenCalledWith({ title: "Alpha", text: "Alpha, Aland", url: TARGET.url });
  });

  it("closing the sheet is cancelled, any other failure is failed, and no support is failed", async () => {
    expect(await nativeShare(window, TARGET)).toBe("failed");
    Object.defineProperty(window.navigator, "share", { value: vi.fn().mockRejectedValueOnce(new DOMException("closed", "AbortError")).mockRejectedValueOnce(new TypeError("bad")), configurable: true });
    expect(await nativeShare(window, TARGET)).toBe("cancelled");
    expect(await nativeShare(window, TARGET)).toBe("failed");
  });
});
