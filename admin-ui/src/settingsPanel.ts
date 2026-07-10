// The Settings panel (#/settings, #/settings/shortcuts) — Uxer's Settings-
// view mandate (item 5) plus surfacing the session-persistence story (item
// 6) in one place. General: appearance controls that ALSO exist in the
// topbar chrome (theme mode, zoom, font size) — Uxer's own doc is explicit
// that's expected ("the title bar toggle is mandatory for quick access...
// the Settings view may also include a theme selector"), plus a
// session-state summary and a reset-everything escape hatch. Keyboard
// Shortcuts: list every shortcut (grouped by category), rebind, disable,
// reset to defaults.

import type { FontScaleController } from "./fontScale";
import type { SettingsPage } from "./router";
import {
  bindingFromEvent,
  formatBinding,
  MODIFIER_CODES,
  type ShortcutListItem,
  type ShortcutsController,
} from "./shortcuts";
import { resolveVariant, type ThemeController, type ThemeMode } from "./theme";
import type { ZoomController } from "./zoom";

export interface SettingsPanelDeps {
  win: Window;
  page: SettingsPage;
  themeController: ThemeController;
  zoomController: ZoomController;
  fontScaleController: FontScaleController;
  shortcutsController: ShortcutsController;
  onNavigate: (page: SettingsPage) => void;
  /** Resets theme/zoom/font-scale/shortcuts to defaults AND clears the
   * persisted last-active-route — owned by shell.ts since it's the one
   * place all five controllers are already in scope together. */
  onResetAll: () => void;
}

export interface SettingsPanel {
  element: HTMLElement;
  teardown(): void;
}

const THEME_MODE_LABELS: Record<ThemeMode, string> = { light: "Light", dark: "Dark", system: "System" };
const THEME_MODES: readonly ThemeMode[] = ["light", "dark", "system"];

function settingsSection(title: string): HTMLElement {
  const section = document.createElement("div");
  section.className = "wx-settings-section";
  const header = document.createElement("h3");
  header.textContent = title;
  section.appendChild(header);
  return section;
}

export function mountSettingsPanel(deps: SettingsPanelDeps): SettingsPanel {
  const root = document.createElement("div");
  root.className = "wx-settings-panel";

  const heading = document.createElement("h2");
  heading.textContent = "Settings";
  root.appendChild(heading);

  const tabs = document.createElement("div");
  tabs.className = "wx-settings-tabs";
  const generalTab = document.createElement("button");
  generalTab.type = "button";
  generalTab.className = "wx-settings-tab";
  generalTab.textContent = "General";
  generalTab.classList.toggle("wx-settings-tab-active", deps.page === "general");
  generalTab.addEventListener("click", () => deps.onNavigate("general"));
  const shortcutsTab = document.createElement("button");
  shortcutsTab.type = "button";
  shortcutsTab.className = "wx-settings-tab";
  shortcutsTab.textContent = "Keyboard Shortcuts";
  shortcutsTab.classList.toggle("wx-settings-tab-active", deps.page === "shortcuts");
  shortcutsTab.addEventListener("click", () => deps.onNavigate("shortcuts"));
  tabs.append(generalTab, shortcutsTab);
  root.appendChild(tabs);

  const body = document.createElement("div");
  root.appendChild(body);

  const teardownFns: Array<() => void> = [];
  body.appendChild(deps.page === "general" ? renderGeneral(deps, teardownFns) : renderShortcuts(deps, teardownFns));

  return {
    element: root,
    teardown(): void {
      teardownFns.forEach((fn) => fn());
    },
  };
}

// -- General --------------------------------------------------------------

