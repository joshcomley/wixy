// The main overlay coordinator (spec/05 §2): hover chrome, click -> popover routing,
// op emission, list item toolbar, data-wx-if eye toggle, and the shell handshake.
//
// DOM-heavy by nature — kept as thin a layer as possible over the pure, unit-tested
// logic in `dom.ts`/`contentModel.ts`/`listOps.ts`/`opTargeting.ts`. The exact visual
// styling (outline color/radius, popover chrome, toolbar icons) is NOT verified here
// against a real rendered page — that needs a live browser, per this repo's own
// "verify in a browser for UI changes" rule; flagged explicitly in decisions/00017.

import { readListValue } from "./contentModel";
import {
  chipLabel,
  closestBoundElement,
  HOVER_TARGET_SELECTOR,
  isRichLiteContent,
  type DetectedBinding,
} from "./dom";
import { applyListStructuralOp, type ListStructuralOp } from "./listOps";
import { onShellMessage, sendToShell } from "./messaging";
import { resolveInternalPageSlug, showToast } from "./navigation";
import { directOpTarget, findOutermostList, isItemScopeKey } from "./opTargeting";
import {
  buildImagePopover,
  buildLinkPopover,
  buildPlainTextPopover,
  buildRichLiteTextPopover,
  positionNear,
} from "./popovers";
import type { BindingField, DraftOp, JsonValue, PageBindings } from "./protocol";

// @nav is builder-computed and never generically list-editable (spec/02 §3;
// decisions/00012 decision 8 flagged this for the editor to enforce).
const NON_EDITABLE_LIST_KEYS = new Set(["@nav"]);

interface OverlayState {
  page: string;
  bindings: PageBindings;
  draftRev: number;
}

function findField(bindings: PageBindings, key: string): BindingField | null {
  return bindings.fields.find((f) => f.key === key) ?? null;
}

