// Centralized, rebindable keyboard-shortcut registry (Uxer's Settings +
// Keyboard Shortcuts mandate: "list every keyboard shortcut... allow the
// user to rebind... allow the user to disable... Reset to Defaults").
// Owns exactly one global keydown listener; commands are registered once
// (by shell.ts, at construction) with a default binding and a `run`
// callback wired to whatever controller method they should trigger (e.g.
// zoom.ts's `zoomIn`) — this module owns "what key combo means what",
// never the actions themselves. zoom.ts/fontScale.ts used to each own
// their own hardcoded matching + listener (slice 3); centralizing here is
// what makes "rebind any shortcut" possible without two sources of truth
// for the same default.

export interface KeyBinding {
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  code: string; // KeyboardEvent.code - the physical key, layout-independent
}

export interface ShortcutCommand {
  id: string; // stable id, e.g. "zoom.in"
  category: string; // groups the Settings > Keyboard Shortcuts listing
  label: string;
  defaultBinding: KeyBinding;
  run: () => void;
}

export interface ShortcutListItem {
  id: string;
  category: string;
  label: string;
  defaultBinding: KeyBinding;
  binding: KeyBinding; // effective: the custom override if set, else default
  isCustom: boolean;
  disabled: boolean;
}

export type RebindResult = { ok: true } | { ok: false; conflictWith: ShortcutListItem };

export interface ShortcutsController {
  list(): ShortcutListItem[];
  rebind(id: string, binding: KeyBinding): RebindResult;
  setDisabled(id: string, disabled: boolean): void;
  resetAll(): void;
  /** Notified after any rebind/disable/resetAll (not on every keydown —
   * there's nothing for a renderer to refresh when a shortcut merely
   * fires). Settings > Keyboard Shortcuts subscribes to keep its listing
   * in sync if edited from elsewhere (e.g. a future second settings tab
   * in another window sharing localStorage isn't in scope, but a single
   * page's own mutations always go through this, so this is the one path
   * a renderer needs). */
  subscribe(listener: () => void): () => void;
  teardown(): void;
}

interface StoredOverride {
  binding?: KeyBinding;
  disabled?: boolean;
}

const STORAGE_KEY = "wx-shortcut-bindings";

function isKeyBinding(value: unknown): value is KeyBinding {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["ctrlKey"] === "boolean" &&
    typeof v["shiftKey"] === "boolean" &&
    typeof v["altKey"] === "boolean" &&
    typeof v["metaKey"] === "boolean" &&
    typeof v["code"] === "string"
  );
}

function isStoredOverride(value: unknown): value is StoredOverride {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if ("binding" in v && v["binding"] !== undefined && !isKeyBinding(v["binding"])) return false;
  if ("disabled" in v && v["disabled"] !== undefined && typeof v["disabled"] !== "boolean") return false;
  return true;
}

function loadOverrides(win: Window): Record<string, StoredOverride> {
  try {
    const raw = win.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const result: Record<string, StoredOverride> = {};
    for (const [id, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (isStoredOverride(entry)) result[id] = entry;
    }
    return result;
  } catch {
    return {};
  }
}

function saveOverrides(win: Window, overrides: Record<string, StoredOverride>): void {
  try {
    if (Object.keys(overrides).length === 0) {
      win.localStorage.removeItem(STORAGE_KEY);
    } else {
      win.localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
    }
  } catch {
    // best-effort persistence only
  }
}

function sameBinding(a: KeyBinding, b: KeyBinding): boolean {
  return (
    a.ctrlKey === b.ctrlKey && a.shiftKey === b.shiftKey && a.altKey === b.altKey && a.metaKey === b.metaKey && a.code === b.code
  );
}

/** Codes that are pure modifiers — never a valid *complete* binding on
 * their own; the rebind-capture UI (settingsPanel.ts) waits past these for
 * the actual key. */
export const MODIFIER_CODES: readonly string[] = [
  "ControlLeft",
  "ControlRight",
  "ShiftLeft",
  "ShiftRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
];

const CODE_DISPLAY: Record<string, string> = {
  Equal: "=",
  Minus: "−",
  Digit0: "0",
  NumpadAdd: "Num +",
  NumpadSubtract: "Num −",
  Numpad0: "Num 0",
};

function displayCode(code: string): string {
  const known = CODE_DISPLAY[code];
  if (known !== undefined) return known;
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return code;
}

export function formatBinding(binding: KeyBinding): string {
  const parts: string[] = [];
  if (binding.ctrlKey) parts.push("Ctrl");
  if (binding.shiftKey) parts.push("Shift");
  if (binding.altKey) parts.push("Alt");
  if (binding.metaKey) parts.push("Meta");
  parts.push(displayCode(binding.code));
  return parts.join(" + ");
}

export function bindingFromEvent(e: KeyboardEvent): KeyBinding {
  return { ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey, code: e.code };
}

export function initShortcuts(commands: readonly ShortcutCommand[], win: Window = window): ShortcutsController {
  const overrides = loadOverrides(win);
  const listeners = new Set<() => void>();

  function notify(): void {
    listeners.forEach((l) => l());
  }

  function effectiveBinding(command: ShortcutCommand): KeyBinding {
    return overrides[command.id]?.binding ?? command.defaultBinding;
  }

  function isDisabled(id: string): boolean {
    return overrides[id]?.disabled === true;
  }

  function list(): ShortcutListItem[] {
    return commands.map((command) => {
      const override = overrides[command.id];
      return {
        id: command.id,
        category: command.category,
        label: command.label,
        defaultBinding: command.defaultBinding,
        binding: effectiveBinding(command),
        isCustom: override?.binding !== undefined,
        disabled: override?.disabled === true,
      };
    });
  }

  function rebind(id: string, binding: KeyBinding): RebindResult {
    const conflict = commands.find((c) => c.id !== id && !isDisabled(c.id) && sameBinding(effectiveBinding(c), binding));
    if (conflict !== undefined) {
      const item = list().find((i) => i.id === conflict.id);
      return { ok: false, conflictWith: item! };
    }
    const existing = overrides[id] ?? {};
    overrides[id] = { ...existing, binding };
    saveOverrides(win, overrides);
    notify();
    return { ok: true };
  }

  function setDisabled(id: string, disabled: boolean): void {
    const existing = overrides[id] ?? {};
    overrides[id] = { ...existing, disabled };
    saveOverrides(win, overrides);
    notify();
  }

  function resetAll(): void {
    for (const key of Object.keys(overrides)) delete overrides[key];
    saveOverrides(win, overrides);
    notify();
  }

  const onKeydown = (e: KeyboardEvent): void => {
    for (const command of commands) {
      if (isDisabled(command.id)) continue;
      if (sameBinding(effectiveBinding(command), bindingFromEvent(e))) {
        e.preventDefault();
        command.run();
        return;
      }
    }
  };
  win.addEventListener("keydown", onKeydown);

  return {
    list,
    rebind,
    setDisabled,
    resetAll,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    teardown: () => win.removeEventListener("keydown", onKeydown),
  };
}
