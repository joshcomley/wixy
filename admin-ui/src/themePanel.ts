// The theme panel (spec/05-editor.md §3): `#/theme` — colors, fonts, effects, each
// live-applying to an embedded preview iframe plus a per-token/per-panel "reset to
// published". See decisions/00021 for the design questions this resolves (why an
// embedded iframe reusing `editView.ts`'s machinery wholesale, why "index" as the
// fixed preview page, why fonts need a second message alongside `themeVars`, why
// per-token SET granularity is "one whole font role" not "one field per role").

import type { AdminApi, ThemeData } from "./api";
import type { EditView, MountEditViewDeps, OpQueueLike } from "./editView";
import { buildFontsUrl, type FontSpec } from "./googleFonts";
import { GOOGLE_FONTS_CATALOG, WEIGHT_OPTIONS, type FontCategory } from "./googleFontsCatalog";
import type { DraftOp } from "./protocol";
import { themeVarsFromTheme } from "./themeVars";

/** decisions/00021: the theme panel always previews the home page — every wixy
 * project has one (spec/03's migration establishes "index" as the fixed homepage
 * slug; every fixture/test repo in this codebase has one too), and a fixed choice
 * is simpler and more predictable than tracking "most recently edited". */
const PREVIEW_PAGE = "index";

const FONT_ROLES: ReadonlyArray<{ role: string; label: string; category: FontCategory }> = [
  { role: "serif", label: "Headings", category: "serif" },
  { role: "sans", label: "Body", category: "sans-serif" },
  { role: "script", label: "Script", category: "script" },
];

type MountEditViewFn = (page: string, deps: MountEditViewDeps) => EditView;

export interface ThemePanelDeps {
  api: AdminApi;
  opQueue: OpQueueLike;
  mountEditView: MountEditViewFn;
  win?: Window;
}

export interface ThemePanel {
  readonly element: HTMLElement;
  /** The shell calls this with every batch the OpQueue just got accepted for
   * (spec/05 §2's "echoes accepted ops back down") — mirrors `EditView.applyOps`'s
   * role but with different semantics: a SET op is already reflected optimistically
   * (no action needed), but a DISCARD op reverts to whatever the checkout currently
   * has, which isn't computable client-side — so any accepted `file:"theme"` discard
   * triggers a refetch + full re-render + re-applied live preview. */
  onOpsAccepted(ops: DraftOp[]): void;
  teardown(): void;
}

function isValidHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

