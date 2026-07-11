// The Settings panel (#/settings, #/settings/appearance,
// #/settings/shortcuts) — Uxer's Settings-view mandate (item 5) plus
// surfacing the session-persistence story (item 6) in one place. General:
// quick appearance controls that ALSO exist in the topbar chrome (theme
// mode, zoom, font size) — Uxer's own doc is explicit that's expected
// ("the title bar toggle is mandatory for quick access... the Settings
// view may also include a theme selector"), plus a session-state summary
// and a reset-everything escape hatch. Appearance: the full theme editor
// (item 9) — a separate tab from General's quick toggle, matching Uxer's
// own distinction ("the toggle lets a user *pick* a preset; the theme
// editor lets them *tailor* one"). Keyboard Shortcuts: list every shortcut
// (grouped by category), rebind, disable, reset to defaults.

import { AA_LARGE_TEXT, AA_NORMAL_TEXT, contrastRatioHex, passesAA } from "./contrast";
import type { FontScaleController } from "./fontScale";
import type { SettingsPage } from "./router";
import {
  bindingFromEvent,
  formatBinding,
  MODIFIER_CODES,
  type ShortcutListItem,
  type ShortcutsController,
} from "./shortcuts";
import { resolveVariant, type ThemeController, type ThemeMode, type ThemeVariant } from "./theme";
import { CONTRAST_PAIRS, PALETTE, type ContrastPair, type PaletteEntry, type ThemeEditorController } from "./themeEditor";
import type { ZoomController } from "./zoom";

export interface SettingsPanelDeps {
  win: Window;
  page: SettingsPage;
  themeController: ThemeController;
  zoomController: ZoomController;
  fontScaleController: FontScaleController;
  shortcutsController: ShortcutsController;
  themeEditorController: ThemeEditorController;
  onNavigate: (page: SettingsPage) => void;
  /** Resets theme/zoom/font-scale/shortcuts/custom-theme to defaults AND
   * clears the persisted last-active-route — owned by shell.ts since it's
   * the one place all the controllers are already in scope together. */
  onResetAll: () => void;
}

export interface SettingsPanel {
  element: HTMLElement;
  teardown(): void;
}

