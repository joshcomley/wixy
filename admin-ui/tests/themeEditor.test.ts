import { describe, expect, it } from "vitest";
import {
  CONTRAST_PAIRS,
  initThemeEditor,
  PALETTE,
  PALETTE_KEYS,
  readDefaultColors,
  type CustomTheme,
} from "../src/themeEditor";
import type { ThemeMode, ThemeVariant } from "../src/theme";

const TEST_CSS = `
:root {
  --wx-brand-blue: #2563eb;
  --wx-brand-blue-text: #2563eb;
  --wx-brand-blue-tint: #eaf0fe;
  --wx-ink: #1e2430;
  --wx-muted: #616a7e;
  --wx-surface: #f3f5f9;
  --wx-canvas: #eaedf3;
  --wx-border: #dde2ea;
  --wx-danger: #b91c1c;
  --wx-danger-text: #b91c1c;
  --wx-danger-tint: #fef2f2;
  --wx-solid-dark: #1e2430;
  --wx-solid-dark-text: #e2e6ec;
}
:root[data-theme="dark"] {
  --wx-brand-blue: #3f6fcf;
  --wx-brand-blue-text: #6fa0f5;
  --wx-brand-blue-tint: #1e2a47;
  --wx-ink: #e4e7ed;
  --wx-muted: #9199aa;
  --wx-surface: #1a1d26;
  --wx-canvas: #14161d;
  --wx-border: #2d3140;
  --wx-danger: #cf3a3a;
  --wx-danger-text: #f87171;
  --wx-danger-tint: #3a1e1e;
  --wx-solid-dark: #0d0f14;
  --wx-solid-dark-text: #e2e6ec;
}
`;

function withStylesheet<T>(css: string, run: (doc: Document) => T): T {
  const styleEl = document.createElement("style");
  styleEl.textContent = css;
  document.head.appendChild(styleEl);
  try {
    return run(document);
  } finally {
    styleEl.remove();
  }
}

function fakeStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  } as Storage;
}

function fakeWindow(opts: { storage?: Storage } = {}): Window {
  return { localStorage: opts.storage ?? fakeStorage() } as unknown as Window;
}

interface FakeThemeController {
  getMode: () => ThemeMode;
  subscribe: (listener: (mode: ThemeMode, variant: ThemeVariant) => void) => () => void;
  fire: (mode: ThemeMode, variant: ThemeVariant) => void;
}

function fakeThemeController(initialMode: ThemeMode = "light"): FakeThemeController {
  let mode = initialMode;
  const listeners = new Set<(mode: ThemeMode, variant: ThemeVariant) => void>();
  return {
    getMode: () => mode,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    fire: (next, variant) => {
      mode = next;
      listeners.forEach((l) => l(next, variant));
    },
  };
}

describe("PALETTE", () => {
  it("every entry's key is unique and matches PALETTE_KEYS", () => {
    expect(new Set(PALETTE_KEYS).size).toBe(PALETTE_KEYS.length);
    expect(PALETTE.map((p) => p.key)).toEqual([...PALETTE_KEYS]);
  });
});

describe("CONTRAST_PAIRS", () => {
  it("every pair's fg/bg reference a real palette key (or the fixed 'white')", () => {
    for (const pair of CONTRAST_PAIRS) {
      if (pair.fg !== "white") expect(PALETTE_KEYS).toContain(pair.fg);
      expect(PALETTE_KEYS).toContain(pair.bg);
    }
  });

  it("exactly the 4 genuine body-text pairs are flagged isBodyText (the save-time WCAG gate)", () => {
    const bodyTextIds = CONTRAST_PAIRS.filter((p) => p.isBodyText).map((p) => p.id);
    expect(bodyTextIds.sort()).toEqual(["ink-canvas", "ink-surface", "muted-canvas", "muted-surface"].sort());
  });
});

describe("readDefaultColors", () => {
  it("reads every palette key's light and dark value from the loaded stylesheet's :root rules", () => {
    withStylesheet(TEST_CSS, (doc) => {
      const defaults = readDefaultColors(doc);
      expect(defaults.light["wx-ink"]).toBe("#1e2430");
      expect(defaults.dark["wx-ink"]).toBe("#e4e7ed");
      expect(defaults.light["wx-surface"]).toBe("#f3f5f9");
      expect(defaults.dark["wx-surface"]).toBe("#1a1d26");
    });
  });

  it("a key absent from the stylesheet is simply absent from the result, not a crash", () => {
    withStylesheet(":root { --wx-ink: #111111; }", (doc) => {
      const defaults = readDefaultColors(doc);
      expect(defaults.light["wx-ink"]).toBe("#111111");
      expect(defaults.light["wx-surface"]).toBeUndefined();
      expect(defaults.dark["wx-ink"]).toBeUndefined();
    });
  });

  it("returns empty theme when no matching rules exist at all", () => {
    withStylesheet("body { color: red; }", (doc) => {
      const defaults = readDefaultColors(doc);
      expect(defaults).toEqual({ light: {}, dark: {} });
    });
  });
});

