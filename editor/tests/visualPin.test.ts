import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureResizesContentMeta, pinToVisualViewport } from "../src/visualPin";
import { installFakeVisualViewport, uninstallFakeVisualViewport } from "./fakeVisualViewport";

afterEach(() => {
  uninstallFakeVisualViewport();
  document.body.innerHTML = "";
  document.head.querySelectorAll('meta[name="viewport"]').forEach((m) => m.remove());
});

describe("pinToVisualViewport (decisions/00084)", () => {
  it("pins the element to the visual viewport's bottom edge (keyboard shrunk the viewport)", () => {
    installFakeVisualViewport({ width: 390, height: 500 });
    const el = document.createElement("div");
    document.body.appendChild(el);
    const pin = pinToVisualViewport(el, window);
    expect(pin.active).toBe(true);
    expect(el.style.bottom).toBe(`${window.innerHeight - 500}px`);
    expect(el.style.left).toBe("0px");
    expect(el.style.width).toBe("390px");
  });

  it("re-pins on visualViewport scroll (pinch-zoom panning the layout viewport)", () => {
    const vv = installFakeVisualViewport({ width: 390, height: 500 });
    const el = document.createElement("div");
    document.body.appendChild(el);
    pinToVisualViewport(el, window);
    vv.offsetTop = 120;
    vv.offsetLeft = 30;
    vv.fire("scroll");
    expect(el.style.bottom).toBe(`${window.innerHeight - 500 - 120}px`);
    expect(el.style.left).toBe("30px");
  });

  it("re-pins on visualViewport resize (keyboard opening/closing)", () => {
    const vv = installFakeVisualViewport({ width: 390, height: 500 });
    const el = document.createElement("div");
    document.body.appendChild(el);
    pinToVisualViewport(el, window);
    vv.height = 700;
    vv.fire("resize");
    expect(el.style.bottom).toBe(`${window.innerHeight - 700}px`);
  });

  it("never pins below the layout bottom (offset arithmetic can't go negative)", () => {
    const vv = installFakeVisualViewport({ width: 390, height: 500 });
    const el = document.createElement("div");
    document.body.appendChild(el);
    pinToVisualViewport(el, window);
    vv.height = window.innerHeight + 200; // taller than layout — transient mid-gesture state
    vv.fire("resize");
    expect(el.style.bottom).toBe("0px");
  });

  it("scales the pinned width by widthScale (composer counter-scale for device simulation)", () => {
    installFakeVisualViewport({ width: 400, height: 700 });
    const el = document.createElement("div");
    document.body.appendChild(el);
    pinToVisualViewport(el, window, { widthScale: () => 0.5 });
    expect(el.style.width).toBe("200px");
  });

  it("fires onUpdate after every pin update (composer re-fits its textarea after a rewrap)", () => {
    const vv = installFakeVisualViewport({ width: 390, height: 500 });
    const onUpdate = vi.fn();
    const el = document.createElement("div");
    document.body.appendChild(el);
    pinToVisualViewport(el, window, { onUpdate });
    expect(onUpdate).toHaveBeenCalledTimes(1); // the initial pin
    vv.fire("resize");
    expect(onUpdate).toHaveBeenCalledTimes(2);
  });

  it("release() removes the listeners and restores the element's prior inline styles", () => {
    const vv = installFakeVisualViewport({ width: 390, height: 500 });
    const el = document.createElement("div");
    el.style.bottom = "7px";
    document.body.appendChild(el);
    const pin = pinToVisualViewport(el, window);
    expect(el.style.bottom).not.toBe("7px");
    pin.release();
    expect(el.style.bottom).toBe("7px");
    expect(el.style.left).toBe("");
    vv.height = 700;
    vv.fire("resize");
    expect(el.style.bottom).toBe("7px"); // untouched after release
  });

  it("is an inert no-op without a visualViewport (older browsers, jsdom default)", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const pin = pinToVisualViewport(el, window);
    expect(pin.active).toBe(false);
    expect(() => {
      pin.update();
      pin.release();
    }).not.toThrow();
    expect(el.style.bottom).toBe("");
  });
});

describe("ensureResizesContentMeta (decisions/00084)", () => {
  it("appends interactive-widget=resizes-content to an existing viewport meta", () => {
    const meta = document.createElement("meta");
    meta.name = "viewport";
    meta.content = "width=device-width, initial-scale=1";
    document.head.appendChild(meta);
    ensureResizesContentMeta(document);
    expect(meta.content).toBe("width=device-width, initial-scale=1, interactive-widget=resizes-content");
  });

  it("is idempotent", () => {
    const meta = document.createElement("meta");
    meta.name = "viewport";
    meta.content = "width=device-width";
    document.head.appendChild(meta);
    ensureResizesContentMeta(document);
    ensureResizesContentMeta(document);
    expect(meta.content.match(/interactive-widget/g)).toHaveLength(1);
  });

  it("leaves an explicit interactive-widget setting alone", () => {
    const meta = document.createElement("meta");
    meta.name = "viewport";
    meta.content = "width=device-width, interactive-widget=resizes-visual";
    document.head.appendChild(meta);
    ensureResizesContentMeta(document);
    expect(meta.content).toBe("width=device-width, interactive-widget=resizes-visual");
  });

  it("no viewport meta → no-op (every site page has one, but a broken page mustn't crash the overlay)", () => {
    expect(() => ensureResizesContentMeta(document)).not.toThrow();
  });
});
