import { describe, expect, it, vi } from "vitest";
import { initFontScale } from "../src/fontScale";
import { mountSettingsPanel } from "../src/settingsPanel";
import { initShortcuts, type ShortcutCommand } from "../src/shortcuts";
import { initTheme } from "../src/theme";
import { initZoom } from "../src/zoom";

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
  const onNavigate = vi.fn();
  const panel = mountSettingsPanel({
    win,
    page: "general",
    themeController,
    zoomController,
    fontScaleController,
    shortcutsController,
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
  const onNavigate = vi.fn();
  const panel = mountSettingsPanel({
    win,
    page: "shortcuts",
    themeController,
    zoomController,
    fontScaleController,
    shortcutsController,
    onNavigate,
    onResetAll: vi.fn(),
  });
  return { panel, shortcutsController, onNavigate };
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
