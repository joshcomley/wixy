// jsdom-side coverage for the aligner dialog's WIRING (control states,
// toggles, save gating, cancel semantics, the plain-English failure path).
// jsdom has no canvas (`getContext` → null — the dialog guards painting on
// that) and never fires `img.onload`, so image loading is stubbed through the
// injectable `loadImage` dep; the real paint/gesture/bake path is E2E
// territory (`section-panel.spec.ts`), the same split sectionPanel keeps.

import { describe, expect, it, vi } from "vitest";
import type { AdminApi } from "../src/api";
import {
  alignedUploadName,
  mountAlignerDialog,
  type AlignerRequest,
  type LoadedImage,
} from "../src/alignerDialog";

const REQUEST: AlignerRequest = {
  first: { key: "before", label: "Before photo", src: "images/aaa111bb-lips-before.jpg", alt: "Before" },
  second: { key: "after", label: "After photo", src: "images/ccc222dd-lips-after.jpg", alt: "After" },
  aspectW: 640,
  aspectH: 360,
};

function fakeLoaded(width: number, height: number): LoadedImage {
  return { width, height, source: null as unknown as CanvasImageSource };
}

function fakeApi(overrides: Partial<AdminApi> = {}): AdminApi {
  return { uploadMedia: vi.fn(), ...overrides } as unknown as AdminApi;
}