export function initOverlay(win: Window = window): () => void {
  let state: OverlayState | null = null;
  let closeActivePopover: (() => void) | null = null;
  let hoverChip: HTMLElement | null = null;
  let hoveredEl: Element | null = null;
  // The binding a "Replace image" click sent `mediaRequest` for (milestone 8
  // slice 3) — set right before asking the shell to open its media dialog,
  // consumed by the matching `applyOps` batch the shell echoes back once the
  // user picks/uploads or cancels (decisions/00022).
  let pendingMediaTarget: DetectedBinding | null = null;

  function currentPage(): string {
    return state?.page ?? "";
  }

  function applyValueToElement(
    el: Element,
    kind: DetectedBinding["kind"],
    value: JsonValue,
  ): void {
    switch (kind) {
      case "text":
        if (typeof value === "string") (el as HTMLElement).innerHTML = value;
        return;
      case "href":
        if (typeof value === "string") el.setAttribute("href", value);
        return;
      case "img": {
        if (value === null || typeof value !== "object" || Array.isArray(value)) return;
        const src = value["src"];
        const alt = value["alt"];
        if (typeof src === "string") el.setAttribute("src", src);
        if (typeof alt === "string") el.setAttribute("alt", alt);
        return;
      }
      case "bg": {
        if (value === null || typeof value !== "object" || Array.isArray(value)) return;
        const src = value["src"];
        if (typeof src === "string") el.setAttribute("style", `background-image:url(${src})`);
        return;
      }
      case "if": {
        const falsy =
          value === false ||
          value === null ||
          value === "" ||
          (Array.isArray(value) && value.length === 0);
        if (falsy) el.setAttribute("data-wx-hidden", "1");
        else el.removeAttribute("data-wx-hidden");
        return;
      }
      case "list":
      case "attr":
        return; // lists go through structural ops; attr bindings aren't inline-editable
    }
  }

  function emitDirect(target: DetectedBinding, value: JsonValue): void {
    applyValueToElement(target.element, target.kind, value);
    const { file, path } = directOpTarget(target.key, currentPage());
    sendToShell({ wx: 1, type: "op", file, path, value }, win);
  }

  function emitItemScoped(target: DetectedBinding, value: JsonValue): void {
    applyValueToElement(target.element, target.kind, value);
    const outer = findOutermostList(target.element);
    if (outer === null || state === null) return;
    const field = findField(state.bindings, outer.key);
    const whole = readListValue(outer.container, field ?? { key: outer.key, kind: "list" });
    const { file, path } = directOpTarget(outer.key, state.page);
    sendToShell({ wx: 1, type: "op", file, path, value: whole }, win);
  }

  function commitEdit(target: DetectedBinding, value: JsonValue): void {
    if (isItemScopeKey(target.key)) emitItemScoped(target, value);
    else emitDirect(target, value);
  }

  function closePopover(): void {
    closeActivePopover?.();
    closeActivePopover = null;
  }

  function mountPopover(el: Element, popover: HTMLElement): void {
    document.body.appendChild(popover);
    positionNear(popover, el);
    closeActivePopover = () => popover.remove();
  }

  function openTextPopover(target: DetectedBinding): void {
    const el = target.element as HTMLElement;
    if (isRichLiteContent(el)) {
      const popover = buildRichLiteTextPopover(el.innerHTML, {
        onCommit: (html) => {
          commitEdit(target, html);
          closePopover();
        },
        onCancel: closePopover,
      });
      mountPopover(el, popover);
      return;
    }
    // textContent, not innerText: this branch only runs when isRichLiteContent(el) is
    // false (no element children at all), so the two are equivalent here — and
    // innerText isn't implemented in every DOM environment (e.g. jsdom, this
    // package's own test environment) since it depends on real layout information.
    const popover = buildPlainTextPopover(el.textContent ?? "", {
      onCommit: (value) => {
        commitEdit(target, value);
        closePopover();
      },
      onCancel: closePopover,
    });
    mountPopover(el, popover);
  }

  function openLinkPopover(target: DetectedBinding): void {
    const el = target.element;
    const labelKey = el.getAttribute("data-wx");
    const currentLabel = labelKey !== null ? (el.textContent ?? "") : null;
    const popover = buildLinkPopover(el.getAttribute("href") ?? "", currentLabel, {
      onCommitHref: (href) => {
        commitEdit(target, href);
        closePopover();
      },
      onCancel: closePopover,
      // Only included when there IS a co-located label (exactOptionalPropertyTypes
      // distinguishes "omitted" from "present but undefined" — spread conditionally
      // rather than assigning `undefined` to an optional callback).
      ...(labelKey !== null
        ? {
            onCommitLabel: (label: string) => {
              commitEdit({ element: el, key: labelKey, kind: "text" }, label);
              closePopover();
            },
          }
        : {}),
    });
    mountPopover(el, popover);
  }

  function openImagePopover(target: DetectedBinding): void {
    const el = target.element;
    const alt = target.kind === "img" ? (el.getAttribute("alt") ?? "") : "";
    const popover = buildImagePopover(alt, {
      onReplace: () => {
        pendingMediaTarget = target;
        sendToShell({ wx: 1, type: "mediaRequest", key: target.key }, win);
      },
      onCommitAlt: (newAlt) => {
        if (target.kind === "img") {
          commitEdit(target, { src: el.getAttribute("src") ?? "", alt: newAlt });
        }
        closePopover();
      },
      onCancel: closePopover,
    });
    mountPopover(el, popover);
  }

  function openPopoverFor(target: DetectedBinding): void {
    closePopover();
    switch (target.kind) {
      case "text":
        openTextPopover(target);
        return;
      case "href":
        openLinkPopover(target);
        return;
      case "img":
      case "bg":
        openImagePopover(target);
        return;
      case "list":
      case "if":
      case "attr":
        return; // list: item toolbar; if: eye toggle; attr: page-settings drawer
    }
  }

  // -- Hover chrome ----------------------------------------------------------

  function clearHoverChrome(): void {
    hoveredEl?.classList.remove("wx-hover-outline");
    hoverChip?.remove();
    hoverChip = null;
    hoveredEl = null;
  }

  function handlePointerOver(event: Event): void {
    if (!(event.target instanceof Element)) return;
    handleItemToolbarHover(event.target);
    const bound = closestBoundElement(event.target);
    if (bound === null) return;
    if (bound.kind === "list" && NON_EDITABLE_LIST_KEYS.has(bound.key)) return;
    if (bound.element === hoveredEl) return;
    clearHoverChrome();
    hoveredEl = bound.element;
    hoveredEl.classList.add("wx-hover-outline");
    hoverChip = document.createElement("div");
    hoverChip.className = "wx-hover-chip";
    hoverChip.textContent = chipLabel(bound.kind);
    document.body.appendChild(hoverChip);
    positionNear(hoverChip, bound.element);
  }

  // -- List item toolbar (hover) ----------------------------------------------------------
  //
  // A SEPARATE hover concern from the scalar/list-container outline+chip above: spec/05
  // §2's item toolbar (↑ ↓ ✚ duplicate, ✖ delete, ⠿ drag handle) appears when hovering
  // an ITEM, not the list container itself. Drag-to-reorder is simplified to the ↑/↓
  // buttons here (documented in decisions/00017) — the buttons emit the identical
  // whole-array op a drag would, just without pointer-drag tracking.

  let hoveredItem: Element | null = null;
  let itemToolbar: HTMLElement | null = null;

  function buildItemToolbar(): HTMLElement {
    const toolbar = document.createElement("div");
    toolbar.className = "wx-item-toolbar";
    const actions: [string, string][] = [
      ["moveUp", "↑"],
      ["moveDown", "↓"],
      ["add", "✚"],
      ["duplicate", "⧉"],
      ["delete", "✖"],
    ];
    for (const [action, label] of actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset["wxToolbarAction"] = action;
      button.textContent = label;
      toolbar.appendChild(button);
    }
    return toolbar;
  }

  function clearItemToolbar(): void {
    itemToolbar?.remove();
    itemToolbar = null;
    hoveredItem = null;
  }

  function handleItemToolbarHover(target: Element): void {
    const item = target.closest("[data-wx-list-item]");
    if (item === null) {
      clearItemToolbar();
      return;
    }
    if (item === hoveredItem) return;
    clearItemToolbar();
    hoveredItem = item;
    itemToolbar = buildItemToolbar();
    document.body.appendChild(itemToolbar);
    positionNear(itemToolbar, item);
  }

  function handlePointerOut(event: Event): void {
    const related = (event as MouseEvent).relatedTarget;
    const stillWithinHovered = related instanceof Element && hoveredEl?.contains(related) === true;
    if (!stillWithinHovered) clearHoverChrome();

    // Don't clear the item toolbar while the pointer moves onto IT (a separate
    // document.body-mounted element, not a descendant of the item) to click a button.
    const movingOntoToolbar = related instanceof Element && itemToolbar?.contains(related) === true;
    const stillWithinItem = related instanceof Element && hoveredItem?.contains(related) === true;
    if (!movingOntoToolbar && !stillWithinItem) clearItemToolbar();
  }

  // -- Click routing ----------------------------------------------------------

  function handleClick(event: Event): void {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest(".wx-if-eye-toggle") !== null) return; // owned by handleIfToggleClick

    const bound = closestBoundElement(event.target);
    if (bound !== null) {
      if (bound.kind === "list") return;
      event.preventDefault();
      openPopoverFor(bound);
      return;
    }

    handlePlainAnchorClick(event, event.target);
  }

  // -- Internal/external link interception ----------------------------------------------------------
  //
  // Only reached for anchors `closestBoundElement` didn't already claim — i.e. an
  // anchor with no data-wx-href of its own (nav links, footer/header partial
  // links, any plain content link outside the bindings system). A data-wx-href
  // anchor is an EDITABLE binding (routed above into the link popover); this is
  // for genuine browsing clicks (spec/05 §2).

  function handlePlainAnchorClick(event: Event, target: Element): void {
    const anchor = target.closest("a[href]");
    if (anchor === null) return;
    const slug = resolveInternalPageSlug(anchor, win);
    event.preventDefault();
    if (slug === null) {
      showToast("External link");
      return;
    }
    sendToShell({ wx: 1, type: "navigate", page: slug }, win);
    win.location.href = `/admin/preview/${slug}.html`;
  }

  // -- data-wx-if eye toggle ----------------------------------------------------------

  function handleIfToggleClick(event: Event): void {
    if (!(event.target instanceof Element)) return;
    const trigger = event.target.closest(".wx-if-eye-toggle");
    if (trigger === null) return;
    const el = trigger.closest("[data-wx-if]");
    if (el === null) return;
    const spec = el.getAttribute("data-wx-if");
    if (spec === null) return;
    const negated = spec.startsWith("!");
    const bareKey = negated ? spec.slice(1) : spec;
    const wasFalsy = el.hasAttribute("data-wx-hidden");
    const newTruthy = wasFalsy; // click flips falsy -> truthy and vice versa
    commitEdit({ element: el, key: bareKey, kind: "if" }, negated ? !newTruthy : newTruthy);
  }

  /** Inserts the eye-toggle button as a CHILD of the bound element itself (not a
   * document.body-mounted floater like the hover chip/item toolbar) so
   * `handleIfToggleClick`'s `trigger.closest("[data-wx-if]")` lookup resolves
   * regardless of hover state. Idempotent — safe to call on an element that
   * already has one (e.g. a list item cloned via duplicate/add, which carries its
   * source item's toggle along with the rest of its subtree). CSS shows the
   * button only while the element actually carries `data-wx-hidden` (spec/05 §2:
   * "40% opacity + an eye toggle... when falsy"), so it's inserted unconditionally
   * up front — the element can be toggled hidden again later without a re-scan. */
  function ensureIfToggle(el: Element): void {
    if (el.querySelector(":scope > .wx-if-eye-toggle") !== null) return;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "wx-if-eye-toggle";
    toggle.setAttribute("aria-label", "Show hidden section");
    toggle.textContent = "\u{1F441}\u{FE0F}"; // eye
    el.insertBefore(toggle, el.firstChild);
  }

  function ensureIfToggles(): void {
    document.querySelectorAll("[data-wx-if]").forEach(ensureIfToggle);
  }

  // -- List item structural toolbar ----------------------------------------------------------

  function applyStructuralDomChange(listEl: Element, item: Element, op: ListStructuralOp): void {
    switch (op.kind) {
      case "delete":
        item.remove();
        return;
      case "duplicate":
        item.after(item.cloneNode(true));
        return;
      case "moveUp": {
        const prev = item.previousElementSibling;
        if (prev !== null) listEl.insertBefore(item, prev);
        return;
      }
      case "moveDown": {
        const next = item.nextElementSibling;
        if (next !== null) next.after(item);
        return;
      }
      case "add": {
        const first = listEl.querySelector(":scope > [data-wx-list-item]");
        if (first === null) return; // no DOM template to clone from — decisions/00017
        const clone = first.cloneNode(true) as Element;
        blankTextLikeFields(clone);
        listEl.appendChild(clone);
        return;
      }
    }
  }

  function blankTextLikeFields(root: Element): void {
    root.querySelectorAll("[data-wx]").forEach((el) => {
      (el as HTMLElement).innerHTML = "";
    });
    root.querySelectorAll("[data-wx-href]").forEach((el) => el.setAttribute("href", ""));
    root.querySelectorAll("[data-wx-img]").forEach((el) => {
      el.setAttribute("src", "");
      el.setAttribute("alt", "");
    });
  }

  function runListStructuralOp(item: Element, kind: ListStructuralOp["kind"]): void {
    const listEl = item.closest("[data-wx-list]");
    if (listEl === null || state === null) return;
    const key = listEl.getAttribute("data-wx-list");
    if (key === null) return;
    const field = findField(state.bindings, key);
    const siblings = Array.from(listEl.querySelectorAll(":scope > [data-wx-list-item]"));
    const index = siblings.indexOf(item);
    const op = { kind, index } as ListStructuralOp;

    const before = readListValue(listEl, field ?? { key, kind: "list" });
    const after = applyListStructuralOp(before, op);
    applyStructuralDomChange(listEl, item, op);

    const { file, path } = directOpTarget(key, state.page);
    sendToShell({ wx: 1, type: "op", file, path, value: after }, win);
  }

  function handleListToolbarClick(event: Event): void {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest("[data-wx-toolbar-action]");
    if (button === null) return;
    const action = button.getAttribute("data-wx-toolbar-action");
    // The toolbar is mounted on `document.body` (a top-layer container, per spec/05
    // §2's "popovers are position:fixed in a top-layer container"), NOT nested inside
    // the item's own DOM subtree — so the target item can't be found via `.closest()`
    // from the button; it's whichever item is currently tracked as hovered.
    const item = hoveredItem;
    if (action === null || item === null) return;
    if (
      action === "add" ||
      action === "duplicate" ||
      action === "moveUp" ||
      action === "moveDown" ||
      action === "delete"
    ) {
      runListStructuralOp(item, action);
    }
  }

  // -- Shell message handling ----------------------------------------------------------

  function applyThemeVars(vars: Record<string, string>): void {
    for (const [key, value] of Object.entries(vars)) {
      document.documentElement.style.setProperty(key, value);
    }
  }

  const _GOOGLE_FONTS_HREF_PREFIX = "https://fonts.googleapis.com/";

  /** Mirrors `builder/templates.py`'s `_find_fonts_link`/`apply_head` exactly (find
   * the `<link>` whose `href` starts with the Google Fonts prefix; create one if
   * somehow absent) so the live-preview swap targets the SAME tag a real build
   * would have written. */
  function applyThemeFonts(url: string): void {
    const head = document.head;
    let link = Array.from(head.querySelectorAll("link")).find((candidate) =>
      candidate.href.startsWith(_GOOGLE_FONTS_HREF_PREFIX),
    );
    if (link === undefined) {
      link = document.createElement("link");
      link.rel = "stylesheet";
      head.appendChild(link);
    }
    link.href = url;
  }

  function selectByKey(key: string): void {
    const selector = [
      `[data-wx="${key}"]`,
      `[data-wx-img="${key}"]`,
      `[data-wx-href="${key}"]`,
      `[data-wx-bg="${key}"]`,
      `[data-wx-list="${key}"]`,
    ].join(", ");
    document.querySelector(selector)?.scrollIntoView({ block: "center" });
  }

  const unsubscribeShell = onShellMessage((message) => {
    switch (message.type) {
      case "init":
        state = { page: message.page, bindings: message.bindings, draftRev: message.draftRev };
        return;
      case "applyOps": {
        // Normally just an echo-after-server-accept the overlay already applied
        // optimistically at commit time (decisions/00017: nothing to reconcile).
        // The ONE exception (milestone 8 slice 3): the shell also reuses this same
        // message to deliver a pending "Replace image" request's answer — an op
        // whose `path` equals the ORIGINAL mediaRequest key (verbatim, even when
        // item-scoped, e.g. ".img" — the shell has no DOM access to resolve that
        // itself), or an EMPTY batch for "cancelled, nothing picked" (decisions/00022).
        // Matching only ever applies to an outstanding pendingMediaTarget, and only
        // clears it on an actual match or an explicit empty-batch cancel signal —
        // an unrelated non-empty batch (e.g. an in-flight edit that was already
        // queued before the dialog opened) passes through untouched, leaving the
        // real answer still awaited.
        if (pendingMediaTarget !== null) {
          if (message.ops.length === 0) {
            pendingMediaTarget = null;
            return;
          }
          const match = message.ops.find(
            (op): op is Extract<DraftOp, { value: JsonValue }> =>
              op.path === pendingMediaTarget?.key && "value" in op,
          );
          if (match !== undefined) {
            const target = pendingMediaTarget;
            pendingMediaTarget = null;
            commitEdit(target, match.value);
          }
        }
        return;
      }
      case "setDevice":
        // The shell resizes the iframe ELEMENT itself; there's nothing for the
        // overlay's own in-frame DOM to do in response (decisions/00017).
        return;
      case "themeVars":
        applyThemeVars(message.vars);
        return;
      case "themeFonts":
        applyThemeFonts(message.url);
        return;
      case "select":
        selectByKey(message.key);
        return;
    }
  }, win);

  ensureIfToggles();

  document.addEventListener("mouseover", handlePointerOver);
  document.addEventListener("mouseout", handlePointerOut);
  document.addEventListener("click", handleClick);
  document.addEventListener("click", handleIfToggleClick);
  document.addEventListener("click", handleListToolbarClick);

  sendToShell({ wx: 1, type: "ready" }, win);

  return function teardown(): void {
    unsubscribeShell();
    document.removeEventListener("mouseover", handlePointerOver);
    document.removeEventListener("mouseout", handlePointerOut);
    document.removeEventListener("click", handleClick);
    document.removeEventListener("click", handleIfToggleClick);
    document.removeEventListener("click", handleListToolbarClick);
    clearHoverChrome();
    clearItemToolbar();
    closePopover();
  };
}
