import { describe, expect, it, vi } from "vitest";
import type { AdminApi, GlobalSettings } from "../src/api";
import {
  addressToTextareaValue,
  deriveContactHref,
  deriveMapSrc,
  mountContactPanel,
  textareaValueToAddress,
} from "../src/contactPanel";
import type { OpQueueLike } from "../src/editView";
import type { DraftOp } from "../src/protocol";

function fakeApi(overrides: Partial<AdminApi> = {}): AdminApi {
  return {
    getState: vi.fn(),
    getServerVersion: vi.fn(),
    getContent: vi.fn(),
    patchDraft: vi.fn(),
    discardDraft: vi.fn(),
    getMedia: vi.fn(),
    uploadMedia: vi.fn(),
    deleteMedia: vi.fn(),
    getTheme: vi.fn(),
    getGlobalSettings: vi.fn(),
    getPublishPreview: vi.fn(),
    publish: vi.fn(),
    getPublishes: vi.fn(),
    restore: vi.fn(),
    duplicatePage: vi.fn(),
    deletePage: vi.fn(),
    createConversation: vi.fn(),
    getConversations: vi.fn(),
    sendMessage: vi.fn(),
    renameConversation: vi.fn(),
    getEngineStatus: vi.fn(),
    triggerEngineUpdate: vi.fn(),
    triggerEngineRollback: vi.fn(),
    getAiBudgetStatus: vi.fn(),
    getSystemStatus: vi.fn(),
    ...overrides,
  } as AdminApi;
}

function fakeOpQueue(): OpQueueLike & { enqueued: DraftOp[] } {
  return {
    rev: 0,
    enqueued: [],
    enqueue(op: DraftOp): void {
      this.enqueued.push(op);
    },
    flushNow: vi.fn(async () => {}),
  };
}

function fakeWindow(): Window {
  const target = new EventTarget();
  return {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    requestAnimationFrame: (cb: FrameRequestCallback): number => {
      cb(0);
      return 0;
    },
  } as unknown as Window;
}

function mountContact(win: Window, api: AdminApi, opQueue: OpQueueLike) {
  const panel = mountContactPanel({ win, api, opQueue });
  return { panel };
}

async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

const GLOBAL: GlobalSettings = {
  phone: "07401 562 462",
  phoneHref: "tel:07401562462",
  email: "hello@example.invalid",
  emailHref: "mailto:hello@example.invalid",
  address: "8 Walton Cottage, Walton Road,<br>Hartlebury, Kidderminster, DY10 4JA",
  mapCoords: "",
  mapSrc: "https://www.google.com/maps?q=8%20Walton%20Cottage%2C%20Walton%20Road%2C%20Hartlebury%2C%20Kidderminster%2C%20DY10%204JA&output=embed",
};

describe("addressToTextareaValue / textareaValueToAddress (decisions/00127)", () => {
  it("converts a stored <br> line break to a newline for display", () => {
    expect(addressToTextareaValue("8 Walton Cottage,<br>Hartlebury")).toBe(
      "8 Walton Cottage,\nHartlebury",
    );
  });

  it("is case- and whitespace-insensitive about the <br> tag, and handles self-closing form", () => {
    expect(addressToTextareaValue("Line one<BR>Line two<br />Line three")).toBe(
      "Line one\nLine two\nLine three",
    );
  });

  it("leaves a single-line address (no <br>) untouched", () => {
    expect(addressToTextareaValue("8 Walton Cottage")).toBe("8 Walton Cottage");
  });

  it("joins typed lines with <br> for storage", () => {
    expect(textareaValueToAddress("8 Walton Cottage,\nHartlebury")).toBe(
      "8 Walton Cottage,<br>Hartlebury",
    );
  });

  it("trims each line and drops blank lines (extra Enter presses don't produce empty <br> segments)", () => {
    expect(textareaValueToAddress("  8 Walton Cottage,  \n\nHartlebury\n")).toBe(
      "8 Walton Cottage,<br>Hartlebury",
    );
  });

  it("round-trips the real seeded address", () => {
    const stored = "8 Walton Cottage, Walton Road,<br>Hartlebury, Kidderminster, DY10 4JA";
    expect(textareaValueToAddress(addressToTextareaValue(stored))).toBe(stored);
  });
});