function renderGeneral(deps: SettingsPanelDeps, teardownFns: Array<() => void>): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "wx-settings-general";

  // -- Appearance: theme mode ----------------------------------------------
  const appearance = settingsSection("Appearance");

  const themeRow = document.createElement("div");
  themeRow.className = "wx-settings-row";
  const themeLabel = document.createElement("span");
  themeLabel.className = "wx-settings-row-label";
  themeLabel.textContent = "Theme";
  const themeButtonGroup = document.createElement("div");
  themeButtonGroup.className = "wx-settings-button-group";
  const themeButtons = THEME_MODES.map((mode) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = THEME_MODE_LABELS[mode];
    button.addEventListener("click", () => deps.themeController.setMode(mode));
    themeButtonGroup.appendChild(button);
    return { mode, button };
  });
  themeRow.append(themeLabel, themeButtonGroup);

  const themeResolvedRow = document.createElement("p");
  themeResolvedRow.className = "wx-settings-hint";

  function renderTheme(mode: ThemeMode): void {
    for (const { mode: buttonMode, button } of themeButtons) {
      button.classList.toggle("wx-settings-button-active", buttonMode === mode);
    }
    const variant = resolveVariant(mode, deps.win);
    themeResolvedRow.textContent =
      mode === "system" ? `Following your system preference — currently ${variant}.` : `Always ${variant}.`;
  }
  renderTheme(deps.themeController.getMode());
  const unsubTheme = deps.themeController.subscribe((mode) => renderTheme(mode));
  teardownFns.push(unsubTheme);

  appearance.append(themeRow, themeResolvedRow);

  // -- Zoom & font size ------------------------------------------------------
  const view = settingsSection("Zoom & Font Size");

  const zoomStepper = stepperRow(
    "Zoom",
    () => `${deps.zoomController.getLevel()}%`,
    () => deps.zoomController.zoomOut(),
    () => deps.zoomController.zoomIn(),
    "−",
    "+",
  );
  const unsubZoom = deps.zoomController.subscribe(() => zoomStepper.refresh());
  teardownFns.push(unsubZoom);

  const fontStepper = stepperRow(
    "Font size",
    () => `${deps.fontScaleController.getLevel()}%`,
    () => deps.fontScaleController.decrease(),
    () => deps.fontScaleController.increase(),
    "A−",
    "A+",
  );
  const unsubFont = deps.fontScaleController.subscribe(() => fontStepper.refresh());
  teardownFns.push(unsubFont);

  view.append(zoomStepper.row, fontStepper.row);

  // -- Session --------------------------------------------------------------
  const session = settingsSection("Session");
  const sessionHint = document.createElement("p");
  sessionHint.className = "wx-settings-hint";
  sessionHint.textContent =
    "Theme, zoom, font size, keyboard shortcut bindings, and your last-active view are all remembered on this device.";
  const resetAllButton = document.createElement("button");
  resetAllButton.type = "button";
  resetAllButton.className = "wx-settings-reset-all";
  resetAllButton.textContent = "Reset all settings to defaults";
  resetAllButton.addEventListener("click", () => {
    if (!deps.win.confirm("Reset theme, zoom, font size, and keyboard shortcuts to their defaults?")) return;
    deps.onResetAll();
  });
  session.append(sessionHint, resetAllButton);

  wrap.append(appearance, view, session);
  return wrap;
}

function stepperRow(
  label: string,
  getText: () => string,
  onDown: () => void,
  onUp: () => void,
  downLabel: string,
  upLabel: string,
): { row: HTMLElement; refresh: () => void } {
  const row = document.createElement("div");
  row.className = "wx-settings-row";
  const labelEl = document.createElement("span");
  labelEl.className = "wx-settings-row-label";
  labelEl.textContent = label;

  const stepper = document.createElement("div");
  stepper.className = "wx-settings-stepper";
  const downButton = document.createElement("button");
  downButton.type = "button";
  downButton.textContent = downLabel;
  downButton.addEventListener("click", onDown);
  const valueEl = document.createElement("span");
  valueEl.className = "wx-settings-stepper-value";
  const upButton = document.createElement("button");
  upButton.type = "button";
  upButton.textContent = upLabel;
  upButton.addEventListener("click", onUp);
  stepper.append(downButton, valueEl, upButton);

  row.append(labelEl, stepper);

  function refresh(): void {
    valueEl.textContent = getText();
  }
  refresh();

  return { row, refresh };
}

// -- Keyboard Shortcuts -----------------------------------------------------

