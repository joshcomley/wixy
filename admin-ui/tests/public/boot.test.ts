import { describe, expect, it } from "vitest";
import { BOOT_ELEMENT_ID, ROOT_ELEMENT_ID, parseBoot, readBoot } from "../../src/public/boot";
import { isCode, parseRoute, placePath, placeUrl } from "../../src/public/route";

const ORIGIN = "https://adventure.cinnamons.uk";
const GOOD = { code: "abcdef", origin: ORIGIN, assets: { world: "/assets/world.json?v=1", satellite: "/assets/sat.webp?v=2", atlas: `${ORIGIN}/assets/atlas.webp?v=3` } };

describe("boot data", () => {
  it("reads the documented shape", () => {
    expect(parseBoot(JSON.stringify(GOOD), "http://x")).toEqual({
      code: "abcdef",
      origin: ORIGIN,
      assets: { world: "/assets/world.json?v=1", satellite: "/assets/sat.webp?v=2", atlas: `${ORIGIN}/assets/atlas.webp?v=3` },
    });
    expect(parseBoot(JSON.stringify({ ...GOOD, code: null }), "http://x")?.code).toBeNull();
    expect(BOOT_ELEMENT_ID).toBe("adventure-public-boot");
    expect(ROOT_ELEMENT_ID).toBe("adventure-public-root");
  });

  it("is null for anything unusable: not JSON, no assets, a missing asset", () => {
    expect(parseBoot("not json", ORIGIN)).toBeNull();
    expect(parseBoot("[]", ORIGIN)).toBeNull();
    expect(parseBoot(JSON.stringify({ code: null, origin: ORIGIN }), ORIGIN)).toBeNull();
    expect(parseBoot(JSON.stringify({ ...GOOD, assets: { world: "/w", satellite: "/s" } }), ORIGIN)).toBeNull();
  });

  it("refuses an asset that leaves the site: another host, a protocol-relative or odd URL", () => {
    for (const bad of ["https://evil.example/w.json", "//evil.example/w.json", "javascript:alert(1)", "data:text/plain,x", "/a\\b", "", 7]) {
      expect(parseBoot(JSON.stringify({ ...GOOD, assets: { ...GOOD.assets, world: bad } }), ORIGIN), String(bad)).toBeNull();
    }
  });

  it("falls back to the page's own origin when the boot one is not a URL, and ignores a non-string or empty code", () => {
    const boot = parseBoot(JSON.stringify({ ...GOOD, origin: "nonsense", code: 5, assets: { world: "/w", satellite: "/s", atlas: "/a" } }), "https://fallback.example");
    expect(boot?.origin).toBe("https://fallback.example");
    expect(boot?.code).toBeNull();
    expect(parseBoot(JSON.stringify({ ...GOOD, code: "" }), ORIGIN)?.code).toBeNull();
  });

  it("is read from the page's JSON script element", () => {
    document.body.innerHTML = `<script type="application/json" id="${BOOT_ELEMENT_ID}">${JSON.stringify(GOOD)}</script>`;
    expect(readBoot(document, ORIGIN)?.code).toBe("abcdef");
    document.body.innerHTML = `<script type="application/json" id="${BOOT_ELEMENT_ID}">  </script>`;
    expect(readBoot(document, ORIGIN)).toBeNull();
    document.body.innerHTML = "";
    expect(readBoot(document, ORIGIN)).toBeNull();
  });
});

describe("routes", () => {
  it("/ is a fresh game, /d/<code> is a place (6 characters, 8 when two collided)", () => {
    expect(parseRoute("/")).toEqual({ kind: "home" });
    expect(parseRoute("/d/abcdef")).toEqual({ kind: "place", code: "abcdef" });
    expect(parseRoute("/d/abcdefgh")).toEqual({ kind: "place", code: "abcdefgh" });
    expect(parseRoute("/d/a2b3c4")).toEqual({ kind: "place", code: "a2b3c4" });
  });

  it("is code-shaped exactly as the server is (lower case, the 32-character alphabet, 6 to 40 long)", () => {
    expect(isCode("abcdef")).toBe(true);
    expect(isCode("a".repeat(40))).toBe(true);
    for (const bad of ["", "abcde", "a".repeat(41), "ABCDEF", "abcdel", "abcdeo", "abc0ef", "abc1ef", "abc-ef", "abc def", "abcdé1"]) {
      expect(isCode(bad), bad).toBe(false);
    }
  });

  it("a /d/ address that is not exactly a code is the not-on-the-map page, never a fresh game", () => {
    for (const path of ["/d/ABCDEF", "/d/abcdef/", "/d/abc", "/d/abcdef/extra", "/d/abc def", "/d/abcdef0123456789abcdef0123456789abcdef0123", "/d/abcdel", "/d/"]) {
      expect(parseRoute(path), path).toEqual({ kind: "missing" });
    }
  });

  it("anything else is the home page", () => {
    for (const path of ["", "/d", "/x/abcdef", "/dabcdef", "/D/abcdef", "/index.html"]) {
      expect(parseRoute(path), path).toEqual({ kind: "home" });
    }
  });

  it("builds the path and the absolute short link", () => {
    expect(placePath("abcdef")).toBe("/d/abcdef");
    expect(placeUrl(ORIGIN, "abcdef")).toBe("https://adventure.cinnamons.uk/d/abcdef");
  });
});
