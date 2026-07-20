import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  type AdminApi,
  type AiBudgetStatus,
  type EngineStatus,
  type SystemStatus,
} from "../src/api";
import { initFontScale } from "../src/fontScale";
import { mountSettingsPanel } from "../src/settingsPanel";
import { initShortcuts, type ShortcutCommand } from "../src/shortcuts";
import { initTheme } from "../src/theme";
import { initThemeEditor } from "../src/themeEditor";
import { initZoom } from "../src/zoom";

function fakeApi(overrides: Partial<AdminApi> = {}): AdminApi {
  return {
    getState: vi.fn(),
    getServerCommit: vi.fn(),
    getContent: vi.fn(),
    patchDraft: vi.fn(),
    discardDraft: vi.fn(),
    getMedia: vi.fn(),
    uploadMedia: vi.fn(),
    deleteMedia: vi.fn(),
    getTheme: vi.fn(),
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

const ENGINE_STATUS: EngineStatus = {
  engineRepo: "acme/wixy-engine",
  currentSha: "a".repeat(40),
  commitsBehind: 2,
  changelog: [
    { sha: "abc123", subject: "feat: thing", author: "Jane", when: "2026-07-18T10:00:00Z" },
  ],
  checkedAt: 1000,
  stale: true,
  checkError: null,
  updateRun: null,
};

const AI_BUDGET_STATUS: AiBudgetStatus = {
  monthToDateUsd: 8.25,
  monthlyBudgetUsd: 40,
};

const SYSTEM_STATUS: SystemStatus = {
  backup: {
    lastAttemptAt: "2026-07-20T03:00:00Z",
    ok: true,
    verified: true,
    error: null,
    stale: false,
  },
  diskUsage: { totalBytes: 25 * 1024 * 1024 * 1024, usedBytes: 2 * 1024 * 1024 * 1024, freeBytes: 23 * 1024 * 1024 * 1024 },
  lastPublish: { version: 5, when: "2026-07-19T12:00:00Z" },
  engine: { currentSha: "a".repeat(40), edition: "standalone" },
};

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

function fakeMediaQueryList(matches: boolean): MediaQueryList {
  return {
    matches,
    media: "(prefers-color-scheme: dark)",
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as MediaQueryList;
}

function fakeWindow(opts: { storage?: Storage; confirmReturns?: boolean } = {}): Window {
  const storage = opts.storage ?? fakeStorage();
  const target = new EventTarget();
  return {
    localStorage: storage,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    matchMedia: () => fakeMediaQueryList(false),
    confirm: () => opts.confirmReturns ?? true,
  } as unknown as Window;
}

function keydown(win: Window, init: KeyboardEventInit): void {
  win.dispatchEvent(new KeyboardEvent("keydown", { cancelable: true, ...init }));
}

const TEST_COMMANDS: ShortcutCommand[] = [
  {
    id: "zoom.in",
    category: "Zoom",
    label: "Zoom in",
    defaultBinding: { ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, code: "Equal" },
    run: () => {},
  },
  {
    id: "zoom.out",
    category: "Zoom",
    label: "Zoom out",
    defaultBinding: { ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, code: "Minus" },
    run: () => {},
  },
  {
    id: "font.up",
    category: "Font Size",
    label: "Increase font size",
    defaultBinding: { ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, code: "Equal" },
    run: () => {},
  },
];

function mountGeneral(win: Window, onResetAll: () => void = vi.fn()) {
  const themeController = initTheme(win);
  const zoomController = initZoom(win);
  const fontScaleController = initFontScale(win);
  const shortcutsController = initShortcuts(TEST_COMMANDS, win);
  const themeEditorController = initThemeEditor(themeController, win);
  const onNavigate = vi.fn();
  const panel = mountSettingsPanel({
    win,
    page: "general",
    api: fakeApi(),
    themeController,
    zoomController,
    fontScaleController,
    shortcutsController,
    themeEditorController,
    onNavigate,
    onResetAll,
  });
  return { panel, themeController, zoomController, fontScaleController, shortcutsController, onNavigate };
}

function mountShortcuts(win: Window) {
  const themeController = initTheme(win);
  const zoomController = initZoom(win);
  const fontScaleController = initFontScale(win);
  const shortcutsController = initShortcuts(TEST_COMMANDS, win);
  const themeEditorController = initThemeEditor(themeController, win);
  const onNavigate = vi.fn();
  const panel = mountSettingsPanel({
    win,
    page: "shortcuts",
    api: fakeApi(),
    themeController,
    zoomController,
    fontScaleController,
    shortcutsController,
    themeEditorController,
    onNavigate,
    onResetAll: vi.fn(),
  });
  return { panel, shortcutsController, onNavigate };
}

function mountAppearance(win: Window, doc: Document) {
  const themeController = initTheme(win, doc);
  const zoomController = initZoom(win, doc);
  const fontScaleController = initFontScale(win, doc);
  const shortcutsController = initShortcuts(TEST_COMMANDS, win);
  const themeEditorController = initThemeEditor(themeController, win, doc);
  const onNavigate = vi.fn();
  const onResetAll = vi.fn();
  const panel = mountSettingsPanel({
    win,
    page: "appearance",
    api: fakeApi(),
    themeController,
    zoomController,
    fontScaleController,
    shortcutsController,
    themeEditorController,
    onNavigate,
    onResetAll,
  });
  return { panel, themeController, themeEditorController, onNavigate, onResetAll };
}

function mountEngine(win: Window, api: AdminApi) {
  const themeController = initTheme(win);
  const zoomController = initZoom(win);
  const fontScaleController = initFontScale(win);
  const shortcutsController = initShortcuts(TEST_COMMANDS, win);
  const themeEditorController = initThemeEditor(themeController, win);
  const panel = mountSettingsPanel({
    win,
    page: "engine",
    api,
    themeController,
    zoomController,
    fontScaleController,
    shortcutsController,
    themeEditorController,
    onNavigate: vi.fn(),
    onResetAll: vi.fn(),
  });
  return { panel };
}

function mountAi(win: Window, api: AdminApi) {
  const themeController = initTheme(win);
  const zoomController = initZoom(win);
  const fontScaleController = initFontScale(win);
  const shortcutsController = initShortcuts(TEST_COMMANDS, win);
  const themeEditorController = initThemeEditor(themeController, win);
  const panel = mountSettingsPanel({
    win,
    page: "ai",
    api,
    themeController,
    zoomController,
    fontScaleController,
    shortcutsController,
    themeEditorController,
    onNavigate: vi.fn(),
    onResetAll: vi.fn(),
  });
  return { panel };
}

function mountSystem(win: Window, api: AdminApi) {
  const themeController = initTheme(win);
  const zoomController = initZoom(win);
  const fontScaleController = initFontScale(win);
  const shortcutsController = initShortcuts(TEST_COMMANDS, win);
  const themeEditorController = initThemeEditor(themeController, win);
  const panel = mountSettingsPanel({
    win,
    page: "system",
    api,
    themeController,
    zoomController,
    fontScaleController,
    shortcutsController,
    themeEditorController,
    onNavigate: vi.fn(),
    onResetAll: vi.fn(),
  });
  return { panel };
}

describe("mountSettingsPanel — General", () => {
  it("shows the current theme mode, zoom, and font-scale values", () => {
    const win = fakeWindow();
    const { panel } = mountGeneral(win);
    expect(panel.element.textContent).toContain("System");
    expect(panel.element.querySelector(".wx-settings-stepper-value")?.textContent).toBe("100%");
  });

  it("clicking a theme button changes the mode and re-renders the active state", () => {
    const win = fakeWindow();
    const { panel, themeController } = mountGeneral(win);
    const darkButton = Array.from(panel.element.querySelectorAll("button")).find((b) => b.textContent === "Dark")!;
    darkButton.click();
    expect(themeController.getMode()).toBe("dark");
    expect(darkButton.classList.contains("wx-settings-button-active")).toBe(true);
  });

  it("clicking zoom +/- updates the controller and the displayed value", () => {
    const win = fakeWindow();
    const { panel, zoomController } = mountGeneral(win);
    const zoomValue = panel.element.querySelectorAll(".wx-settings-stepper-value")[0]!;
    const plusButton = Array.from(panel.element.querySelectorAll("button")).find((b) => b.textContent === "+")!;
    plusButton.click();
    expect(zoomController.getLevel()).toBe(110);
    expect(zoomValue.textContent).toBe("110%");
  });

  it("clicking font-size A+/A- updates the controller and the displayed value", () => {
    const win = fakeWindow();
    const { panel, fontScaleController } = mountGeneral(win);
    const fontValue = panel.element.querySelectorAll(".wx-settings-stepper-value")[1]!;
    const upButton = Array.from(panel.element.querySelectorAll("button")).find((b) => b.textContent === "A+")!;
    upButton.click();
    expect(fontScaleController.getLevel()).toBe(110);
    expect(fontValue.textContent).toBe("110%");
  });

  it("reflects a zoom change made from OUTSIDE the panel (e.g. the topbar) via subscribe", () => {
    const win = fakeWindow();
    const { panel, zoomController } = mountGeneral(win);
    zoomController.zoomIn(); // simulates the topbar's own button, not this panel's
    const zoomValue = panel.element.querySelectorAll(".wx-settings-stepper-value")[0]!;
    expect(zoomValue.textContent).toBe("110%");
  });

  it("Reset all settings asks for confirmation and calls onResetAll only if confirmed", () => {
    const winConfirmed = fakeWindow({ confirmReturns: true });
    const onResetAllYes = vi.fn();
    const { panel: panelYes } = mountGeneral(winConfirmed, onResetAllYes);
    panelYes.element.querySelector<HTMLButtonElement>(".wx-settings-reset-all")!.click();
    expect(onResetAllYes).toHaveBeenCalledOnce();

    const winDeclined = fakeWindow({ confirmReturns: false });
    const onResetAllNo = vi.fn();
    const { panel: panelNo } = mountGeneral(winDeclined, onResetAllNo);
    panelNo.element.querySelector<HTMLButtonElement>(".wx-settings-reset-all")!.click();
    expect(onResetAllNo).not.toHaveBeenCalled();
  });

  it("clicking the Keyboard Shortcuts tab calls onNavigate", () => {
    const win = fakeWindow();
    const { panel, onNavigate } = mountGeneral(win);
    const shortcutsTab = Array.from(panel.element.querySelectorAll("button")).find(
      (b) => b.textContent === "Keyboard Shortcuts",
    )!;
    shortcutsTab.click();
    expect(onNavigate).toHaveBeenCalledWith("shortcuts");
  });

  it("teardown does not throw and unsubscribes from all controllers", () => {
    const win = fakeWindow();
    const { panel, zoomController } = mountGeneral(win);
    expect(() => panel.teardown()).not.toThrow();
    expect(() => zoomController.zoomIn()).not.toThrow();
  });

  it("the 'open the theme editor' link navigates to appearance", () => {
    const win = fakeWindow();
    const { panel, onNavigate } = mountGeneral(win);
    const link = panel.element.querySelector<HTMLButtonElement>(".wx-settings-link-button")!;
    link.click();
    expect(onNavigate).toHaveBeenCalledWith("appearance");
  });
});

describe("mountSettingsPanel — Appearance", () => {
  it("shows the resolved (light) variant's colors by default", () => {
    withStylesheet(TEST_CSS, (doc) => {
      const { panel } = mountAppearance(fakeWindow(), doc);
      const hexInputs = Array.from(panel.element.querySelectorAll<HTMLInputElement>(".wx-settings-color-hex"));
      expect(hexInputs.map((i) => i.value)).toContain("#1e2430"); // light wx-ink
    });
  });

  it("switching to Dark shows dark values instead", () => {
    withStylesheet(TEST_CSS, (doc) => {
      const { panel } = mountAppearance(fakeWindow(), doc);
      const darkTab = Array.from(panel.element.querySelectorAll("button")).find((b) => b.textContent === "Dark")!;
      darkTab.click();
      const hexInputs = Array.from(panel.element.querySelectorAll<HTMLInputElement>(".wx-settings-color-hex"));
      expect(hexInputs.map((i) => i.value)).toContain("#e4e7ed"); // dark wx-ink
    });
  });

  it("editing a color live-applies to the document for the active variant", () => {
    withStylesheet(TEST_CSS, (doc) => {
      const { panel } = mountAppearance(fakeWindow(), doc);
      const inkRow = Array.from(panel.element.querySelectorAll(".wx-settings-color-row")).find((r) =>
        r.textContent?.includes("Primary text"),
      )!;
      const hexInput = inkRow.querySelector<HTMLInputElement>(".wx-settings-color-hex")!;
      hexInput.value = "#ff00ff";
      hexInput.dispatchEvent(new Event("input"));

      expect(doc.documentElement.style.getPropertyValue("--wx-ink")).toBe("#ff00ff");
    });
  });

  it("editing the INACTIVE variant does not touch the live document", () => {
    withStylesheet(TEST_CSS, (doc) => {
      const { panel } = mountAppearance(fakeWindow(), doc); // resolves to light
      const darkTab = Array.from(panel.element.querySelectorAll("button")).find((b) => b.textContent === "Dark")!;
      darkTab.click(); // now editing dark, but resolved variant is still light

      const inkRow = Array.from(panel.element.querySelectorAll(".wx-settings-color-row")).find((r) =>
        r.textContent?.includes("Primary text"),
      )!;
      const hexInput = inkRow.querySelector<HTMLInputElement>(".wx-settings-color-hex")!;
      hexInput.value = "#ff00ff";
      hexInput.dispatchEvent(new Event("input"));

      expect(doc.documentElement.style.getPropertyValue("--wx-ink")).toBe("#1e2430");
    });
  });

  it("shows a contrast ratio and AA badge for the ink/surface pair", () => {
    withStylesheet(TEST_CSS, (doc) => {
      const { panel } = mountAppearance(fakeWindow(), doc);
      const row = Array.from(panel.element.querySelectorAll(".wx-settings-contrast-row")).find((r) =>
        r.textContent?.includes("Body text on surface"),
      )!;
      expect(row.querySelector(".wx-settings-contrast-ratio")?.textContent).toBe("14.25:1");
      expect(row.querySelector(".wx-settings-contrast-pass")).not.toBeNull();
    });
  });

  it("Save persists the draft; a fresh mount sharing storage picks it up", () => {
    withStylesheet(TEST_CSS, (doc) => {
      const storage = fakeStorage();
      const { panel } = mountAppearance(fakeWindow({ storage }), doc);
      const inkRow = Array.from(panel.element.querySelectorAll(".wx-settings-color-row")).find((r) =>
        r.textContent?.includes("Primary text"),
      )!;
      inkRow.querySelector<HTMLInputElement>(".wx-settings-color-hex")!.value = "#123456";
      inkRow.querySelector<HTMLInputElement>(".wx-settings-color-hex")!.dispatchEvent(new Event("input"));

      panel.element.querySelector<HTMLButtonElement>(".wx-settings-save-button")!.click();

      const { themeEditorController: editor2 } = mountAppearance(fakeWindow({ storage }), doc);
      expect(editor2.getEffective("light")["wx-ink"]).toBe("#123456");
    });
  });

  it("blocks Save behind a WCAG-AA warning when a body-text pair would fail, until 'Save anyway'", () => {
    withStylesheet(TEST_CSS, (doc) => {
      const storage = fakeStorage();
      const { panel } = mountAppearance(fakeWindow({ storage }), doc);
      const surfaceRow = Array.from(panel.element.querySelectorAll(".wx-settings-color-row")).find((r) =>
        r.textContent?.includes("Surface (cards"),
      )!;
      // make ink/surface fail AA by turning the surface white-on-white-ish text
      surfaceRow.querySelector<HTMLInputElement>(".wx-settings-color-hex")!.value = "#1f2530"; // near-identical to ink
      surfaceRow.querySelector<HTMLInputElement>(".wx-settings-color-hex")!.dispatchEvent(new Event("input"));

      const saveButton = panel.element.querySelector<HTMLButtonElement>(".wx-settings-save-button")!;
      saveButton.click();

      const warning = panel.element.querySelector(".wx-settings-theme-warning") as HTMLElement;
      expect(warning.hidden).toBe(false);
      expect(warning.textContent).toContain("WCAG AA");

      // not persisted yet
      const { themeEditorController: editorAfterBlockedSave } = mountAppearance(fakeWindow({ storage }), doc);
      expect(editorAfterBlockedSave.isDirty()).toBe(false); // nothing was saved, so a fresh load has no draft either
      expect(editorAfterBlockedSave.getEffective("light")["wx-surface"]).toBe("#f3f5f9"); // still the shipped default

      const saveAnywayButton = panel.element.querySelector<HTMLButtonElement>(".wx-settings-reset-all")!; // first .wx-settings-reset-all in this tab is "Save anyway"
      expect(saveAnywayButton.textContent).toBe("Save anyway");
      saveAnywayButton.click();

      const { themeEditorController: editorAfterForcedSave } = mountAppearance(fakeWindow({ storage }), doc);
      expect(editorAfterForcedSave.getEffective("light")["wx-surface"]).toBe("#1f2530");
    });
  });

  it("Reset this variant to defaults asks for confirmation and restores the shipped palette", () => {
    withStylesheet(TEST_CSS, (doc) => {
      const win = fakeWindow({ confirmReturns: true });
      const { panel, themeEditorController } = mountAppearance(win, doc);
      themeEditorController.setColor("light", "wx-ink", "#123456");

      const resetButtons = panel.element.querySelectorAll<HTMLButtonElement>(".wx-settings-reset-all");
      const resetVariantButton = Array.from(resetButtons).find((b) => b.textContent?.includes("Reset light theme"))!;
      resetVariantButton.click();

      expect(themeEditorController.getEffective("light")["wx-ink"]).toBe("#1e2430");
    });
  });

  it("Discard unsaved changes reverts to the last-saved state", () => {
    withStylesheet(TEST_CSS, (doc) => {
      const { panel, themeEditorController } = mountAppearance(fakeWindow(), doc);
      themeEditorController.setColor("light", "wx-ink", "#123456");
      themeEditorController.save();
      themeEditorController.setColor("light", "wx-ink", "#654321");

      const discardButton = Array.from(panel.element.querySelectorAll("button")).find(
        (b) => b.textContent === "Discard unsaved changes",
      )!;
      discardButton.click();

      expect(themeEditorController.getEffective("light")["wx-ink"]).toBe("#123456");
    });
  });

  it("Export then Import round-trips a custom color into a fresh panel", () => {
    withStylesheet(TEST_CSS, (doc) => {
      const { panel, themeEditorController } = mountAppearance(fakeWindow(), doc);
      themeEditorController.setColor("light", "wx-ink", "#123456");

      const exportButton = Array.from(panel.element.querySelectorAll("button")).find((b) => b.textContent === "Export…")!;
      exportButton.click();
      const exportArea = panel.element.querySelector<HTMLTextAreaElement>(".wx-settings-theme-textarea")!;
      const exported = exportArea.value;
      expect(exported).toContain("#123456");

      const { panel: panel2, themeEditorController: editor2 } = mountAppearance(fakeWindow(), doc);
      const importButton = Array.from(panel2.element.querySelectorAll("button")).find((b) => b.textContent === "Import…")!;
      importButton.click();
      const importArea = panel2.element.querySelectorAll<HTMLTextAreaElement>(".wx-settings-theme-textarea")[1]!;
      importArea.value = exported;
      const applyButton = Array.from(panel2.element.querySelectorAll("button")).find((b) => b.textContent === "Apply")!;
      applyButton.click();

      expect(editor2.getEffective("light")["wx-ink"]).toBe("#123456");
    });
  });

  it("Import shows an inline error for invalid JSON without throwing", () => {
    withStylesheet(TEST_CSS, (doc) => {
      const { panel } = mountAppearance(fakeWindow(), doc);
      const importButton = Array.from(panel.element.querySelectorAll("button")).find((b) => b.textContent === "Import…")!;
      importButton.click();
      const importArea = panel.element.querySelectorAll<HTMLTextAreaElement>(".wx-settings-theme-textarea")[1]!;
      importArea.value = "not json{{{";
      const applyButton = Array.from(panel.element.querySelectorAll("button")).find((b) => b.textContent === "Apply")!;
      expect(() => applyButton.click()).not.toThrow();
      expect(panel.element.querySelector(".wx-settings-shortcut-error")?.textContent).toBe("That's not valid JSON.");
    });
  });

  it("navigating to General/Shortcuts tabs calls onNavigate", () => {
    withStylesheet(TEST_CSS, (doc) => {
      const { panel, onNavigate } = mountAppearance(fakeWindow(), doc);
      const generalTab = Array.from(panel.element.querySelectorAll("button")).find((b) => b.textContent === "General")!;
      generalTab.click();
      expect(onNavigate).toHaveBeenCalledWith("general");
    });
  });

  it("teardown does not throw", () => {
    withStylesheet(TEST_CSS, (doc) => {
      const { panel } = mountAppearance(fakeWindow(), doc);
      expect(() => panel.teardown()).not.toThrow();
    });
  });
});

describe("mountSettingsPanel — Keyboard Shortcuts", () => {
  it("lists every command grouped by category with its formatted default binding", () => {
    const win = fakeWindow();
    const { panel } = mountShortcuts(win);
    expect(panel.element.textContent).toContain("Zoom");
    expect(panel.element.textContent).toContain("Font Size");
    expect(panel.element.textContent).toContain("Zoom in");
    expect(panel.element.textContent).toContain("Ctrl + =");
  });

  it("General tab is reachable via onNavigate", () => {
    const win = fakeWindow();
    const { panel, onNavigate } = mountShortcuts(win);
    const generalTab = Array.from(panel.element.querySelectorAll("button")).find((b) => b.textContent === "General")!;
    generalTab.click();
    expect(onNavigate).toHaveBeenCalledWith("general");
  });

  it("Disable then Enable toggles a shortcut and its label", () => {
    const win = fakeWindow();
    const { panel, shortcutsController } = mountShortcuts(win);
    const row = Array.from(panel.element.querySelectorAll(".wx-settings-shortcut-row")).find((r) =>
      r.textContent?.includes("Zoom in"),
    )!;
    const toggle = row.querySelector<HTMLButtonElement>(".wx-settings-shortcut-toggle")!;
    expect(toggle.textContent).toBe("Disable");
    toggle.click();
    expect(shortcutsController.list().find((i) => i.id === "zoom.in")!.disabled).toBe(true);

    const rowAfter = Array.from(panel.element.querySelectorAll(".wx-settings-shortcut-row")).find((r) =>
      r.textContent?.includes("Zoom in"),
    )!;
    expect(rowAfter.querySelector(".wx-settings-shortcut-toggle")!.textContent).toBe("Enable");
    expect(rowAfter.classList.contains("wx-settings-shortcut-disabled")).toBe(true);
  });

  it("Rebind captures the next real keydown and applies it", () => {
    const win = fakeWindow();
    const { panel, shortcutsController } = mountShortcuts(win);
    const row = Array.from(panel.element.querySelectorAll(".wx-settings-shortcut-row")).find((r) =>
      r.textContent?.includes("Zoom out"),
    )!;
    row.querySelector<HTMLButtonElement>(".wx-settings-shortcut-rebind")!.click();

    keydown(win, { ctrlKey: true, code: "ControlLeft" }); // pure modifier — ignored, still capturing
    keydown(win, { ctrlKey: true, altKey: true, code: "KeyQ" });

    const item = shortcutsController.list().find((i) => i.id === "zoom.out")!;
    expect(item.isCustom).toBe(true);
    expect(item.binding).toEqual({ ctrlKey: true, shiftKey: false, altKey: true, metaKey: false, code: "KeyQ" });
  });

  it("Rebind: pressing Escape cancels without changing the binding", () => {
    const win = fakeWindow();
    const { panel, shortcutsController } = mountShortcuts(win);
    const row = Array.from(panel.element.querySelectorAll(".wx-settings-shortcut-row")).find((r) =>
      r.textContent?.includes("Zoom out"),
    )!;
    row.querySelector<HTMLButtonElement>(".wx-settings-shortcut-rebind")!.click();
    keydown(win, { code: "Escape" });
    expect(shortcutsController.list().find((i) => i.id === "zoom.out")!.isCustom).toBe(false);
  });

  it("Rebind: a colliding combo shows an inline error and does not change the binding", () => {
    const win = fakeWindow();
    const { panel, shortcutsController } = mountShortcuts(win);
    const row = Array.from(panel.element.querySelectorAll(".wx-settings-shortcut-row")).find((r) =>
      r.textContent?.includes("Zoom out"),
    )!;
    row.querySelector<HTMLButtonElement>(".wx-settings-shortcut-rebind")!.click();
    keydown(win, { ctrlKey: true, code: "Equal" }); // zoom.in's default — collides

    expect(shortcutsController.list().find((i) => i.id === "zoom.out")!.isCustom).toBe(false);
    expect(panel.element.textContent).toContain("Already used by");
  });

  it("Reset to Defaults asks for confirmation and clears all customizations", () => {
    const win = fakeWindow({ confirmReturns: true });
    const { panel, shortcutsController } = mountShortcuts(win);
    shortcutsController.setDisabled("zoom.in", true);
    // re-mount is unnecessary: the panel subscribes and re-renders itself
    const resetButton = panel.element.querySelector<HTMLButtonElement>(".wx-settings-reset-all")!;
    resetButton.click();
    expect(shortcutsController.list().every((i) => !i.disabled && !i.isCustom)).toBe(true);
  });

  it("teardown cancels an in-progress capture and does not throw", () => {
    const win = fakeWindow();
    const { panel, shortcutsController } = mountShortcuts(win);
    const row = Array.from(panel.element.querySelectorAll(".wx-settings-shortcut-row")).find((r) =>
      r.textContent?.includes("Zoom in"),
    )!;
    row.querySelector<HTMLButtonElement>(".wx-settings-shortcut-rebind")!.click();
    expect(() => panel.teardown()).not.toThrow();
    // the capture listener must be gone — this keydown should not rebind zoom.in
    keydown(win, { ctrlKey: true, altKey: true, code: "KeyZ" });
    expect(shortcutsController.list().find((i) => i.id === "zoom.in")!.isCustom).toBe(false);
  });
});

describe("mountSettingsPanel — Engine", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a loading state before the status arrives", () => {
    const api = fakeApi({
      getEngineStatus: vi.fn(() => new Promise<EngineStatus>(() => {})),
    });
    const { panel } = mountEngine(fakeWindow(), api);
    expect(panel.element.textContent).toContain("Loading");
  });

  it("renders repo/sha/commits-behind/changelog once the status loads", async () => {
    const api = fakeApi({ getEngineStatus: vi.fn(async () => ENGINE_STATUS) });
    const { panel } = mountEngine(fakeWindow(), api);
    await Promise.resolve();
    await Promise.resolve();

    expect(panel.element.textContent).toContain(ENGINE_STATUS.currentSha!.slice(0, 12));
    expect(panel.element.textContent).toContain("2 updates available");
    expect(panel.element.textContent).toContain("feat: thing");
    expect(panel.element.textContent).toContain("Jane");
  });

  it("a 404 (fleet edition) shows a graceful not-available message, not an error", async () => {
    const api = fakeApi({
      getEngineStatus: vi.fn(async () => {
        throw new ApiError("not found", 404);
      }),
    });
    const { panel } = mountEngine(fakeWindow(), api);
    await Promise.resolve();
    await Promise.resolve();

    expect(panel.element.textContent).toContain("isn't available on this deployment");
  });

  it("a non-404 error shows a load-error message", async () => {
    const api = fakeApi({
      getEngineStatus: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const { panel } = mountEngine(fakeWindow(), api);
    await Promise.resolve();
    await Promise.resolve();

    expect(panel.element.textContent).toContain("Couldn't load engine status: boom");
  });

  it("commitsBehind 0 disables the update button but not rollback", async () => {
    const api = fakeApi({
      getEngineStatus: vi.fn(async () => ({ ...ENGINE_STATUS, commitsBehind: 0 })),
    });
    const { panel } = mountEngine(fakeWindow(), api);
    await Promise.resolve();
    await Promise.resolve();

    const buttons = Array.from(panel.element.querySelectorAll("button"));
    const updateButton = buttons.find((b) => b.textContent === "Get engine updates")!;
    const rollbackButton = buttons.find((b) => b.textContent === "Undo last update")!;
    expect(updateButton.disabled).toBe(true);
    expect(rollbackButton.disabled).toBe(false);
  });

  it("clicking 'Get engine updates' triggers the update and re-polls", async () => {
    vi.useFakeTimers();
    const getEngineStatus = vi.fn(async () => ENGINE_STATUS);
    const triggerEngineUpdate = vi.fn(async () => ({ triggered: true as const }));
    const api = fakeApi({ getEngineStatus, triggerEngineUpdate });
    const { panel } = mountEngine(fakeWindow(), api);
    await vi.advanceTimersByTimeAsync(0);

    const updateButton = Array.from(panel.element.querySelectorAll("button")).find(
      (b) => b.textContent === "Get engine updates",
    )!;
    updateButton.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(triggerEngineUpdate).toHaveBeenCalledTimes(1);
    expect(getEngineStatus).toHaveBeenCalledTimes(1); // not yet — the re-poll is scheduled 1s out

    await vi.advanceTimersByTimeAsync(1_000);
    expect(getEngineStatus).toHaveBeenCalledTimes(2);
  });

  it("clicking 'Undo last update' asks for confirmation before triggering rollback", async () => {
    const triggerEngineRollback = vi.fn(async () => ({ triggered: true as const }));
    const api = fakeApi({
      getEngineStatus: vi.fn(async () => ENGINE_STATUS),
      triggerEngineRollback,
    });
    const win = fakeWindow({ confirmReturns: false });
    const { panel } = mountEngine(win, api);
    await Promise.resolve();
    await Promise.resolve();

    const rollbackButton = Array.from(panel.element.querySelectorAll("button")).find(
      (b) => b.textContent === "Undo last update",
    )!;
    rollbackButton.click();
    await Promise.resolve();

    expect(triggerEngineRollback).not.toHaveBeenCalled();
  });

  it("a failed trigger shows the error and re-enables the buttons", async () => {
    const api = fakeApi({
      getEngineStatus: vi.fn(async () => ENGINE_STATUS),
      triggerEngineUpdate: vi.fn(async () => {
        throw new Error("dispatch failed");
      }),
    });
    const { panel } = mountEngine(fakeWindow(), api);
    await Promise.resolve();
    await Promise.resolve();

    const updateButton = Array.from(panel.element.querySelectorAll("button")).find(
      (b) => b.textContent === "Get engine updates",
    )!;
    updateButton.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(panel.element.textContent).toContain("Couldn't start the update: dispatch failed");
    expect(updateButton.disabled).toBe(false);
  });

  it("teardown stops the poll loop — no further getEngineStatus calls", async () => {
    vi.useFakeTimers();
    const getEngineStatus = vi.fn(async () => ENGINE_STATUS);
    const api = fakeApi({ getEngineStatus });
    const { panel } = mountEngine(fakeWindow(), api);
    await vi.advanceTimersByTimeAsync(0);
    expect(getEngineStatus).toHaveBeenCalledTimes(1);

    panel.teardown();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(getEngineStatus).toHaveBeenCalledTimes(1);
  });
});

describe("mountSettingsPanel — AI", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a loading state before the status arrives", () => {
    const api = fakeApi({
      getAiBudgetStatus: vi.fn(() => new Promise<AiBudgetStatus>(() => {})),
    });
    const { panel } = mountAi(fakeWindow(), api);
    expect(panel.element.textContent).toContain("Loading");
  });

  it("renders month-to-date spend and the monthly budget once loaded", async () => {
    const api = fakeApi({ getAiBudgetStatus: vi.fn(async () => AI_BUDGET_STATUS) });
    const { panel } = mountAi(fakeWindow(), api);
    await Promise.resolve();
    await Promise.resolve();

    expect(panel.element.textContent).toContain("$8.25");
    expect(panel.element.textContent).toContain("$40.00");
  });

  it("a 404 (cmd backend) shows a graceful not-available message, not an error", async () => {
    const api = fakeApi({
      getAiBudgetStatus: vi.fn(async () => {
        throw new ApiError("not found", 404);
      }),
    });
    const { panel } = mountAi(fakeWindow(), api);
    await Promise.resolve();
    await Promise.resolve();

    expect(panel.element.textContent).toContain("isn't available on this deployment");
  });

  it("a non-404 error shows a load-error message", async () => {
    const api = fakeApi({
      getAiBudgetStatus: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const { panel } = mountAi(fakeWindow(), api);
    await Promise.resolve();
    await Promise.resolve();

    expect(panel.element.textContent).toContain("Couldn't load AI budget: boom");
  });

  it("spend at or past the cap shows the paused-until-reset message", async () => {
    const api = fakeApi({
      getAiBudgetStatus: vi.fn(async () => ({ monthToDateUsd: 40, monthlyBudgetUsd: 40 })),
    });
    const { panel } = mountAi(fakeWindow(), api);
    await Promise.resolve();
    await Promise.resolve();

    expect(panel.element.textContent).toContain("paused until it resets on the 1st");
  });

  it("spend under the cap does not show the paused message", async () => {
    const api = fakeApi({ getAiBudgetStatus: vi.fn(async () => AI_BUDGET_STATUS) });
    const { panel } = mountAi(fakeWindow(), api);
    await Promise.resolve();
    await Promise.resolve();

    expect(panel.element.textContent).not.toContain("paused until it resets");
  });

  it("re-polls after 60s", async () => {
    vi.useFakeTimers();
    const getAiBudgetStatus = vi.fn(async () => AI_BUDGET_STATUS);
    const api = fakeApi({ getAiBudgetStatus });
    mountAi(fakeWindow(), api);
    await vi.advanceTimersByTimeAsync(0);
    expect(getAiBudgetStatus).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(getAiBudgetStatus).toHaveBeenCalledTimes(2);
  });

  it("teardown stops the poll loop — no further getAiBudgetStatus calls", async () => {
    vi.useFakeTimers();
    const getAiBudgetStatus = vi.fn(async () => AI_BUDGET_STATUS);
    const api = fakeApi({ getAiBudgetStatus });
    const { panel } = mountAi(fakeWindow(), api);
    await vi.advanceTimersByTimeAsync(0);
    expect(getAiBudgetStatus).toHaveBeenCalledTimes(1);

    panel.teardown();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(getAiBudgetStatus).toHaveBeenCalledTimes(1);
  });
});

describe("mountSettingsPanel — System", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a loading state before the status arrives", () => {
    const api = fakeApi({
      getSystemStatus: vi.fn(() => new Promise<SystemStatus>(() => {})),
    });
    const { panel } = mountSystem(fakeWindow(), api);
    expect(panel.element.textContent).toContain("Loading");
  });

  it("renders backup time, disk usage, last publish, and engine sha once loaded", async () => {
    const api = fakeApi({ getSystemStatus: vi.fn(async () => SYSTEM_STATUS) });
    const { panel } = mountSystem(fakeWindow(), api);
    await Promise.resolve();
    await Promise.resolve();

    expect(panel.element.textContent).toContain("2.0 GB");
    expect(panel.element.textContent).toContain("25.0 GB");
    expect(panel.element.textContent).toContain("Version 5");
    expect(panel.element.textContent).toContain("aaaaaaaaaaaa");
    expect(panel.element.textContent).toContain("standalone");
  });

  it("a stale backup shows the warning hint", async () => {
    const api = fakeApi({
      getSystemStatus: vi.fn(async () => ({
        ...SYSTEM_STATUS,
        backup: { ...SYSTEM_STATUS.backup, stale: true },
      })),
    });
    const { panel } = mountSystem(fakeWindow(), api);
    await Promise.resolve();
    await Promise.resolve();

    expect(panel.element.textContent).toContain("No verified backup in the last 48 hours");
  });

  it("a fresh backup does not show the warning hint", async () => {
    const api = fakeApi({ getSystemStatus: vi.fn(async () => SYSTEM_STATUS) });
    const { panel } = mountSystem(fakeWindow(), api);
    await Promise.resolve();
    await Promise.resolve();

    expect(panel.element.textContent).not.toContain("No verified backup in the last 48 hours");
  });

  it("no backup ever run shows a plain never-run message, not an error", async () => {
    const api = fakeApi({
      getSystemStatus: vi.fn(async () => ({
        ...SYSTEM_STATUS,
        backup: { lastAttemptAt: null, ok: null, verified: null, error: null, stale: true },
      })),
    });
    const { panel } = mountSystem(fakeWindow(), api);
    await Promise.resolve();
    await Promise.resolve();

    expect(panel.element.textContent).toContain("No backup has run yet");
  });

  it("a backup error is shown", async () => {
    const api = fakeApi({
      getSystemStatus: vi.fn(async () => ({
        ...SYSTEM_STATUS,
        backup: { ...SYSTEM_STATUS.backup, ok: false, stale: true, error: "git push failed: boom" },
      })),
    });
    const { panel } = mountSystem(fakeWindow(), api);
    await Promise.resolve();
    await Promise.resolve();

    expect(panel.element.textContent).toContain("git push failed: boom");
  });

  it("a load error shows a load-error message", async () => {
    const api = fakeApi({
      getSystemStatus: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const { panel } = mountSystem(fakeWindow(), api);
    await Promise.resolve();
    await Promise.resolve();

    expect(panel.element.textContent).toContain("Couldn't load system status: boom");
  });

  it("re-polls after 60s", async () => {
    vi.useFakeTimers();
    const getSystemStatus = vi.fn(async () => SYSTEM_STATUS);
    const api = fakeApi({ getSystemStatus });
    mountSystem(fakeWindow(), api);
    await vi.advanceTimersByTimeAsync(0);
    expect(getSystemStatus).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(getSystemStatus).toHaveBeenCalledTimes(2);
  });

  it("teardown stops the poll loop — no further getSystemStatus calls", async () => {
    vi.useFakeTimers();
    const getSystemStatus = vi.fn(async () => SYSTEM_STATUS);
    const api = fakeApi({ getSystemStatus });
    const { panel } = mountSystem(fakeWindow(), api);
    await vi.advanceTimersByTimeAsync(0);
    expect(getSystemStatus).toHaveBeenCalledTimes(1);

    panel.teardown();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(getSystemStatus).toHaveBeenCalledTimes(1);
  });
});