function fakeWindow(): Window {
  const target = new EventTarget();
  return {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    devicePixelRatio: 1,
  } as unknown as Window;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function mountLoaded(overrides: {
  api?: AdminApi;
  onDone?: (result: unknown) => void;
  loadImage?: (src: string) => Promise<LoadedImage>;
} = {}) {
  const onDone = overrides.onDone ?? vi.fn();
  const api = overrides.api ?? fakeApi();
  const loadImage = overrides.loadImage ?? (async () => fakeLoaded(1600, 1200));
  const dialog = mountAlignerDialog(
    { api, win: fakeWindow(), loadImage },
    REQUEST,
    { onDone },
  );
  document.body.appendChild(dialog.element);
  return { dialog, onDone, api };
}

function padButton(element: HTMLElement, ariaLabel: string): HTMLButtonElement {
  const button = element.querySelector<HTMLButtonElement>(`button[aria-label="${ariaLabel}"]`);
  if (button === null) throw new Error(`no pad button ${ariaLabel}`);
  return button;
}

function tap(button: HTMLButtonElement): void {
  button.dispatchEvent(new Event("pointerdown"));
  button.dispatchEvent(new Event("pointerup"));
}

describe("alignedUploadName", () => {
  it("strips the pipeline's hash8 prefix and keeps the human stem", () => {
    expect(alignedUploadName("images/aaa111bb-lips-before.jpg")).toBe("lips-before-aligned.jpg");
    expect(alignedUploadName("/admin/draft-media/ccc222dd-lips-after.jpg")).toBe(
      "lips-after-aligned.jpg",
    );
  });

  it("leaves a repo filename (no hash prefix) alone apart from the suffix", () => {
    expect(alignedUploadName("images/hero.jpg")).toBe("hero-aligned.jpg");
  });
});

describe("mountAlignerDialog", () => {
  it("renders the full chrome with Save disabled until photos load AND something is adjusted", async () => {
    const { dialog } = mountLoaded();
    const save = dialog.element.querySelector<HTMLButtonElement>(".wx-publish-button");
    expect(dialog.element.querySelector("h3")?.textContent).toBe("Line up the photos");
    expect(dialog.element.querySelector(".wx-align-canvas-note")?.textContent).toContain("Loading");
    expect(save?.disabled).toBe(true);

    await flush();

    // Photos loaded, but nothing adjusted yet — Save stays disabled.
    expect(dialog.element.querySelector<HTMLElement>(".wx-align-canvas-note")?.hidden).toBe(true);
    expect(save?.disabled).toBe(true);
    dialog.teardown();
  });

  it("a micro-pad nudge enables Save; Start over puts it back", async () => {
    const { dialog } = mountLoaded();
    await flush();
    const save = dialog.element.querySelector<HTMLButtonElement>(".wx-publish-button");

    tap(padButton(dialog.element, "Nudge down"));
    expect(save?.disabled).toBe(false);

    const startOver = Array.from(dialog.element.querySelectorAll("button")).find(
      (b) => b.textContent === "Start over",
    );
    startOver?.click();
    expect(save?.disabled).toBe(true);
    dialog.teardown();
  });

  it("the Move toggle switches which side the controls drive (and defaults to the second/after)", async () => {
    const { dialog } = mountLoaded();
    await flush();
    const segButtons = Array.from(
      dialog.element.querySelectorAll<HTMLButtonElement>(".wx-align-seg-button"),
    );
    const afterButton = segButtons.find((b) => b.textContent === "After photo");
    const beforeButton = segButtons.find((b) => b.textContent === "Before photo");
    expect(afterButton?.classList.contains("wx-align-seg-button-active")).toBe(true);

    beforeButton?.click();
    expect(beforeButton?.classList.contains("wx-align-seg-button-active")).toBe(true);
    expect(afterButton?.classList.contains("wx-align-seg-button-active")).toBe(false);

    // Nudging now moves the BEFORE side — tilt readout proves the active side
    // switched: tilt the before, then switch back to after (untouched: 0°).
    tap(padButton(dialog.element, "Tilt clockwise"));
    expect(dialog.element.querySelector(".wx-align-tilt-readout")?.textContent).toBe("0.25°");
    afterButton?.click();
    expect(dialog.element.querySelector(".wx-align-tilt-readout")?.textContent).toBe("0°");
    beforeButton?.click();
    expect(dialog.element.querySelector(".wx-align-tilt-readout")?.textContent).toBe("0.25°");
    dialog.teardown();
  });

  it("tilt at zoom 1 visibly happens (auto-zoom compensation), not a dead button", async () => {
    const { dialog } = mountLoaded();
    await flush();
    tap(padButton(dialog.element, "Tilt clockwise"));
    const readout = dialog.element.querySelector(".wx-align-tilt-readout")?.textContent;
    expect(readout).toBe("0.25°");
    // The zoom slider paid for it — its value is above 1 now.
    const zoomSlider = dialog.element.querySelector<HTMLInputElement>(
      'input[aria-label="Zoom"]',
    );
    expect(Number(zoomSlider?.value)).toBeGreaterThan(1);
    dialog.teardown();
  });

  it("the View toggle swaps which slider row is visible (Blend vs Split)", async () => {
    const { dialog } = mountLoaded();
    await flush();
    const rows = Array.from(dialog.element.querySelectorAll<HTMLElement>(".wx-align-row"));
    const rowFor = (label: string): HTMLElement | undefined =>
      rows.find((r) => r.querySelector(".wx-align-row-label")?.textContent === label);
    expect(rowFor("See-through")?.hidden).toBe(false);
    expect(rowFor("Compare")?.hidden).toBe(true);

    const splitButton = Array.from(
      dialog.element.querySelectorAll<HTMLButtonElement>(".wx-align-seg-button"),
    ).find((b) => b.textContent === "Split");
    splitButton?.click();
    expect(rowFor("See-through")?.hidden).toBe(true);
    expect(rowFor("Compare")?.hidden).toBe(false);
    dialog.teardown();
  });

  it("Cancel responds null exactly once", async () => {
    const { dialog, onDone } = mountLoaded();
    await flush();
    const cancel = Array.from(dialog.element.querySelectorAll("button")).find(
      (b) => b.textContent === "Cancel",
    );
    cancel?.click();
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith(null);
    dialog.teardown();
  });

  it("a failed photo load keeps Save disabled and says so in plain English", async () => {
    const { dialog } = mountLoaded({
      loadImage: async (src) => {
        if (src.includes("after")) throw new Error("nope");
        return fakeLoaded(1600, 1200);
      },
    });
    await flush();
    expect(dialog.element.querySelector(".wx-align-canvas-note")?.textContent).toContain(
      "couldn't be loaded",
    );
    const save = dialog.element.querySelector<HTMLButtonElement>(".wx-publish-button");
    expect(save?.disabled).toBe(true);
    dialog.teardown();
  });

  it("Save with no canvas (jsdom) shows the calm error and keeps originals untouched", async () => {
    const api = fakeApi();
    const { dialog, onDone } = mountLoaded({ api });
    await flush();
    tap(padButton(dialog.element, "Nudge down")); // make it dirty so Save arms
    const save = dialog.element.querySelector<HTMLButtonElement>(".wx-publish-button");
    save?.click();
    await flush();

    // jsdom's canvas.getContext returns null, so the bake fails — the dialog
    // must surface the plain-English error, NOT respond, NOT upload.
    const error = dialog.element.querySelector<HTMLElement>(".wx-align-error");
    expect(error?.hidden).toBe(false);
    expect(error?.textContent).toContain("Couldn't save the aligned photo");
    expect(error?.textContent).toContain("original photos are untouched");
    expect(api.uploadMedia).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    // And Save recovered from the busy state for another attempt.
    expect(save?.textContent).toBe("Save aligned photo");
    dialog.teardown();
  });
});
