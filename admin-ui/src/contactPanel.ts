// The Contact panel (decisions/00129): `/admin/contact`, a main nav tab —
// promoted out of Settings (where it lived as decisions/00127's "contact" tab)
// because the operator wanted it somewhere more visible than buried behind a
// gear icon. Phone/email/address/map all live in `content/_global.json`
// (spec/02 §5) — already a SINGLE shared source every page's template
// references via `@phone`/`@email`/`@address`/`@mapSrc` (never hardcoded
// per-page, `builder/render.py`), and the inline overlay editor already wrote
// text/address edits back here correctly before this tab existed
// (`opTargeting.directOpTarget`, `@key` -> `{file:"_global", path:key}`).
// Auto-save-per-field (the same `opQueue.enqueue`/`discard` pattern
// `themePanel.ts`'s color rows use), NOT the Before & After section's
// staged-save model (decisions/00118) — these fields need no Undo stack or
// review step.

import type { AdminApi, GlobalSettings } from "./api";
import type { OpQueueLike } from "./editView";
import { mountMapPicker } from "./mapPicker";
import { parseCoords, roundCoord } from "./mapPickerModel";

export interface ContactPanelDeps {
  win: Window;
  api: AdminApi;
  opQueue: OpQueueLike;
}

export interface ContactPanel {
  element: HTMLElement;
  teardown(): void;
}

function settingsSection(title: string): HTMLElement {
  const section = document.createElement("div");
  section.className = "wx-settings-section";
  const header = document.createElement("h3");
  header.textContent = title;
  section.appendChild(header);
  return section;
}

/** `_global.json`'s `address` embeds a literal `<br>` for its one line break
 * (the plain-text-render-ready-HTML convention, decisions/00075) — editing
 * that as a raw text string would show her a literal "<br>" she'd have to
 * understand and never break. A plain `<textarea>` where each line she types
 * becomes one `<br>` on save is the honest, correct UI for a short multi-line
 * address; these two pure conversions are the whole of that translation.
 * Exported for direct unit testing (no DOM needed). */
export function addressToTextareaValue(stored: string): string {
  return stored.replace(/<br\s*\/?>/gi, "\n");
}

export function textareaValueToAddress(typed: string): string {
  return typed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("<br>");
}

/** `phone`/`email` are DISPLAY text; every actual `tel:`/`mailto:` LINK on the
 * site (the footer partial, the Contact page's Call/Email cards) binds a
 * SEPARATE `phoneHref`/`emailHref` key instead (`data-wx-href="@phoneHref"`)
 * — `data-wx`/`data-wx-href` have always been independently bindable, this
 * tab is just the first editor surface for a field pair that needs both kept
 * in lockstep. Committing the display key alone would silently strand every
 * link at its old value forever, with no error anywhere (caught in review,
 * decisions/00127). `hrefKey`/`hrefKind` make that derivation a config-level
 * fact for `commit()`/Reset to apply uniformly, rather than a one-off. */
interface ContactFieldConfig {
  key: string;
  label: string;
  hint: string;
  inputType: "text" | "email" | "tel";
  multiline?: boolean;
  hrefKey?: string;
  hrefKind?: "tel" | "mailto";
  /** Extra `_global` keys this field's Reset ALSO discards — `address` lists
   * `mapCoords`/`mapSrc` (decisions/00129) so Resetting the address always
   * returns the WHOLE map section to its true published state too, never
   * leaving a just-derived `mapSrc` stale relative to a reverted address.
   * Discarding a key with nothing currently staged is a harmless no-op. */
  alsoDiscardsOnReset?: readonly string[];
}

const CONTACT_FIELDS: readonly ContactFieldConfig[] = [
  {
    key: "phone",
    label: "Contact phone",
    hint: "Shown in the footer and on the Contact page.",
    inputType: "tel",
    hrefKey: "phoneHref",
    hrefKind: "tel",
  },
  {
    key: "email",
    label: "Contact email",
    hint: "Shown in the footer and on the Contact page.",
    inputType: "email",
    hrefKey: "emailHref",
    hrefKind: "mailto",
  },
  {
    key: "address",
    label: "Address",
    hint: "Your address, exactly as it should appear on your site — press Enter to start a new line.",
    inputType: "text",
    multiline: true,
    alsoDiscardsOnReset: ["mapCoords", "mapSrc"],
  },
];

function contactFieldValue(global: GlobalSettings, key: string): string {
  const value = global[key];
  return typeof value === "string" ? value : "";
}