describe("initThemeEditor", () => {
  it("getEffective falls back to the stylesheet default for every un-customized key", () => {
    withStylesheet(TEST_CSS, (doc) => {
      const editor = initThemeEditor(fakeThemeController("light"), fakeWindow(), doc);
      expect(editor.getEffective("light")["wx-ink"]).toBe("#1e2430");
      expect(editor.getEffective("dark")["wx-ink"]).toBe("#e4e7ed");
    });
  });

  it("applies any already-persisted custom theme immediately on construction", () => {
    withStylesheet(TEST_CSS, (doc) => {
      const storage = fakeStorage();
      storage.setItem("wx-custom-theme", JSON.stringify({ light: { "wx-ink": "#ff0000" }, dark: {} }));
      initThemeEditor(fakeThemeController("light"), fakeWindow({ storage }), doc);
      expect(doc.documentElement.style.getPropertyValue("--wx-ink")).toBe("#ff0000");
    });
  });

  it("setColor updates the draft and live-applies only for the CURRENTLY resolved variant", () => {
    withStylesheet(TEST_CSS, (doc) => {
      const editor = initThemeEditor(fakeThemeController("light"), fakeWindow(), doc);

      editor.setColor("light", "wx-ink", "#ff0000");
      expect(editor.getEffective("light")["wx-ink"]).toBe("#ff0000");
      expect(doc.documentElement.style.getPropertyValue("--wx-ink")).toBe("#ff0000");

      // editing the INACTIVE variant updates its draft but must not touch the
      // live DOM, which is still showing "light"
      editor.setColor("dark", "wx-ink", "#00ff00");
      expect(editor.getEffective("dark")["wx-ink"]).toBe("#00ff00");
      expect(doc.documentElement.style.getPropertyValue("--wx-ink")).toBe("#ff0000");
    });
  });

  it("reapplies the right variant's colors when the theme controller reports a variant change", () => {
    withStylesheet(TEST_CSS, (doc) => {
      const theme = fakeThemeController("light");
      const editor = initThemeEditor(theme, fakeWindow(), doc);
      editor.setColor("dark", "wx-ink", "#00ff00");

      theme.fire("dark", "dark");

      expect(doc.documentElement.style.getPropertyValue("--wx-ink")).toBe("#00ff00");
    });
  });

  it("isDirty reflects unsaved changes and clears after save", () => {
    withStylesheet(TEST_CSS, (doc) => {
      const editor = initThemeEditor(fakeThemeController("light"), fakeWindow(), doc);
      expect(editor.isDirty()).toBe(false);

      editor.setColor("light", "wx-ink", "#ff0000");
      expect(editor.isDirty()).toBe(true);

      editor.save();
      expect(editor.isDirty()).toBe(false);
    });
  });

  it("save persists the draft so a fresh editor sharing the same storage picks it up", () => {
    withStylesheet(TEST_CSS, (doc) => {
      const storage = fakeStorage();
      const editor1 = initThemeEditor(fakeThemeController("light"), fakeWindow({ storage }), doc);
      editor1.setColor("light", "wx-ink", "#ff0000");
      editor1.save();

      const editor2 = initThemeEditor(fakeThemeController("light"), fakeWindow({ storage }), doc);
      expect(editor2.getEffective("light")["wx-ink"]).toBe("#ff0000");
      expect(editor2.isDirty()).toBe(false);
    });
  });

  it("discardDraft reverts unsaved edits back to the last-saved state and re-applies live", () => {
    withStylesheet(TEST_CSS, (doc) => {
      const editor = initThemeEditor(fakeThemeController("light"), fakeWindow(), doc);
      editor.setColor("light", "wx-ink", "#ff0000");
      editor.save();
      editor.setColor("light", "wx-ink", "#00ff00"); // unsaved

      editor.discardDraft();

      expect(editor.getEffective("light")["wx-ink"]).toBe("#ff0000");
      expect(doc.documentElement.style.getPropertyValue("--wx-ink")).toBe("#ff0000");
      expect(editor.isDirty()).toBe(false);
    });
  });

  it("resetVariant clears both the draft AND persisted state for that variant only, and persists immediately (no Save needed)", () => {
    withStylesheet(TEST_CSS, (doc) => {
      const storage = fakeStorage();
      const editor = initThemeEditor(fakeThemeController("light"), fakeWindow({ storage }), doc);
      editor.setColor("light", "wx-ink", "#ff0000");
      editor.setColor("dark", "wx-ink", "#00ff00");
      editor.save();

      editor.resetVariant("light");

      expect(editor.getEffective("light")["wx-ink"]).toBe("#1e2430"); // back to shipped default
      expect(editor.getEffective("dark")["wx-ink"]).toBe("#00ff00"); // untouched
      expect(doc.documentElement.style.getPropertyValue("--wx-ink")).toBe("#1e2430");

      // persisted immediately, without a separate save() call
      const editor2 = initThemeEditor(fakeThemeController("light"), fakeWindow({ storage }), doc);
      expect(editor2.getEffective("light")["wx-ink"]).toBe("#1e2430");
      expect(editor2.getEffective("dark")["wx-ink"]).toBe("#00ff00");
    });
  });

  describe("exportJson / importJson", () => {
    it("round-trips through export then import into a fresh editor", () => {
      withStylesheet(TEST_CSS, (doc) => {
        const editor1 = initThemeEditor(fakeThemeController("light"), fakeWindow(), doc);
        editor1.setColor("light", "wx-ink", "#123456");
        editor1.setColor("dark", "wx-brand-blue", "#654321");
        const exported = editor1.exportJson();

        const editor2 = initThemeEditor(fakeThemeController("light"), fakeWindow(), doc);
        const result = editor2.importJson(exported);

        expect(result).toEqual({ ok: true });
        expect(editor2.getEffective("light")["wx-ink"]).toBe("#123456");
        expect(editor2.getEffective("dark")["wx-brand-blue"]).toBe("#654321");
      });
    });

    it("rejects invalid JSON with a specific message", () => {
      withStylesheet(TEST_CSS, (doc) => {
        const editor = initThemeEditor(fakeThemeController("light"), fakeWindow(), doc);
        const result = editor.importJson("not json{{{");
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.message).toBe("That's not valid JSON.");
      });
    });

    it("rejects well-formed JSON with no recognizable colors", () => {
      withStylesheet(TEST_CSS, (doc) => {
        const editor = initThemeEditor(fakeThemeController("light"), fakeWindow(), doc);
        const result = editor.importJson(JSON.stringify({ light: { notAColor: 5 }, dark: {} }));
        expect(result.ok).toBe(false);
      });
    });

    it("silently drops unrecognized keys and invalid hex values rather than importing them", () => {
      withStylesheet(TEST_CSS, (doc) => {
        const editor = initThemeEditor(fakeThemeController("light"), fakeWindow(), doc);
        const malformed: CustomTheme = { light: { "wx-ink": "#123456" }, dark: {} };
        const payload = { ...malformed, light: { ...malformed.light, "not-a-key": "#000000", "wx-muted": "not-a-hex" } };
        const result = editor.importJson(JSON.stringify(payload));
        expect(result).toEqual({ ok: true });
        expect(editor.getEffective("light")["wx-ink"]).toBe("#123456");
        expect(editor.getEffective("light")["wx-muted"]).toBe("#616a7e"); // fell back to default, "not-a-hex" was dropped
      });
    });
  });

  describe("subscribe", () => {
    it("fires on setColor, resetVariant, save, discardDraft, and importJson", () => {
      withStylesheet(TEST_CSS, (doc) => {
        const editor = initThemeEditor(fakeThemeController("light"), fakeWindow(), doc);
        let calls = 0;
        editor.subscribe(() => (calls += 1));

        editor.setColor("light", "wx-ink", "#ff0000");
        editor.save();
        editor.resetVariant("light");
        editor.setColor("light", "wx-ink", "#00ff00");
        editor.discardDraft();
        editor.importJson(JSON.stringify({ light: { "wx-ink": "#111111" }, dark: {} }));

        expect(calls).toBe(6);
      });
    });

    it("unsubscribe stops further notifications to that listener only", () => {
      withStylesheet(TEST_CSS, (doc) => {
        const editor = initThemeEditor(fakeThemeController("light"), fakeWindow(), doc);
        let a = 0;
        let b = 0;
        const unsubA = editor.subscribe(() => (a += 1));
        editor.subscribe(() => (b += 1));

        editor.setColor("light", "wx-ink", "#ff0000");
        unsubA();
        editor.setColor("light", "wx-ink", "#00ff00");

        expect(a).toBe(1);
        expect(b).toBe(2);
      });
    });
  });

  it("teardown stops reacting to further theme-controller variant changes", () => {
    withStylesheet(TEST_CSS, (doc) => {
      const theme = fakeThemeController("light");
      const editor = initThemeEditor(theme, fakeWindow(), doc);
      editor.setColor("dark", "wx-ink", "#00ff00");
      editor.teardown();

      theme.fire("dark", "dark");

      // still showing light's value - teardown means "stop listening", not "revert"
      expect(doc.documentElement.style.getPropertyValue("--wx-ink")).toBe("#1e2430");
    });
  });
});
