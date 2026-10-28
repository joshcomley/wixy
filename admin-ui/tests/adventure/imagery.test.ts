import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAP_STYLE,
  MAP_STYLES,
  fetchTexture,
  inlineLoader,
  isMapStyle,
  readMapStyle,
  textureSide,
  textureUrl,
  writeMapStyle,
} from "../../src/server/adventure/imagery";

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("map style", () => {
  it("defaults to satellite and knows its three styles", () => {
    expect(DEFAULT_MAP_STYLE).toBe("satellite");
    expect(MAP_STYLES).toEqual(["satellite", "atlas", "classic"]);
    expect(readMapStyle()).toBe("satellite");
  });

  it("round-trips a choice through this device's storage", () => {
    writeMapStyle("atlas");
    expect(readMapStyle()).toBe("atlas");
    writeMapStyle("classic");
    expect(readMapStyle()).toBe("classic");
  });

  it("ignores a garbled stored value", () => {
    window.localStorage.setItem("wixy.adventure.mapStyle", "hologram");
    expect(readMapStyle()).toBe("satellite");
    expect(isMapStyle("hologram")).toBe(false);
    expect(isMapStyle("atlas")).toBe(true);
  });

  it("never throws when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readMapStyle()).toBe("satellite");
    expect(() => writeMapStyle("atlas")).not.toThrow();
  });
});

describe("textureUrl", () => {
  it("falls back to the conventional static paths outside a bundle", () => {
    expect(textureUrl("satellite")).toBe("/admin/static/admin/adventure-satellite.webp");
    expect(textureUrl("atlas")).toBe("/admin/static/admin/adventure-atlas.webp");
  });
});

describe("textureSide", () => {
  it("never exceeds the file's 8192 or the device's texture limit", () => {
    expect(textureSide(16384, undefined)).toBe(8192);
    expect(textureSide(8192, 8)).toBe(8192);
    expect(textureSide(4096, 8)).toBe(4096);
    expect(textureSide(2048, 8)).toBe(2048);
  });

  it("halves it on a device that reports little memory", () => {
    expect(textureSide(16384, 2)).toBe(4096);
    expect(textureSide(16384, 1)).toBe(4096);
    expect(textureSide(16384, 4)).toBe(8192);
  });

  it("copes with an unknown limit and a silly one", () => {
    expect(textureSide(0, undefined)).toBe(4096);
    expect(textureSide(100, undefined)).toBe(1024);
  });
});

describe("loaders", () => {
  it("the default loader rejects on an HTTP error (the renderer then stays flat)", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 404 }));
    await expect(fetchTexture("satellite", 8192)).rejects.toThrow("HTTP 404");
  });

  it("requests the style's URL with same-origin credentials", async () => {
    const seen: unknown[] = [];
    vi.stubGlobal("fetch", async (url: unknown, init: unknown) => {
      seen.push(url, init);
      return { ok: false, status: 500 };
    });
    await expect(fetchTexture("atlas", 4096)).rejects.toThrow();
    expect(seen).toEqual(["/admin/static/admin/adventure-atlas.webp", { credentials: "same-origin" }]);
  });

  it("the inline loader rejects for a style it has no picture for", async () => {
    const loader = inlineLoader({ satellite: { base64: "", mime: "image/webp" } });
    await expect(loader("satellite", 8192)).rejects.toThrow("No inline picture");
    await expect(loader("atlas", 8192)).rejects.toThrow("No inline picture");
  });
});