export function mountThemePanel(deps: ThemePanelDeps): ThemePanel {
  const win = deps.win ?? window;

  const root = document.createElement("div");
  root.className = "wx-theme-panel";

  const controls = document.createElement("div");
  controls.className = "wx-theme-controls";
  controls.textContent = "Loading…";

  const previewWrap = document.createElement("div");
  previewWrap.className = "wx-theme-preview";

  root.append(controls, previewWrap);

  const view = deps.mountEditView(PREVIEW_PAGE, {
    api: deps.api,
    opQueue: deps.opQueue,
    win,
    // The overlay navigates its OWN iframe on an internal link click regardless
    // (editor/src/overlay.ts's handlePlainAnchorClick sets `win.location.href`
    // directly) — this callback is only for whether the SHELL's own routing state
    // should follow along too, which it deliberately doesn't here: the theme panel
    // isn't tied to page routing the way `#/edit/<page>` is.
    onOverlayNavigated: () => {},
    // Re-post the current vars every time the overlay (re)loads — a change made
    // while the iframe was still loading otherwise lands in about:blank and is
    // silently lost (the E2E-3 full-suite flake, decisions/00076).
    onOverlayReady: () => liveApply(),
  });
  previewWrap.appendChild(view.element);

  let theme: ThemeData | null = null;
  let cancelled = false;

  function liveApply(): void {
    if (theme === null) return;
    view.postMessage({ wx: 1, type: "themeVars", vars: themeVarsFromTheme(theme) });
    view.postMessage({ wx: 1, type: "themeFonts", url: buildFontsUrl(theme.fonts) });
  }

  function sectionHeader(title: string, onResetAll: (() => void) | null): HTMLElement {
    const header = document.createElement("div");
    header.className = "wx-theme-section-header";
    const heading = document.createElement("h3");
    heading.textContent = title;
    header.appendChild(heading);
    if (onResetAll !== null) {
      const resetAllButton = document.createElement("button");
      resetAllButton.type = "button";
      resetAllButton.className = "wx-theme-reset-all";
      resetAllButton.textContent = "Reset all to published";
      resetAllButton.addEventListener("click", onResetAll);
      header.appendChild(resetAllButton);
    }
    return header;
  }

  function colorRow(key: string, palette: Record<string, string>): HTMLElement {
    const row = document.createElement("div");
    row.className = "wx-theme-color-row";
    const label = document.createElement("span");
    label.className = "wx-theme-color-label";
    label.textContent = key;

    const colorInput = document.createElement("input");
    colorInput.type = "color";
    const hexInput = document.createElement("input");
    hexInput.type = "text";
    hexInput.className = "wx-theme-hex";

    function setDisplayed(value: string): void {
      hexInput.value = value;
      if (isValidHexColor(value)) colorInput.value = value;
    }
    setDisplayed(palette[key] ?? "#000000");

    function applyLive(value: string): void {
      if (theme === null) return;
      theme.colors[key] = value;
      liveApply();
    }
    function commitValue(value: string): void {
      deps.opQueue.enqueue({ file: "theme", path: `colors.${key}`, value });
    }

    colorInput.addEventListener("input", () => {
      setDisplayed(colorInput.value);
      applyLive(colorInput.value);
    });
    colorInput.addEventListener("change", () => commitValue(colorInput.value));
    hexInput.addEventListener("input", () => {
      if (isValidHexColor(hexInput.value)) {
        colorInput.value = hexInput.value;
        applyLive(hexInput.value);
      }
    });
    hexInput.addEventListener("change", () => {
      if (isValidHexColor(hexInput.value)) commitValue(hexInput.value);
    });

    const presets = document.createElement("div");
    presets.className = "wx-theme-presets";
    for (const [presetKey, presetValue] of Object.entries(palette)) {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "wx-theme-preset-swatch";
      swatch.style.backgroundColor = presetValue;
      swatch.title = `${presetKey}: ${presetValue}`;
      swatch.addEventListener("click", () => {
        setDisplayed(presetValue);
        applyLive(presetValue);
        commitValue(presetValue);
      });
      presets.appendChild(swatch);
    }

    const resetButton = document.createElement("button");
    resetButton.type = "button";
    resetButton.className = "wx-theme-reset";
    resetButton.textContent = "Reset";
    resetButton.addEventListener("click", () => {
      deps.opQueue.enqueue({ file: "theme", path: `colors.${key}`, discard: true });
    });

    row.append(label, colorInput, hexInput, presets, resetButton);
    return row;
  }

  function fontRoleRow(roleInfo: (typeof FONT_ROLES)[number], spec: FontSpec): HTMLElement {
    const row = document.createElement("div");
    row.className = "wx-theme-font-row";
    const heading = document.createElement("h4");
    heading.textContent = roleInfo.label;

    const select = document.createElement("select");
    select.className = "wx-theme-font-picker";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Choose a curated family…";
    placeholder.disabled = true;
    placeholder.selected = true;
    select.appendChild(placeholder);
    const categories: FontCategory[] = ["serif", "sans-serif", "script"];
    for (const category of categories) {
      const group = document.createElement("optgroup");
      group.label = category;
      for (const font of GOOGLE_FONTS_CATALOG.filter((f) => f.category === category)) {
        const option = document.createElement("option");
        option.value = font.family;
        option.textContent = font.family;
        group.appendChild(option);
      }
      select.appendChild(group);
    }

    const familyInput = document.createElement("input");
    familyInput.type = "text";
    familyInput.className = "wx-theme-font-family";
    familyInput.placeholder = "Custom family";
    familyInput.value = spec.family;

    const weightsWrap = document.createElement("div");
    weightsWrap.className = "wx-theme-weights";
    const weightBoxes = new Map<string, HTMLInputElement>();
    for (const weight of WEIGHT_OPTIONS) {
      const wrap = document.createElement("label");
      wrap.className = "wx-field-row-checkbox";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = spec.weights.includes(weight);
      wrap.append(box, document.createTextNode(weight));
      weightBoxes.set(weight, box);
      weightsWrap.appendChild(wrap);
    }

    const italicBox = document.createElement("input");
    italicBox.type = "checkbox";
    italicBox.checked = spec.italics;
    const italicLabel = document.createElement("label");
    italicLabel.className = "wx-field-row-checkbox";
    italicLabel.append(italicBox, document.createTextNode("Italic"));

    function currentSpec(): FontSpec {
      return {
        family: familyInput.value,
        weights: WEIGHT_OPTIONS.filter((weight) => weightBoxes.get(weight)?.checked === true),
        italics: italicBox.checked,
      };
    }
    function applyLive(): void {
      if (theme === null) return;
      theme.fonts[roleInfo.role] = currentSpec();
      liveApply();
    }
    function commitSpec(): void {
      // A fresh object literal, not the `FontSpec`-typed `currentSpec()` return value
      // directly: TS only structurally matches a plain interface against `JsonValue`'s
      // indexed-object arm when the source is a literal, not a named type without its
      // own index signature.
      const spec = currentSpec();
      deps.opQueue.enqueue({
        file: "theme",
        path: `fonts.${roleInfo.role}`,
        value: { family: spec.family, weights: spec.weights, italics: spec.italics },
      });
    }

    select.addEventListener("change", () => {
      if (select.value === "") return;
      familyInput.value = select.value;
      applyLive();
      commitSpec();
      select.value = "";
    });
    familyInput.addEventListener("input", applyLive);
    familyInput.addEventListener("change", commitSpec);
    for (const box of weightBoxes.values()) {
      box.addEventListener("change", () => {
        applyLive();
        commitSpec();
      });
    }
    italicBox.addEventListener("change", () => {
      applyLive();
      commitSpec();
    });

    const resetButton = document.createElement("button");
    resetButton.type = "button";
    resetButton.className = "wx-theme-reset";
    resetButton.textContent = "Reset";
    resetButton.addEventListener("click", () => {
      deps.opQueue.enqueue({ file: "theme", path: `fonts.${roleInfo.role}`, discard: true });
    });

    row.append(heading, select, familyInput, weightsWrap, italicLabel, resetButton);
    return row;
  }

  function shadowRow(initial: string): HTMLElement {
    const row = document.createElement("div");
    row.className = "wx-theme-shadow-row";
    const label = document.createElement("span");
    label.textContent = "Shadow";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "wx-theme-shadow-input";
    input.value = initial;
    input.addEventListener("input", () => {
      if (theme === null) return;
      theme.shadow = input.value;
      liveApply();
    });
    input.addEventListener("change", () => {
      deps.opQueue.enqueue({ file: "theme", path: "shadow", value: input.value });
    });
    const resetButton = document.createElement("button");
    resetButton.type = "button";
    resetButton.className = "wx-theme-reset";
    resetButton.textContent = "Reset";
    resetButton.addEventListener("click", () => {
      deps.opQueue.enqueue({ file: "theme", path: "shadow", discard: true });
    });
    row.append(label, input, resetButton);
    return row;
  }

  function renderSections(): void {
    controls.innerHTML = "";
    if (theme === null) return;
    const current = theme;
    const palette = { ...current.colors };

    const colorsSection = document.createElement("section");
    colorsSection.className = "wx-theme-section";
    colorsSection.appendChild(
      sectionHeader("Colors", () => {
        for (const key of Object.keys(current.colors)) {
          deps.opQueue.enqueue({ file: "theme", path: `colors.${key}`, discard: true });
        }
      }),
    );
    for (const key of Object.keys(current.colors).sort()) {
      colorsSection.appendChild(colorRow(key, palette));
    }

    const fontsSection = document.createElement("section");
    fontsSection.className = "wx-theme-section";
    fontsSection.appendChild(
      sectionHeader("Fonts", () => {
        for (const role of Object.keys(current.fonts)) {
          deps.opQueue.enqueue({ file: "theme", path: `fonts.${role}`, discard: true });
        }
      }),
    );
    for (const roleInfo of FONT_ROLES) {
      const spec = current.fonts[roleInfo.role] ?? { family: "", weights: [], italics: false };
      fontsSection.appendChild(fontRoleRow(roleInfo, spec));
    }

    const effectsSection = document.createElement("section");
    effectsSection.className = "wx-theme-section";
    effectsSection.appendChild(sectionHeader("Effects", null));
    effectsSection.appendChild(shadowRow(current.shadow));

    controls.append(colorsSection, fontsSection, effectsSection);
  }

  async function loadTheme(): Promise<void> {
    try {
      const fetched = await deps.api.getTheme();
      if (cancelled) return;
      theme = fetched;
      renderSections();
      liveApply();
    } catch {
      if (cancelled) return;
      controls.textContent = "Couldn't load the theme.";
    }
  }

  void loadTheme();

  return {
    element: root,
    onOpsAccepted(ops: DraftOp[]): void {
      const themeWasDiscarded = ops.some(
        (op) => op.file === "theme" && "discard" in op && op.discard,
      );
      if (themeWasDiscarded) void loadTheme();
    },
    teardown(): void {
      cancelled = true;
      view.teardown();
    },
  };
}