describe("deriveContactHref (decisions/00127) — the phone/email <-> phoneHref/emailHref derivation", () => {
  it("reproduces the real seeded _global.json pair byte-for-byte", () => {
    expect(deriveContactHref("tel", "07401 562 462")).toBe("tel:07401562462");
    expect(deriveContactHref("mailto", "cottageaestheticshartlebury@gmail.com")).toBe(
      "mailto:cottageaestheticshartlebury@gmail.com",
    );
  });

  it("strips phone formatting (spaces/dashes/parens) to bare digits", () => {
    expect(deriveContactHref("tel", "(01234) 567-890")).toBe("tel:01234567890");
  });

  it("preserves a genuine leading + (international dialing prefix)", () => {
    expect(deriveContactHref("tel", "+44 7401 562462")).toBe("tel:+447401562462");
  });

  it("a blank display value yields a blank href, not a bare scheme", () => {
    expect(deriveContactHref("tel", "")).toBe("");
    expect(deriveContactHref("mailto", "")).toBe("");
  });
});

describe("deriveMapSrc (decisions/00129) — the address/mapCoords -> mapSrc derivation", () => {
  it("a placed pin wins: derives a q=lat,lng embed URL, rounded to 6dp", () => {
    expect(deriveMapSrc("52.3794643,-2.2223154", "irrelevant address")).toBe(
      "https://www.google.com/maps?q=52.379464,-2.222315&output=embed",
    );
  });

  it("reproduces the real site's hard-coded map URL's query SEMANTICS (not byte-exact — see contactPanel.ts's comment)", () => {
    // The real _global.json address ends its first line with a trailing comma
    // right before the <br> ("Walton Road,<br>Hartlebury...") — each line's
    // own trailing comma is stripped before joining with ", " so the result
    // reads as one natural address, not "Walton Road,, Hartlebury" (a double
    // comma from naively replacing <br> with ", "). The one remaining
    // textual difference from the site's original hand-typed URL is that
    // this derivation keeps the address's own "Kidderminster, DY10 4JA"
    // comma (the original URL happened to drop it) and uses
    // `encodeURIComponent`'s %20/%2C rather than the original's `+`-for-
        // space style — both encode the identical target place; Google's `q=`
    // geocoder doesn't distinguish either difference.
    const realAddress = "8 Walton Cottage, Walton Road,<br>Hartlebury, Kidderminster, DY10 4JA";
    const derived = deriveMapSrc("", realAddress);
    expect(derived).toBe(
      "https://www.google.com/maps?q=8%20Walton%20Cottage%2C%20Walton%20Road%2C%20Hartlebury%2C%20Kidderminster%2C%20DY10%204JA&output=embed",
    );
    // The actual proof of "semantics", not just a fixed-string assertion:
    // decoding this derivation's q= param yields the same comma-delimited
    // parts (order and content) as the original hand-typed URL, modulo the
    // one documented comma difference.
    const decodedQuery = new URL(derived).searchParams.get("q") ?? ""; // .get() already decodes
    const originalQuery = "8 Walton Cottage, Walton Road, Hartlebury, Kidderminster DY10 4JA";
    expect(decodedQuery.replace(/,\s*/g, " ")).toBe(originalQuery.replace(/,\s*/g, " "));
  });

  it("a blank address with no pin yields an empty query rather than throwing", () => {
    expect(deriveMapSrc("", "")).toBe("https://www.google.com/maps?q=&output=embed");
  });

  it("malformed mapCoords falls back to the address (never produces a broken URL)", () => {
    expect(deriveMapSrc("not coordinates", "Somewhere")).toBe(
      "https://www.google.com/maps?q=Somewhere&output=embed",
    );
  });
});