/** The `tel:`/`mailto:` value a display value implies, kept in lockstep by
 * `commit()` below. A blank display yields a blank href (an inert anchor,
 * not a bare "tel:"/"mailto:" — both pass `is_safe_href`). Phone formatting
 * (spaces, dashes, parens) is stripped to bare digits, preserving only a
 * genuine leading "+" (international dialing prefix); email is used as-is,
 * already trimmed by the caller. Exported for direct unit testing — this is
 * the derivation the reproduction-invariant test checks against the real
 * seeded `_global.json` pair (decisions/00127). */
export function deriveContactHref(kind: "tel" | "mailto", displayValue: string): string {
  if (displayValue === "") return "";
  if (kind === "mailto") return `mailto:${displayValue}`;
  const leadingPlus = displayValue.startsWith("+") ? "+" : "";
  return `tel:${leadingPlus}${displayValue.replace(/\D/g, "")}`;
}

/** `mapSrc` is a DERIVED field, never typed directly: a placed pin
 * (`mapCoords`, `"lat,lng"`) wins when present; otherwise the address IS the
 * map source (the operator's own clarification — "without coordinates, the
 * map should use the address to show where to go"), matching what
 * `pages/contact.html`'s map iframe embedded as a hand-typed URL before this
 * tab existed. Exported for direct unit testing.
 *
 * Not byte-exact with the site's original hand-typed URL, deliberately: that
 * URL happened to drop the comma between town and postcode ("Kidderminster
 * DY10 4JA" vs the stored address's "Kidderminster, DY10 4JA") and used
 * `+`-for-space encoding rather than `encodeURIComponent`'s `%20` — neither
 * is a rule this derivation could generalize from without hard-coding one
 * address's own typo, and Google's `q=` geocoder is comma/encoding-
 * insensitive (both forms resolve to the identical pin) — see decisions/00129
 * for the reproduction-invariant test's exact reasoning. */
export function deriveMapSrc(mapCoords: string, address: string): string {
  const parsed = parseCoords(mapCoords);
  if (parsed !== null) {
    return `https://www.google.com/maps?q=${roundCoord(parsed.lat)},${roundCoord(parsed.lng)}&output=embed`;
  }
  const flatAddress = address
    .split(/<br\s*\/?>/gi)
    .map((line) => line.trim().replace(/,+$/, ""))
    .filter((line) => line.length > 0)
    .join(", ");
  return `https://www.google.com/maps?q=${encodeURIComponent(flatAddress)}&output=embed`;
}