function renderShortcuts(deps: SettingsPanelDeps, teardownFns: Array<() => void>): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "wx-settings-shortcuts";

  const toolbar = document.createElement("div");
  toolbar.className = "wx-settings-shortcuts-toolbar";
  const resetButton = document.createElement("button");
  resetButton.type = "button";
  resetButton.className = "wx-settings-reset-all";
  resetButton.textContent = "Reset to Defaults";
  resetButton.addEventListener("click", () => {
    if (!deps.win.confirm("Reset all keyboard shortcuts to their default bindings?")) return;
    stopCapture();
    deps.shortcutsController.resetAll();
  });
  toolbar.appendChild(resetButton);

  const list = document.createElement("div");
  list.className = "wx-settings-shortcuts-list";

  wrap.append(toolbar, list);

  let capturingId: string | null = null;
  let captureCleanup: (() => void) | null = null;
  let lastError: { id: string; message: string } | null = null;

  function stopCapture(): void {
    captureCleanup?.();
    captureCleanup = null;
    capturingId = null;
  }

  function startCapture(id: string): void {
    stopCapture();
    lastError = null;
    capturingId = id;
    render();

    const onCapture = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (MODIFIER_CODES.includes(e.code)) return; // still waiting for a real key
      const wasEscape = e.code === "Escape"; // Escape always cancels, never binds
      stopCapture();
      if (wasEscape) {
        render();
        return;
      }
      const result = deps.shortcutsController.rebind(id, bindingFromEvent(e));
      if (!result.ok) {
        lastError = { id, message: `Already used by "${result.conflictWith.label}".` };
        render();
      }
      // On success, shortcutsController.rebind() already notified
      // subscribers — this panel's own subscribe(render) below re-renders
      // with the new binding, so there's nothing more to do here.
    };
    deps.win.addEventListener("keydown", onCapture, true);
    captureCleanup = () => deps.win.removeEventListener("keydown", onCapture, true);
  }

  function renderRow(item: ShortcutListItem): HTMLElement {
    const row = document.createElement("div");
    row.className = "wx-settings-shortcut-row";
    if (item.disabled) row.classList.add("wx-settings-shortcut-disabled");

    const label = document.createElement("span");
    label.className = "wx-settings-shortcut-label";
    label.textContent = item.label;

    const bindingEl = document.createElement("span");
    bindingEl.className = "wx-settings-shortcut-binding";
    bindingEl.textContent = item.disabled ? "Disabled" : formatBinding(item.binding);

    const isCapturingThis = capturingId === item.id;
    const rebindButton = document.createElement("button");
    rebindButton.type = "button";
    rebindButton.className = "wx-settings-shortcut-rebind";
    rebindButton.disabled = item.disabled;
    rebindButton.textContent = isCapturingThis ? "Press a key… (Esc to cancel)" : "Rebind";
    rebindButton.addEventListener("click", () => {
      if (isCapturingThis) {
        stopCapture();
        render();
      } else {
        startCapture(item.id);
      }
    });

    const toggleButton = document.createElement("button");
    toggleButton.type = "button";
    toggleButton.className = "wx-settings-shortcut-toggle";
    toggleButton.textContent = item.disabled ? "Enable" : "Disable";
    toggleButton.addEventListener("click", () => {
      stopCapture();
      deps.shortcutsController.setDisabled(item.id, !item.disabled);
    });

    row.append(label, bindingEl, rebindButton, toggleButton);

    if (lastError?.id === item.id) {
      const errorEl = document.createElement("span");
      errorEl.className = "wx-settings-shortcut-error";
      errorEl.textContent = lastError.message;
      row.appendChild(errorEl);
    }

    return row;
  }

  function render(): void {
    list.innerHTML = "";
    const items = deps.shortcutsController.list();
    const categories = Array.from(new Set(items.map((i) => i.category)));
    for (const category of categories) {
      const section = document.createElement("div");
      section.className = "wx-settings-shortcut-category";
      const categoryHeading = document.createElement("h4");
      categoryHeading.textContent = category;
      section.appendChild(categoryHeading);
      for (const item of items.filter((i) => i.category === category)) {
        section.appendChild(renderRow(item));
      }
      list.appendChild(section);
    }
  }

  render();
  const unsubscribe = deps.shortcutsController.subscribe(render);
  teardownFns.push(() => {
    stopCapture();
    unsubscribe();
  });

  return wrap;
}