describe("mountContactPanel", () => {
  it("shows a loading state before getGlobalSettings resolves", () => {
    const api = fakeApi({ getGlobalSettings: vi.fn(() => new Promise<GlobalSettings>(() => {})) });
    const { panel } = mountContact(fakeWindow(), api, fakeOpQueue());
    expect(panel.element.textContent).toContain("Loading");
  });

  it("renders phone/email/address once loaded — address shown as real newlines, not a literal <br>", async () => {
    const api = fakeApi({ getGlobalSettings: vi.fn(async () => GLOBAL) });
    const { panel } = mountContact(fakeWindow(), api, fakeOpQueue());
    await flushMicrotasks();

    // Scoped to the "Contact details" section specifically — the map section
    // below it ALSO uses `.wx-settings-input` (shared field styling) for its
    // own coordinates text field.
    const contactSection = panel.element.querySelector(".wx-settings-section");
    if (contactSection === null) throw new Error("no Contact details section");
    const inputs = contactSection.querySelectorAll<HTMLInputElement>(".wx-settings-input");
    const textareas = contactSection.querySelectorAll<HTMLTextAreaElement>(".wx-settings-textarea");
    expect(inputs).toHaveLength(2);
    expect(textareas).toHaveLength(1);
    expect(inputs[0]?.value).toBe("07401 562 462");
    expect(inputs[1]?.value).toBe("hello@example.invalid");
    expect(textareas[0]?.value).toBe("8 Walton Cottage, Walton Road,\nHartlebury, Kidderminster, DY10 4JA");
    expect(textareas[0]?.value).not.toContain("<br>");
  });

  it("the address field is labeled plainly, with a one-line-per-Enter hint (decisions/00129)", async () => {
    const api = fakeApi({ getGlobalSettings: vi.fn(async () => GLOBAL) });
    const { panel } = mountContact(fakeWindow(), api, fakeOpQueue());
    await flushMicrotasks();

    const labels = Array.from(panel.element.querySelectorAll<HTMLElement>(".wx-settings-row-label"));
    const addressLabel = labels.find((l) => l.textContent === "Address");
    expect(addressLabel).toBeDefined();
    const row = addressLabel?.closest(".wx-settings-row");
    const hint = row?.querySelector(".wx-settings-hint");
    expect(hint?.textContent).toBe(
      "Your address, exactly as it should appear on your site — press Enter to start a new line.",
    );
  });

  it("also renders the map section once loaded", async () => {
    const api = fakeApi({ getGlobalSettings: vi.fn(async () => GLOBAL) });
    const { panel } = mountContact(fakeWindow(), api, fakeOpQueue());
    await flushMicrotasks();
    expect(panel.element.querySelector(".wx-map-picker")).not.toBeNull();
  });

  it("a load error shows a message", async () => {
    const api = fakeApi({
      getGlobalSettings: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const { panel } = mountContact(fakeWindow(), api, fakeOpQueue());
    await flushMicrotasks();
    expect(panel.element.textContent).toContain("Couldn't load contact details: boom");
  });

  it("editing the phone field and blurring enqueues BOTH the display op and its derived phoneHref op", async () => {
    const api = fakeApi({ getGlobalSettings: vi.fn(async () => GLOBAL) });
    const opQueue = fakeOpQueue();
    const { panel } = mountContact(fakeWindow(), api, opQueue);
    await flushMicrotasks();

    const phoneInput = panel.element.querySelectorAll<HTMLInputElement>(".wx-settings-input")[0];
    if (phoneInput === undefined) throw new Error("no phone input");
    phoneInput.value = "01234 567890";
    phoneInput.dispatchEvent(new Event("change"));

    expect(opQueue.enqueued).toEqual([
      { file: "_global", path: "phone", value: "01234 567890" },
      { file: "_global", path: "phoneHref", value: "tel:01234567890" },
    ]);
  });

  it("editing the email field and blurring enqueues BOTH the display op and its derived emailHref op", async () => {
    const api = fakeApi({ getGlobalSettings: vi.fn(async () => GLOBAL) });
    const opQueue = fakeOpQueue();
    const { panel } = mountContact(fakeWindow(), api, opQueue);
    await flushMicrotasks();

    const emailInput = panel.element.querySelectorAll<HTMLInputElement>(".wx-settings-input")[1];
    if (emailInput === undefined) throw new Error("no email input");
    emailInput.value = "new@example.invalid";
    emailInput.dispatchEvent(new Event("change"));

    expect(opQueue.enqueued).toEqual([
      { file: "_global", path: "email", value: "new@example.invalid" },
      { file: "_global", path: "emailHref", value: "mailto:new@example.invalid" },
    ]);
  });

  it("editing the address while UNPINNED also re-derives and enqueues mapSrc", async () => {
    const api = fakeApi({ getGlobalSettings: vi.fn(async () => GLOBAL) }); // mapCoords: ""
    const opQueue = fakeOpQueue();
    const { panel } = mountContact(fakeWindow(), api, opQueue);
    await flushMicrotasks();

    const addressTextarea = panel.element.querySelector<HTMLTextAreaElement>(".wx-settings-textarea");
    if (addressTextarea === null) throw new Error("no address textarea");
    addressTextarea.value = "1 New Street\nSomewhere, AB1 2CD";
    addressTextarea.dispatchEvent(new Event("change"));

    expect(opQueue.enqueued).toEqual([
      { file: "_global", path: "address", value: "1 New Street<br>Somewhere, AB1 2CD" },
      {
        file: "_global",
        path: "mapSrc",
        value: "https://www.google.com/maps?q=1%20New%20Street%2C%20Somewhere%2C%20AB1%202CD&output=embed",
      },
    ]);
  });

  it("editing the address while PINNED does NOT touch mapSrc — a placed pin takes precedence", async () => {
    const pinned: GlobalSettings = { ...GLOBAL, mapCoords: "52.379464,-2.222315" };
    const api = fakeApi({ getGlobalSettings: vi.fn(async () => pinned) });
    const opQueue = fakeOpQueue();
    const { panel } = mountContact(fakeWindow(), api, opQueue);
    await flushMicrotasks();

    const addressTextarea = panel.element.querySelector<HTMLTextAreaElement>(".wx-settings-textarea");
    if (addressTextarea === null) throw new Error("no address textarea");
    addressTextarea.value = "A different address";
    addressTextarea.dispatchEvent(new Event("change"));

    expect(opQueue.enqueued).toEqual([
      { file: "_global", path: "address", value: "A different address" },
    ]);
  });

  it("clicking Reset on the address row discards address, mapCoords, AND mapSrc together, then reloads", async () => {
    const getGlobalSettings = vi
      .fn<() => Promise<GlobalSettings>>()
      .mockResolvedValueOnce(GLOBAL)
      .mockResolvedValueOnce(GLOBAL);
    const api = fakeApi({ getGlobalSettings });
    const opQueue = fakeOpQueue();
    const { panel } = mountContact(fakeWindow(), api, opQueue);
    await flushMicrotasks();

    const resetButtons = panel.element.querySelectorAll<HTMLButtonElement>(".wx-settings-link-button");
    // fields render in registry order: phone, email, address.
    resetButtons[2]?.click();

    expect(opQueue.enqueued).toEqual([
      { file: "_global", path: "address", discard: true },
      { file: "_global", path: "mapCoords", discard: true },
      { file: "_global", path: "mapSrc", discard: true },
    ]);
    await flushMicrotasks();
    expect(getGlobalSettings).toHaveBeenCalledTimes(2);
  });

  it("placing a pin (via the map picker) enqueues mapCoords AND its derived mapSrc together", async () => {
    const api = fakeApi({ getGlobalSettings: vi.fn(async () => GLOBAL) });
    const opQueue = fakeOpQueue();
    const { panel } = mountContact(fakeWindow(), api, opQueue);
    await flushMicrotasks();

    const coordsInput = panel.element.querySelector<HTMLInputElement>(".wx-map-coords-input");
    if (coordsInput === null) throw new Error("no coords input");
    coordsInput.value = "52.379464, -2.222315";
    coordsInput.dispatchEvent(new Event("change"));

    expect(opQueue.enqueued).toEqual([
      { file: "_global", path: "mapCoords", value: "52.379464,-2.222315" },
      {
        file: "_global",
        path: "mapSrc",
        value: "https://www.google.com/maps?q=52.379464,-2.222315&output=embed",
      },
    ]);
  });

  it("clearing a pin enqueues mapCoords=\"\" and a mapSrc re-derived from the CURRENT address", async () => {
    const pinned: GlobalSettings = { ...GLOBAL, mapCoords: "52.379464,-2.222315" };
    const api = fakeApi({ getGlobalSettings: vi.fn(async () => pinned) });
    const opQueue = fakeOpQueue();
    const { panel } = mountContact(fakeWindow(), api, opQueue);
    await flushMicrotasks();

    const clearButton = panel.element.querySelector<HTMLButtonElement>(".wx-map-clear-button");
    clearButton?.click();

    expect(opQueue.enqueued).toEqual([
      { file: "_global", path: "mapCoords", value: "" },
      {
        file: "_global",
        path: "mapSrc",
        value:
          "https://www.google.com/maps?q=8%20Walton%20Cottage%2C%20Walton%20Road%2C%20Hartlebury%2C%20Kidderminster%2C%20DY10%204JA&output=embed",
      },
    ]);
  });

  it("\"Reset map to published\" discards mapCoords + mapSrc (not address) and reloads", async () => {
    const pinned: GlobalSettings = { ...GLOBAL, mapCoords: "52.379464,-2.222315" };
    const getGlobalSettings = vi
      .fn<() => Promise<GlobalSettings>>()
      .mockResolvedValueOnce(pinned)
      .mockResolvedValueOnce(pinned);
    const api = fakeApi({ getGlobalSettings });
    const opQueue = fakeOpQueue();
    const { panel } = mountContact(fakeWindow(), api, opQueue);
    await flushMicrotasks();

    const mapReset = Array.from(
      panel.element.querySelectorAll<HTMLButtonElement>(".wx-settings-link-button"),
    ).find((b) => b.textContent === "Reset map to published");
    mapReset?.click();

    expect(opQueue.enqueued).toEqual([
      { file: "_global", path: "mapCoords", discard: true },
      { file: "_global", path: "mapSrc", discard: true },
    ]);
    await flushMicrotasks();
    expect(getGlobalSettings).toHaveBeenCalledTimes(2);
  });

  it("teardown tears down the mounted map picker too", async () => {
    const api = fakeApi({ getGlobalSettings: vi.fn(async () => GLOBAL) });
    const win = fakeWindow();
    const removeSpy = vi.spyOn(win, "removeEventListener");
    const { panel } = mountContact(win, api, fakeOpQueue());
    await flushMicrotasks();
    panel.teardown();
    // The map picker's own Escape-key listener is the one thing it tears down.
    expect(removeSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
  });
});
