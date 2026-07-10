import { describe, expect, it } from "vitest";
import {
  bindingFromEvent,
  formatBinding,
  initShortcuts,
  type KeyBinding,
  type ShortcutCommand,
} from "../src/shortcuts";

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
  const storage = opts.storage ?? fakeStorage();
  const target = new EventTarget();
  return {
    localStorage: storage,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  } as unknown as Window;
}

function keydown(win: Window, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { cancelable: true, ...init });
  win.dispatchEvent(event);
  return event;
}

function binding(overrides: Partial<KeyBinding> & { code: string }): KeyBinding {
  return { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...overrides };
}

function makeCommands(runLog: string[]): ShortcutCommand[] {
  return [
    {
      id: "zoom.in",
      category: "Zoom",
      label: "Zoom in",
      defaultBinding: binding({ ctrlKey: true, code: "Equal" }),
      run: () => runLog.push("zoom.in"),
    },
    {
      id: "zoom.out",
      category: "Zoom",
      label: "Zoom out",
      defaultBinding: binding({ ctrlKey: true, code: "Minus" }),
      run: () => runLog.push("zoom.out"),
    },
    {
      id: "font.up",
      category: "Font Size",
      label: "Increase font size",
      defaultBinding: binding({ ctrlKey: true, shiftKey: true, code: "Equal" }),
      run: () => runLog.push("font.up"),
    },
  ];
}

describe("formatBinding", () => {
  it("joins modifiers and a display-friendly code", () => {
    expect(formatBinding(binding({ ctrlKey: true, code: "Equal" }))).toBe("Ctrl + =");
    expect(formatBinding(binding({ ctrlKey: true, shiftKey: true, code: "Minus" }))).toBe("Ctrl + Shift + −");
    expect(formatBinding(binding({ code: "Digit0" }))).toBe("0");
    expect(formatBinding(binding({ code: "KeyA" }))).toBe("A");
    expect(formatBinding(binding({ altKey: true, metaKey: true, code: "F1" }))).toBe("Alt + Meta + F1");
  });
});

describe("bindingFromEvent", () => {
  it("extracts every modifier and the physical code", () => {
    const event = new KeyboardEvent("keydown", { ctrlKey: true, shiftKey: true, code: "KeyB" });
    expect(bindingFromEvent(event)).toEqual(binding({ ctrlKey: true, shiftKey: true, code: "KeyB" }));
  });
});