const THEME_MODE_LABELS: Record<ThemeMode, string> = { light: "Light", dark: "Dark", system: "System" };
const THEME_MODES: readonly ThemeMode[] = ["light", "dark", "system"];
const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;

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
  function tabButton(label: string, page: SettingsPage): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "wx-settings-tab";
    button.textContent = label;
    button.classList.toggle("wx-settings-tab-active", deps.page === page);
    button.addEventListener("click", () => deps.onNavigate(page));
    return button;
  }
  tabs.append(tabButton("General", "general"), tabButton("Appearance", "appearance"), tabButton("Keyboard Shortcuts", "shortcuts"));
  root.appendChild(tabs);

  const body = document.createElement("div");
  root.appendChild(body);

  const teardownFns: Array<() => void> = [];
  const pageRenderers: Record<SettingsPage, (d: SettingsPanelDeps, t: Array<() => void>) => HTMLElement> = {
    general: renderGeneral,
    appearance: renderAppearance,
    shortcuts: renderShortcuts,
  };
  body.appendChild(pageRenderers[deps.page](deps, teardownFns));

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

  const appearanceLink = document.createElement("p");
  appearanceLink.className = "wx-settings-hint";
  const appearanceLinkButton = document.createElement("button");
  appearanceLinkButton.type = "button";
  appearanceLinkButton.className = "wx-settings-link-button";
  appearanceLinkButton.textContent = "Open the theme editor to tailor colors →";
  appearanceLinkButton.addEventListener("click", () => deps.onNavigate("appearance"));
  appearanceLink.appendChild(appearanceLinkButton);

  appearance.append(themeRow, themeResolvedRow, appearanceLink);

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
    "Theme, custom colors, zoom, font size, keyboard shortcut bindings, and your last-active view are all remembered on this device.";
  const resetAllButton = document.createElement("button");
  resetAllButton.type = "button";
  resetAllButton.className = "wx-settings-reset-all";
  resetAllButton.textContent = "Reset all settings to defaults";
  resetAllButton.addEventListener("click", () => {
    if (!deps.win.confirm("Reset theme, custom colors, zoom, font size, and keyboard shortcuts to their defaults?")) return;
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

// -- Appearance (theme editor) -----------------------------------------------

function themeColorRow(
  entry: PaletteEntry,
  getValue: () => string,
  onChange: (hex: string) => void,
): { row: HTMLElement; refresh: () => void } {
  const row = document.createElement("div");
  row.className = "wx-settings-color-row";

  const label = document.createElement("span");
  label.className = "wx-settings-color-label";
  label.textContent = entry.label;

  const colorInput = document.createElement("input");
  colorInput.type = "color";
  const hexInput = document.createElement("input");
  hexInput.type = "text";
  hexInput.className = "wx-settings-color-hex";
  hexInput.spellcheck = false;
  hexInput.maxLength = 7;

  function setDisplayed(value: string): void {
    hexInput.value = value;
    if (HEX_PATTERN.test(value)) colorInput.value = value;
  }

  colorInput.addEventListener("input", () => {
    setDisplayed(colorInput.value);
    onChange(colorInput.value);
  });
  hexInput.addEventListener("input", () => {
    if (HEX_PATTERN.test(hexInput.value)) {
      colorInput.value = hexInput.value;
      onChange(hexInput.value);
    }
  });

  row.append(label, colorInput, hexInput);

  function refresh(): void {
    setDisplayed(getValue());
  }
  refresh();

  return { row, refresh };
}

function contrastPairRow(
  pair: ContrastPair,
  getFg: () => string,
  getBg: () => string,
): { row: HTMLElement; refresh: () => void } {
  const row = document.createElement("div");
  row.className = "wx-settings-contrast-row";
  const label = document.createElement("span");
  label.className = "wx-settings-contrast-label";
  label.textContent = pair.label;
  const swatches = document.createElement("span");
  swatches.className = "wx-settings-contrast-swatches";
  const fgSwatch = document.createElement("span");
  fgSwatch.className = "wx-settings-contrast-swatch";
  const bgSwatch = document.createElement("span");
  bgSwatch.className = "wx-settings-contrast-swatch";
  swatches.append(fgSwatch, bgSwatch);
  const ratioEl = document.createElement("span");
  ratioEl.className = "wx-settings-contrast-ratio";
  const badgeEl = document.createElement("span");
  badgeEl.className = "wx-settings-contrast-badge";
  row.append(label, swatches, ratioEl, badgeEl);

  function refresh(): void {
    const fg = getFg();
    const bg = getBg();
    fgSwatch.style.backgroundColor = fg;
    bgSwatch.style.backgroundColor = bg;
    const ratio = contrastRatioHex(fg, bg);
    if (ratio === null) {
      ratioEl.textContent = "—";
      badgeEl.textContent = "";
      badgeEl.className = "wx-settings-contrast-badge";
      return;
    }
    ratioEl.textContent = `${ratio.toFixed(2)}:1`;
    const pass = passesAA(ratio, pair.isLargeOrUi);
    badgeEl.textContent = pass ? "AA ✓" : "Fail ✗";
    badgeEl.className = `wx-settings-contrast-badge ${pass ? "wx-settings-contrast-pass" : "wx-settings-contrast-fail"}`;
    badgeEl.title = `Needs ${pair.isLargeOrUi ? AA_LARGE_TEXT : AA_NORMAL_TEXT}:1 for WCAG AA`;
  }
  refresh();

  return { row, refresh };
}

function renderAppearance(deps: SettingsPanelDeps, teardownFns: Array<() => void>): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "wx-settings-appearance";
  const editor = deps.themeEditorController;

  const intro = document.createElement("p");
  intro.className = "wx-settings-hint";
  intro.textContent =
    "Tailor the shipped palette for each theme variant. Changes preview live across the whole admin as you edit — nothing is written to this device until you click Save.";
  wrap.appendChild(intro);

  let editingVariant: ThemeVariant = resolveVariant(deps.themeController.getMode(), deps.win);

  const toolbar = document.createElement("div");
  toolbar.className = "wx-settings-appearance-toolbar";
  const variantLabel = document.createElement("span");
  variantLabel.className = "wx-settings-row-label";
  variantLabel.textContent = "Editing";
  const variantGroup = document.createElement("div");
  variantGroup.className = "wx-settings-button-group";
  const lightButton = document.createElement("button");
  lightButton.type = "button";
  lightButton.textContent = "Light";
  const darkButton = document.createElement("button");
  darkButton.type = "button";
  darkButton.textContent = "Dark";
  variantGroup.append(lightButton, darkButton);
  toolbar.append(variantLabel, variantGroup);
  wrap.appendChild(toolbar);

  const colorRefreshers: Array<() => void> = [];
  const contrastRefreshers: Array<() => void> = [];

  function renderVariantButtons(): void {
    lightButton.classList.toggle("wx-settings-button-active", editingVariant === "light");
    darkButton.classList.toggle("wx-settings-button-active", editingVariant === "dark");
  }
  function refreshAll(): void {
    colorRefreshers.forEach((fn) => fn());
    contrastRefreshers.forEach((fn) => fn());
    refreshActions();
  }
  lightButton.addEventListener("click", () => {
    editingVariant = "light";
    renderVariantButtons();
    refreshAll();
  });
  darkButton.addEventListener("click", () => {
    editingVariant = "dark";
    renderVariantButtons();
    refreshAll();
  });
  renderVariantButtons();

  // -- Color categories, grouped in PALETTE's own declared order --------------
  const categories = Array.from(new Set(PALETTE.map((entry) => entry.category)));
  for (const category of categories) {
    const section = settingsSection(category);
    for (const entry of PALETTE.filter((p) => p.category === category)) {
      const { row, refresh } = themeColorRow(
        entry,
        () => editor.getEffective(editingVariant)[entry.key],
        (hex) => editor.setColor(editingVariant, entry.key, hex),
      );
      colorRefreshers.push(refresh);
      section.appendChild(row);
    }
    wrap.appendChild(section);
  }

  // -- Contrast -------------------------------------------------------------
  const contrastSection = settingsSection("Contrast (WCAG AA)");
  for (const pair of CONTRAST_PAIRS) {
    const { row, refresh } = contrastPairRow(
      pair,
      () => (pair.fg === "white" ? "#ffffff" : editor.getEffective(editingVariant)[pair.fg]),
      () => editor.getEffective(editingVariant)[pair.bg],
    );
    contrastRefreshers.push(refresh);
    contrastSection.appendChild(row);
  }
  wrap.appendChild(contrastSection);

  // -- Save / Reset / Discard / Export / Import --------------------------------
  const actions = settingsSection("Save, Export & Import");

  const dirtyHint = document.createElement("p");
  dirtyHint.className = "wx-settings-hint";
  dirtyHint.textContent = "You have unsaved changes.";

  const warningEl = document.createElement("p");
  warningEl.className = "wx-settings-theme-warning";
  warningEl.hidden = true;

  const buttonRow = document.createElement("div");
  buttonRow.className = "wx-settings-theme-actions";

  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.className = "wx-settings-save-button";
  saveButton.textContent = "Save";

  const saveAnywayButton = document.createElement("button");
  saveAnywayButton.type = "button";
  saveAnywayButton.className = "wx-settings-reset-all";
  saveAnywayButton.textContent = "Save anyway";
  saveAnywayButton.hidden = true;

  const discardButton = document.createElement("button");
  discardButton.type = "button";
  discardButton.textContent = "Discard unsaved changes";
  discardButton.addEventListener("click", () => editor.discardDraft());

  const resetVariantButton = document.createElement("button");
  resetVariantButton.type = "button";
  resetVariantButton.className = "wx-settings-reset-all";
  resetVariantButton.textContent = `Reset ${editingVariant} theme to defaults`;
  resetVariantButton.addEventListener("click", () => {
    if (!deps.win.confirm(`Reset the ${editingVariant} theme to its shipped defaults?`)) return;
    editor.resetVariant(editingVariant);
  });

  function failingBodyTextPairs(variant: ThemeVariant): ContrastPair[] {
    return CONTRAST_PAIRS.filter((pair) => pair.isBodyText).filter((pair) => {
      const fg = pair.fg === "white" ? "#ffffff" : editor.getEffective(variant)[pair.fg];
      const bg = editor.getEffective(variant)[pair.bg];
      const ratio = contrastRatioHex(fg, bg);
      return ratio === null || !passesAA(ratio, pair.isLargeOrUi);
    });
  }

  let acknowledgedFailures = false;

  function attemptSave(): void {
    const failures = (["light", "dark"] as const).flatMap((variant) =>
      failingBodyTextPairs(variant).map((pair) => `${pair.label} (${variant})`),
    );
    if (failures.length > 0 && !acknowledgedFailures) {
      warningEl.hidden = false;
      warningEl.textContent = `This would fail WCAG AA for: ${failures.join(", ")}. Adjust the colors above, or click "Save anyway".`;
      saveAnywayButton.hidden = false;
      return;
    }
    editor.save();
    acknowledgedFailures = false;
    warningEl.hidden = true;
    saveAnywayButton.hidden = true;
  }
  saveButton.addEventListener("click", attemptSave);
  saveAnywayButton.addEventListener("click", () => {
    acknowledgedFailures = true;
    attemptSave();
  });

  buttonRow.append(saveButton, saveAnywayButton, discardButton, resetVariantButton);

  const exportImportRow = document.createElement("div");
  exportImportRow.className = "wx-settings-theme-actions";
  const exportButton = document.createElement("button");
  exportButton.type = "button";
  exportButton.textContent = "Export…";
  const importButton = document.createElement("button");
  importButton.type = "button";
  importButton.textContent = "Import…";
  exportImportRow.append(exportButton, importButton);

  const exportArea = document.createElement("textarea");
  exportArea.className = "wx-settings-theme-textarea";
  exportArea.readOnly = true;
  exportArea.hidden = true;
  exportButton.addEventListener("click", () => {
    exportArea.hidden = !exportArea.hidden;
    if (!exportArea.hidden) exportArea.value = editor.exportJson();
  });

  const importArea = document.createElement("textarea");
  importArea.className = "wx-settings-theme-textarea";
  importArea.placeholder = "Paste an exported theme JSON snippet here…";
  importArea.hidden = true;
  const importApplyButton = document.createElement("button");
  importApplyButton.type = "button";
  importApplyButton.textContent = "Apply";
  importApplyButton.hidden = true;
  const importErrorEl = document.createElement("span");
  importErrorEl.className = "wx-settings-shortcut-error";
  importErrorEl.hidden = true;
  importButton.addEventListener("click", () => {
    importArea.hidden = !importArea.hidden;
    importApplyButton.hidden = importArea.hidden;
    importErrorEl.hidden = true;
  });
  importApplyButton.addEventListener("click", () => {
    const result = editor.importJson(importArea.value);
    if (!result.ok) {
      importErrorEl.hidden = false;
      importErrorEl.textContent = result.message;
      return;
    }
    importErrorEl.hidden = true;
    importArea.hidden = true;
    importApplyButton.hidden = true;
    importArea.value = "";
  });

  function refreshActions(): void {
    const dirty = editor.isDirty();
    dirtyHint.hidden = !dirty;
    discardButton.disabled = !dirty;
    resetVariantButton.textContent = `Reset ${editingVariant} theme to defaults`;
    if (!dirty) {
      warningEl.hidden = true;
      saveAnywayButton.hidden = true;
      acknowledgedFailures = false;
    }
  }
  refreshActions();

  actions.append(
    dirtyHint,
    warningEl,
    buttonRow,
    exportImportRow,
    exportArea,
    importArea,
    importApplyButton,
    importErrorEl,
  );
  wrap.appendChild(actions);

  const unsubEditor = editor.subscribe(refreshAll);
  teardownFns.push(unsubEditor);

  return wrap;
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
