import { describe, expect, it, vi } from "vitest";
import { captureScreenshot, copyBlobToClipboard, downloadBlob, flashScreen, screenshotFilename } from "../src/screenshot";

describe("screenshotFilename", () => {
  it("formats a stable, sortable timestamped filename", () => {
    const date = new Date(2026, 6, 11, 9, 5, 3); // 2026-07-11 09:05:03 local
    expect(screenshotFilename(date)).toBe("wixy-admin-20260711-090503.png");
  });

  it("zero-pads every component", () => {
    const date = new Date(2026, 0, 2, 1, 2, 3); // 2026-01-02 01:02:03
    expect(screenshotFilename(date)).toBe("wixy-admin-20260102-010203.png");
  });

  it("defaults to the current time when no date is passed", () => {
    expect(screenshotFilename()).toMatch(/^wixy-admin-\d{8}-\d{6}\.png$/);
  });
});

describe("downloadBlob", () => {
  it("creates, clicks, and removes a temporary anchor with an object URL", () => {
    const doc = document;
    const blob = new Blob(["fake"], { type: "image/png" });
    const clickSpy = vi.fn();
    const originalCreateElement = doc.createElement.bind(doc);
    const createSpy = vi.spyOn(doc, "createElement").mockImplementation((tag: string) => {
      const el = originalCreateElement(tag);
      if (tag === "a") el.click = clickSpy;
      return el;
    });
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    downloadBlob(blob, "test.png", doc);

    expect(clickSpy).toHaveBeenCalledOnce();
    expect(revokeSpy).toHaveBeenCalledOnce();
    expect(doc.body.querySelector("a[download='test.png']")).toBeNull(); // removed after click

    createSpy.mockRestore();
    revokeSpy.mockRestore();
  });
});

describe("flashScreen", () => {
  it("mounts a flash overlay, fades it, then removes it", async () => {
    vi.useFakeTimers();
    try {
      flashScreen(document);
      expect(document.querySelector(".wx-screenshot-flash")).not.toBeNull();

      // requestAnimationFrame callback + the removal timeout
      await vi.advanceTimersByTimeAsync(250);
      expect(document.querySelector(".wx-screenshot-flash")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

function fakeWindowWithMediaDevices(getDisplayMedia?: (opts: unknown) => Promise<MediaStream>): Window {
  return {
    navigator: {
      mediaDevices: getDisplayMedia === undefined ? undefined : { getDisplayMedia },
    },
    document,
  } as unknown as Window;
}

describe("captureScreenshot", () => {
  it("reports unsupported when the browser has no getDisplayMedia", async () => {
    const win = fakeWindowWithMediaDevices(undefined);
    const outcome = await captureScreenshot(win);
    expect(outcome).toEqual({
      ok: false,
      reason: "unsupported",
      message: "Screenshot capture isn't supported in this browser.",
    });
  });

  it("reports denied when the user cancels or rejects the picker", async () => {
    const win = fakeWindowWithMediaDevices(() => Promise.reject(new Error("NotAllowedError")));
    const outcome = await captureScreenshot(win);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("denied");
  });

  it("reports capture-failed when the stream has no video tracks", async () => {
    const fakeStream = {
      getVideoTracks: () => [],
      getTracks: () => [],
    } as unknown as MediaStream;
    const win = fakeWindowWithMediaDevices(() => Promise.resolve(fakeStream));
    const outcome = await captureScreenshot(win);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("capture-failed");
  });

  it("stops every track even when capture fails partway through", async () => {
    const stopSpy = vi.fn();
    const fakeStream = {
      getVideoTracks: () => [{}], // non-empty, so it proceeds past the track check
      getTracks: () => [{ stop: stopSpy }],
    } as unknown as MediaStream;
    const win = fakeWindowWithMediaDevices(() => Promise.resolve(fakeStream));

    // jsdom doesn't implement HTMLMediaElement.play() (real browser verification
    // covers the genuine frame-grab — see decisions/00048) — stub just enough of
    // a <video> for grabFrame to proceed past it and reach canvas.getContext,
    // which jsdom also doesn't implement (returns null without the optional
    // `canvas` package), so this always resolves to a "capture-failed" outcome.
    // That's fine: the point here is verifying stream cleanup still runs.
    const originalCreateElement = document.createElement.bind(document);
    const createSpy = vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag !== "video") return originalCreateElement(tag);
      return {
        play: () => Promise.resolve(),
        pause: () => {},
        readyState: 2,
        videoWidth: 10,
        videoHeight: 10,
        srcObject: null,
        addEventListener: () => {},
      } as unknown as HTMLVideoElement;
    });

    const outcome = await captureScreenshot(win);
    createSpy.mockRestore();

    expect(stopSpy).toHaveBeenCalledOnce();
    expect(outcome.ok).toBe(false);
  });
});

function fakeWindowWithClipboard(write?: (items: unknown[]) => Promise<void>): Window {
  return {
    navigator: {
      clipboard: write === undefined ? undefined : { write },
    },
  } as unknown as Window;
}

/** jsdom has no global `ClipboardItem` constructor — stub one so tests can
 * reach past `new ClipboardItem(...)` and actually exercise `clipboard.write`
 * (without this, every case would return false for the SAME reason — the
 * constructor throwing — masking whether the write call itself was ever
 * reached). */
function withClipboardItemStub<T>(run: () => Promise<T>): Promise<T> {
  vi.stubGlobal(
    "ClipboardItem",
    class {
      constructor(_items: Record<string, Blob>) {}
    },
  );
  return run().finally(() => vi.unstubAllGlobals());
}

describe("copyBlobToClipboard", () => {
  it("returns false when the Clipboard API is unavailable", async () => {
    const win = fakeWindowWithClipboard(undefined);
    expect(await copyBlobToClipboard(new Blob(["x"]), win)).toBe(false);
  });

  it("returns true on a successful write", async () => {
    const win = fakeWindowWithClipboard(() => Promise.resolve());
    const result = await withClipboardItemStub(() => copyBlobToClipboard(new Blob(["x"], { type: "image/png" }), win));
    expect(result).toBe(true);
  });

  it("returns false (not a throw) when the write is rejected", async () => {
    const win = fakeWindowWithClipboard(() => Promise.reject(new Error("denied")));
    const result = await withClipboardItemStub(() => copyBlobToClipboard(new Blob(["x"]), win));
    expect(result).toBe(false);
  });

  it("returns false (not a throw) when ClipboardItem itself is unavailable", async () => {
    const win = fakeWindowWithClipboard(() => Promise.resolve());
    expect(await copyBlobToClipboard(new Blob(["x"]), win)).toBe(false);
  });
});