describe("initShortcuts", () => {
  it("invokes the matching command's run() and prevents default", () => {
    const runLog: string[] = [];
    const win = fakeWindow();
    initShortcuts(makeCommands(runLog), win);
    const event = keydown(win, { ctrlKey: true, code: "Equal" });
    expect(runLog).toEqual(["zoom.in"]);
    expect(event.defaultPrevented).toBe(true);
  });

  it("does nothing for a keydown matching no command", () => {
    const runLog: string[] = [];
    const win = fakeWindow();
    initShortcuts(makeCommands(runLog), win);
    keydown(win, { ctrlKey: true, code: "KeyZ" });
    expect(runLog).toEqual([]);
  });

  it("distinguishes Ctrl+Equal from Ctrl+Shift+Equal", () => {
    const runLog: string[] = [];
    const win = fakeWindow();
    initShortcuts(makeCommands(runLog), win);
    keydown(win, { ctrlKey: true, shiftKey: true, code: "Equal" });
    expect(runLog).toEqual(["font.up"]);
  });

  it("list() reflects the default bindings with isCustom/disabled false", () => {
    const controller = initShortcuts(makeCommands([]), fakeWindow());
    const items = controller.list();
    expect(items).toHaveLength(3);
    const zoomIn = items.find((i) => i.id === "zoom.in")!;
    expect(zoomIn.isCustom).toBe(false);
    expect(zoomIn.disabled).toBe(false);
    expect(zoomIn.binding).toEqual(binding({ ctrlKey: true, code: "Equal" }));
  });

  describe("rebind", () => {
    it("rebinding to a free combo persists, updates list(), and takes over dispatch from the old binding", () => {
      const runLog: string[] = [];
      const win = fakeWindow();
      const controller = initShortcuts(makeCommands(runLog), win);

      const newBinding = binding({ ctrlKey: true, altKey: true, code: "KeyZ" });
      const result = controller.rebind("zoom.in", newBinding);
      expect(result).toEqual({ ok: true });

      const item = controller.list().find((i) => i.id === "zoom.in")!;
      expect(item.isCustom).toBe(true);
      expect(item.binding).toEqual(newBinding);

      keydown(win, { ctrlKey: true, code: "Equal" }); // old binding — no longer bound
      keydown(win, { ctrlKey: true, altKey: true, code: "KeyZ" }); // new binding
      expect(runLog).toEqual(["zoom.in"]);
    });

    it("refuses a rebind that collides with another enabled shortcut's effective binding", () => {
      const controller = initShortcuts(makeCommands([]), fakeWindow());
      const result = controller.rebind("zoom.out", binding({ ctrlKey: true, code: "Equal" })); // == zoom.in's default
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.conflictWith.id).toBe("zoom.in");
      // unchanged
      const item = controller.list().find((i) => i.id === "zoom.out")!;
      expect(item.isCustom).toBe(false);
    });

    it("does not treat a disabled shortcut's binding as a conflict", () => {
      const controller = initShortcuts(makeCommands([]), fakeWindow());
      controller.setDisabled("zoom.in", true);
      const result = controller.rebind("zoom.out", binding({ ctrlKey: true, code: "Equal" }));
      expect(result).toEqual({ ok: true });
    });

    it("persists across a fresh initShortcuts() call sharing the same localStorage", () => {
      const storage = fakeStorage();
      const win1 = fakeWindow({ storage });
      const controller1 = initShortcuts(makeCommands([]), win1);
      controller1.rebind("zoom.in", binding({ ctrlKey: true, code: "KeyQ" }));

      const win2 = fakeWindow({ storage });
      const controller2 = initShortcuts(makeCommands([]), win2);
      const item = controller2.list().find((i) => i.id === "zoom.in")!;
      expect(item.isCustom).toBe(true);
      expect(item.binding).toEqual(binding({ ctrlKey: true, code: "KeyQ" }));
    });
  });

  describe("setDisabled", () => {
    it("a disabled shortcut no longer dispatches on its binding", () => {
      const runLog: string[] = [];
      const win = fakeWindow();
      const controller = initShortcuts(makeCommands(runLog), win);
      controller.setDisabled("zoom.in", true);
      keydown(win, { ctrlKey: true, code: "Equal" });
      expect(runLog).toEqual([]);
      expect(controller.list().find((i) => i.id === "zoom.in")!.disabled).toBe(true);
    });

    it("re-enabling restores dispatch", () => {
      const runLog: string[] = [];
      const win = fakeWindow();
      const controller = initShortcuts(makeCommands(runLog), win);
      controller.setDisabled("zoom.in", true);
      controller.setDisabled("zoom.in", false);
      keydown(win, { ctrlKey: true, code: "Equal" });
      expect(runLog).toEqual(["zoom.in"]);
    });
  });

  describe("resetAll", () => {
    it("clears every custom binding and disabled flag back to defaults", () => {
      const win = fakeWindow();
      const controller = initShortcuts(makeCommands([]), win);
      controller.rebind("zoom.in", binding({ ctrlKey: true, code: "KeyQ" }));
      controller.setDisabled("zoom.out", true);

      controller.resetAll();

      const items = controller.list();
      expect(items.every((i) => !i.isCustom && !i.disabled)).toBe(true);
      expect(items.find((i) => i.id === "zoom.in")!.binding).toEqual(binding({ ctrlKey: true, code: "Equal" }));
    });
  });

  describe("subscribe", () => {
    it("fires on rebind, setDisabled, and resetAll", () => {
      const win = fakeWindow();
      const controller = initShortcuts(makeCommands([]), win);
      let calls = 0;
      controller.subscribe(() => (calls += 1));

      controller.rebind("zoom.in", binding({ ctrlKey: true, code: "KeyQ" }));
      controller.setDisabled("zoom.out", true);
      controller.resetAll();

      expect(calls).toBe(3);
    });

    it("does not fire merely from a shortcut successfully dispatching", () => {
      const runLog: string[] = [];
      const win = fakeWindow();
      const controller = initShortcuts(makeCommands(runLog), win);
      let calls = 0;
      controller.subscribe(() => (calls += 1));

      keydown(win, { ctrlKey: true, code: "Equal" });
      expect(runLog).toEqual(["zoom.in"]);
      expect(calls).toBe(0);
    });

    it("unsubscribe stops further notifications to that listener only", () => {
      const win = fakeWindow();
      const controller = initShortcuts(makeCommands([]), win);
      let a = 0;
      let b = 0;
      const unsubA = controller.subscribe(() => (a += 1));
      controller.subscribe(() => (b += 1));

      controller.setDisabled("zoom.in", true);
      unsubA();
      controller.setDisabled("zoom.out", true);

      expect(a).toBe(1);
      expect(b).toBe(2);
    });
  });

  it("teardown stops dispatching entirely", () => {
    const runLog: string[] = [];
    const win = fakeWindow();
    const controller = initShortcuts(makeCommands(runLog), win);
    controller.teardown();
    keydown(win, { ctrlKey: true, code: "Equal" });
    expect(runLog).toEqual([]);
  });

  it("ignores a garbage/corrupted stored overrides value rather than throwing", () => {
    const storage = fakeStorage();
    storage.setItem("wx-shortcut-bindings", "not json{{{");
    const win = fakeWindow({ storage });
    expect(() => initShortcuts(makeCommands([]), win)).not.toThrow();
    const controller = initShortcuts(makeCommands([]), win);
    expect(controller.list().every((i) => !i.isCustom)).toBe(true);
  });
});
