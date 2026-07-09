import { describe, expect, it } from "vitest";
import { parseOverlayToShellMessage, parseShellToOverlayMessage } from "../src/protocol";

describe("parseShellToOverlayMessage", () => {
  it("parses a valid init message", () => {
    const message = parseShellToOverlayMessage({
      wx: 1,
      type: "init",
      page: "index",
      bindings: { page: "index", fields: [{ key: "hero.title", kind: "text" }] },
      draftRev: 3,
    });
    expect(message).toEqual({
      wx: 1,
      type: "init",
      page: "index",
      bindings: { page: "index", fields: [{ key: "hero.title", kind: "text" }] },
      draftRev: 3,
    });
  });

  it("parses nested list bindings recursively", () => {
    const message = parseShellToOverlayMessage({
      wx: 1,
      type: "init",
      page: "index",
      bindings: {
        page: "index",
        fields: [
          {
            key: "showcase.items",
            kind: "list",
            items: [{ key: ".title", kind: "text" }],
          },
        ],
      },
      draftRev: 0,
    });
    expect(message?.type).toBe("init");
  });

  it("rejects init with a missing draftRev", () => {
    const message = parseShellToOverlayMessage({
      wx: 1,
      type: "init",
      page: "index",
      bindings: { page: "index", fields: [] },
    });
    expect(message).toBeNull();
  });

  it("parses applyOps with both set and discard ops", () => {
    const message = parseShellToOverlayMessage({
      wx: 1,
      type: "applyOps",
      ops: [
        { file: "index", path: "hero.title", value: "New" },
        { file: "index", path: "hero.tag", discard: true },
      ],
    });
    expect(message).toEqual({
      wx: 1,
      type: "applyOps",
      ops: [
        { file: "index", path: "hero.title", value: "New" },
        { file: "index", path: "hero.tag", discard: true },
      ],
    });
  });

  it("rejects an op missing both value and discard", () => {
    const message = parseShellToOverlayMessage({
      wx: 1,
      type: "applyOps",
      ops: [{ file: "index", path: "hero.title" }],
    });
    expect(message).toBeNull();
  });

  it("parses setDevice for each known device", () => {
    for (const device of ["desktop", "tablet", "mobile"]) {
      expect(parseShellToOverlayMessage({ wx: 1, type: "setDevice", device })).toEqual({
        wx: 1,
        type: "setDevice",
        device,
      });
    }
  });

  it("rejects setDevice with an unknown device string", () => {
    expect(
      parseShellToOverlayMessage({ wx: 1, type: "setDevice", device: "watch" }),
    ).toBeNull();
  });

  it("parses themeVars", () => {
    const message = parseShellToOverlayMessage({
      wx: 1,
      type: "themeVars",
      vars: { "--clay": "#B26E4A" },
    });
    expect(message).toEqual({ wx: 1, type: "themeVars", vars: { "--clay": "#B26E4A" } });
  });

  it("parses select", () => {
    expect(parseShellToOverlayMessage({ wx: 1, type: "select", key: "hero.title" })).toEqual({
      wx: 1,
      type: "select",
      key: "hero.title",
    });
  });

  it("returns null for a non-wx message", () => {
    expect(parseShellToOverlayMessage({ foo: "bar" })).toBeNull();
    expect(parseShellToOverlayMessage(null)).toBeNull();
    expect(parseShellToOverlayMessage("a string")).toBeNull();
    expect(parseShellToOverlayMessage({ wx: 2, type: "init" })).toBeNull();
  });

  it("returns null for an unknown type", () => {
    expect(parseShellToOverlayMessage({ wx: 1, type: "somethingElse" })).toBeNull();
  });
});

describe("parseOverlayToShellMessage", () => {
  it("parses ready", () => {
    expect(parseOverlayToShellMessage({ wx: 1, type: "ready" })).toEqual({
      wx: 1,
      type: "ready",
    });
  });

  it("parses op", () => {
    const message = parseOverlayToShellMessage({
      wx: 1,
      type: "op",
      file: "index",
      path: "hero.title",
      value: "Edited",
    });
    expect(message).toEqual({
      wx: 1,
      type: "op",
      file: "index",
      path: "hero.title",
      value: "Edited",
    });
  });

  it("parses op with a non-string JSON value (whole-array collection op)", () => {
    const message = parseOverlayToShellMessage({
      wx: 1,
      type: "op",
      file: "index",
      path: "treatments.cards",
      value: [{ title: "A" }, { title: "B" }],
    });
    expect(message?.type).toBe("op");
  });

  it("parses navigate", () => {
    expect(parseOverlayToShellMessage({ wx: 1, type: "navigate", page: "about" })).toEqual({
      wx: 1,
      type: "navigate",
      page: "about",
    });
  });

  it("parses selected with a rect", () => {
    const message = parseOverlayToShellMessage({
      wx: 1,
      type: "selected",
      key: "hero.title",
      kind: "text",
      rect: { x: 1, y: 2, width: 3, height: 4 },
    });
    expect(message).toEqual({
      wx: 1,
      type: "selected",
      key: "hero.title",
      kind: "text",
      rect: { x: 1, y: 2, width: 3, height: 4 },
    });
  });

  it("rejects selected with an unknown binding kind", () => {
    const message = parseOverlayToShellMessage({
      wx: 1,
      type: "selected",
      key: "hero.title",
      kind: "not-a-real-kind",
      rect: { x: 1, y: 2, width: 3, height: 4 },
    });
    expect(message).toBeNull();
  });

  it("rejects selected with an incomplete rect", () => {
    const message = parseOverlayToShellMessage({
      wx: 1,
      type: "selected",
      key: "hero.title",
      kind: "text",
      rect: { x: 1, y: 2 },
    });
    expect(message).toBeNull();
  });

  it("parses mediaRequest", () => {
    expect(parseOverlayToShellMessage({ wx: 1, type: "mediaRequest", key: "hero.bg" })).toEqual({
      wx: 1,
      type: "mediaRequest",
      key: "hero.bg",
    });
  });

  it("returns null for garbage input", () => {
    expect(parseOverlayToShellMessage(undefined)).toBeNull();
    expect(parseOverlayToShellMessage(42)).toBeNull();
    expect(parseOverlayToShellMessage({ wx: 1 })).toBeNull();
  });
});