export function mountContactPanel(deps: ContactPanelDeps): ContactPanel {
  const opQueue = deps.opQueue;

  const root = document.createElement("div");
  root.className = "wx-contact-panel";
  const heading = document.createElement("h2");
  heading.textContent = "Contact";
  root.appendChild(heading);

  const body = document.createElement("div");
  body.textContent = "Loading…";
  root.appendChild(body);

  let cancelled = false;
  let activeMapPicker: { teardown(): void } | null = null;

  function renderLoadError(message: string): void {
    activeMapPicker?.teardown();
    activeMapPicker = null;
    body.innerHTML = "";
    const p = document.createElement("p");
    p.className = "wx-settings-hint";
    p.textContent = `Couldn't load contact details: ${message}`;
    body.appendChild(p);
  }

  function fieldRow(config: ContactFieldConfig, global: GlobalSettings): HTMLElement {
    const row = document.createElement("div");
    row.className = "wx-settings-row wx-settings-row-stacked";

    const inputId = `wx-contact-${config.key}`;
    const label = document.createElement("label");
    label.className = "wx-settings-row-label";
    label.textContent = config.label;
    label.htmlFor = inputId;

    const storedRaw = contactFieldValue(global, config.key);
    const originalValue = config.multiline ? addressToTextareaValue(storedRaw) : storedRaw;

    const input = document.createElement(config.multiline ? "textarea" : "input") as
      | HTMLInputElement
      | HTMLTextAreaElement;
    input.id = inputId;
    input.className = config.multiline ? "wx-settings-textarea" : "wx-settings-input";
    if (input instanceof HTMLInputElement) input.type = config.inputType;
    if (input instanceof HTMLTextAreaElement) input.rows = 2;
    input.value = originalValue;

    function commit(): void {
      const toStore = config.multiline ? textareaValueToAddress(input.value) : input.value.trim();
      if (toStore === storedRaw) return;
      opQueue.enqueue({ file: "_global", path: config.key, value: toStore });
      if (config.hrefKey !== undefined && config.hrefKind !== undefined) {
        opQueue.enqueue({ file: "_global", path: config.hrefKey, value: deriveContactHref(config.hrefKind, toStore) });
      }
      // The address is the map source unless a pin overrides it — an address
      // edit while unpinned must keep the map pointed at the right place; a
      // placed pin takes precedence and is never silently overridden here.
      if (config.key === "address" && contactFieldValue(global, "mapCoords") === "") {
        opQueue.enqueue({ file: "_global", path: "mapSrc", value: deriveMapSrc("", toStore) });
      }
    }
    input.addEventListener("change", commit);

    const hint = document.createElement("p");
    hint.className = "wx-settings-hint";
    hint.textContent = config.hint;

    const resetButton = document.createElement("button");
    resetButton.type = "button";
    resetButton.className = "wx-settings-link-button";
    resetButton.textContent = "Reset";
    resetButton.addEventListener("click", () => {
      opQueue.enqueue({ file: "_global", path: config.key, discard: true });
      if (config.hrefKey !== undefined) {
        opQueue.enqueue({ file: "_global", path: config.hrefKey, discard: true });
      }
      for (const extraKey of config.alsoDiscardsOnReset ?? []) {
        opQueue.enqueue({ file: "_global", path: extraKey, discard: true });
      }
      // Re-fetch after the discard(s) land rather than restore `originalValue`
      // locally: this tab renders draft-merged content (`GET /api/admin/global`),
      // so "reset" must reflect the true post-discard state, not just what was
      // on screen when the tab first loaded (decisions/00127) — a plain local
      // reset would also leave a just-discarded phoneHref/emailHref/mapSrc
      // stale until the next full reload.
      void (async () => {
        await opQueue.flushNow();
        if (!cancelled) await load();
      })();
    });

    row.append(label, input, hint, resetButton);
    return row;
  }

  function mapSection(global: GlobalSettings): HTMLElement {
    const section = settingsSection("Map");
    const intro = document.createElement("p");
    intro.className = "wx-settings-hint";
    intro.textContent =
      "Your address shows the way by default. Place a pin below only if the map should point somewhere more precise.";
    section.appendChild(intro);

    const currentAddress = contactFieldValue(global, "address");
    const currentCoords = contactFieldValue(global, "mapCoords");

    activeMapPicker?.teardown();
    const picker = mountMapPicker({
      win: deps.win,
      initialCoords: currentCoords,
      onPin: (coords) => {
        opQueue.enqueue({ file: "_global", path: "mapCoords", value: coords });
        opQueue.enqueue({ file: "_global", path: "mapSrc", value: deriveMapSrc(coords, currentAddress) });
      },
      onClear: () => {
        opQueue.enqueue({ file: "_global", path: "mapCoords", value: "" });
        opQueue.enqueue({ file: "_global", path: "mapSrc", value: deriveMapSrc("", currentAddress) });
      },
    });
    activeMapPicker = picker;
    section.appendChild(picker.element);

    const resetRow = document.createElement("div");
    resetRow.className = "wx-map-reset-row";
    const resetButton = document.createElement("button");
    resetButton.type = "button";
    resetButton.className = "wx-settings-link-button";
    resetButton.textContent = "Reset map to published";
    resetButton.addEventListener("click", () => {
      opQueue.enqueue({ file: "_global", path: "mapCoords", discard: true });
      opQueue.enqueue({ file: "_global", path: "mapSrc", discard: true });
      void (async () => {
        await opQueue.flushNow();
        if (!cancelled) await load();
      })();
    });
    resetRow.appendChild(resetButton);
    section.appendChild(resetRow);

    return section;
  }

  async function load(): Promise<void> {
    try {
      const global = await deps.api.getGlobalSettings();
      if (cancelled) return;
      activeMapPicker?.teardown();
      activeMapPicker = null;
      body.innerHTML = "";
      const section = settingsSection("Contact details");
      const intro = document.createElement("p");
      intro.className = "wx-settings-hint";
      intro.textContent =
        "These already appear everywhere your site shows them — change one here and it updates every page, the next time you Publish.";
      section.appendChild(intro);
      for (const config of CONTACT_FIELDS) {
        section.appendChild(fieldRow(config, global));
      }
      body.appendChild(section);
      body.appendChild(mapSection(global));
    } catch (err) {
      if (cancelled) return;
      renderLoadError(err instanceof Error ? err.message : "unknown error");
    }
  }

  void load();

  return {
    element: root,
    teardown(): void {
      cancelled = true;
      activeMapPicker?.teardown();
      activeMapPicker = null;
    },
  };
}
