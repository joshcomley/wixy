// The admin shell (spec/05-editor.md §1): the slim unpublished-changes STATUS
// BAR (decisions/00083) at the very top — visible on every route, edit view
// included — then the top bar (project name, "Site ▸" link + view controls),
// left nav + main panel, hydrated from `/api/admin/state` (fleet instant-
// render rule: the shell chrome below paints synchronously in `mountShell`;
// panel content/data arrives async into skeletons). Owns the ONE OpQueue for
// the whole session (spec/05 §2: "the shell owns state") — panels never
// construct their own. Also owns every Uxer session-persisted view control
// (theme.ts, zoom.ts, fontScale.ts, shortcuts.ts) for the shell's lifetime —
// keyboard shortcuts are matched centrally by shortcuts.ts (shell.ts just
// registers commands wired to each controller's methods), and every
// controller's `subscribe` drives both the topbar chrome AND (when mounted)
// the Settings panel from the same source of truth.

import { createApi, thumbnailUrl, type AdminApi, type PublishJobData, type PublishStage, type StateResponse } from "./api";
import { createThumbnailService } from "./thumbnailService";
import { mountChatPanel as mountChatPanelReal, type ChatPanel, type ChatPanelDeps } from "./chatPanel";
import { mountEditView as mountEditViewReal, type EditView, type MountEditViewDeps } from "./editView";
import { initFontScale, type FontScaleController } from "./fontScale";
import { mountHistoryPanel } from "./historyPanel";
import { mountMediaPanel, type MediaPanel } from "./mediaPanel";
import { OpQueue } from "./opQueue";
import { mountPageSettingsDrawer } from "./pageSettingsDrawer";
import { renderPagesPanel } from "./pagesPanel";
import { mountPublishDrawer } from "./publishDrawer";
import { canonicalizeUrl, currentRoute, navigateTo, onRouteChange, type Route } from "./router";
import { captureScreenshot, copyBlobToClipboard, downloadBlob, flashScreen, screenshotFilename } from "./screenshot";
import { clearLastRoute, loadLastRoute, saveLastRoute } from "./sessionState";
import { mountSettingsPanel } from "./settingsPanel";
import { formatBinding, initShortcuts, type ShortcutCommand } from "./shortcuts";
import { setButtonBusy, setButtonIdle } from "./spinnerButton";
import { mountThemePanel, type ThemePanel } from "./themePanel";
import { initTheme, type ThemeMode } from "./theme";
import { initThemeEditor } from "./themeEditor";
import { initZoom } from "./zoom";

interface Drawer {
  element: HTMLElement;
  teardown(): void;
}

const STATE_RETRY_MS = 5000;
const TRANSIENT_TOAST_MS = 4000;
// decisions/00089 — publish feedback: the watch's poll cadence while a publish
// runs, and the longer toast lifetimes for the two terminal announcements (the
// operator's "some notification when it's live" — too important to vanish in
// the default 4s, and a failure must survive long enough to be read).
const PUBLISH_POLL_MS = 2000;
const PUBLISH_LIVE_TOAST_MS = 6000;
const PUBLISH_FAIL_TOAST_MS = 8000;
// Safety cap (~20 min at the 2s cadence): a genuinely wedged server job must
// not be polled forever — the periodic revalidation re-arms the watch anyway.
const PUBLISH_WATCH_MAX_POLLS = 600;

/** Layman stage narration for the status bar while a publish runs — the
 * operator watches the slim banner, not git jargon (decisions/00089, the same
 * wording rule as decisions/00082's chip text). */
const PUBLISH_STAGE_LABELS: Record<PublishStage, string> = {
  pulling: "Getting the latest site…",
  merging: "Applying your changes…",
  committing: "Saving a new version…",
  building: "Building the site…",
  verifying: "Checking the site…",
  swapping: "Taking it live…",
  done: "Live.",
  failed: "Publish failed.",
};

type MountEditViewFn = (page: string, deps: MountEditViewDeps) => EditView;
type MountChatPanelFn = (conversation: string | null, deps: ChatPanelDeps) => ChatPanel;

export interface ShellDeps {
  api?: AdminApi;
  win?: Window;
  mountEditView?: MountEditViewFn;
  /** Overridable for tests — the real implementation opens a genuine
   * `EventSource` (spec/06 §1's live stream) the moment a conversation view
   * mounts, which jsdom doesn't implement; mirrors `mountEditView`'s own
   * injectable pattern (there for the same reason: a real iframe). */
  mountChatPanel?: MountChatPanelFn;
}

export interface Shell {
  teardown(): void;
}

const NAV_ROUTES: Array<{ route: Route; label: string }> = [
  { route: { kind: "pages" }, label: "Pages" },
  { route: { kind: "theme" }, label: "Theme" },
  { route: { kind: "media" }, label: "Media" },
  { route: { kind: "chat", conversation: null }, label: "Chat" },
  { route: { kind: "history" }, label: "History" },
];

export function mountShell(container: HTMLElement, deps: ShellDeps = {}): Shell {
  const api = deps.api ?? createApi();
  const win = deps.win ?? window;
  const createEditView = deps.mountEditView ?? mountEditViewReal;
  const createChatPanel = deps.mountChatPanel ?? mountChatPanelReal;

  // Page thumbnails (decisions/00078): captures happen client-side, serially;
  // the triggers below keep them fresh (backfill on 404, after accepted ops,
  // after publish/restore) without ever recapturing on a timer. A landed
  // capture re-renders the pages panel when it's on screen (placeholder →
  // thumbnail in real time).
  const thumbnailService = createThumbnailService({
    api,
    win,
    onCaptured: () => {
      if (activeRoute?.kind === "pages") void refreshPagesPanel();
    },
  });

  function refreshThumbnailsForOps(ops: { file: string }[]): void {
    if (state === null) return;
    const pages = state.pages;
    if (ops.some((op) => op.file === "_global")) {
      // A global edit (nav, hours, brand) can alter every page's pixels.
      thumbnailService.refresh(pages.map((p) => p.slug));
      return;
    }
    thumbnailService.refresh(
      [...new Set(ops.map((op) => op.file))].filter((slug) => pages.some((p) => p.slug === slug)),
    );
  }

  container.innerHTML = "";
  container.className = "wx-shell";

  // -- Status bar (decisions/00083) ------------------------------------------
  // The slim, always-visible unpublished-changes bar: the draft chip on the
  // left (opens the review drawer), the Publish button on the right. It sits
  // ABOVE the topbar and is deliberately NOT part of the edit-view chrome
  // that hides/reveals — the one place you can always see and act on "you
  // have unpublished work" is here, so there's no chip-relocation dance any
  // more (the chip used to move into the slim edit bar while editing).
  const statusBar = document.createElement("div");
  statusBar.className = "wx-statusbar";
  const chipEl = document.createElement("button");
  chipEl.type = "button";
  chipEl.className = "wx-draft-chip";
  chipEl.disabled = true;
  chipEl.addEventListener("click", () => openPublishDrawer());
  const publishButton = document.createElement("button");
  publishButton.type = "button";
  publishButton.className = "wx-publish-button";
  publishButton.textContent = "Publish";
  publishButton.disabled = true;
  publishButton.addEventListener("click", () => openPublishDrawer());
  statusBar.append(chipEl, publishButton);

  const topbar = document.createElement("div");
  topbar.className = "wx-topbar";
  const titleEl = document.createElement("span");
  titleEl.className = "wx-topbar-title";
  titleEl.textContent = "Wixy";
  const spacer = document.createElement("span");
  spacer.className = "wx-topbar-spacer";
  const siteLink = document.createElement("a");
  siteLink.className = "wx-site-link";
  siteLink.textContent = "Site ▸";
  siteLink.target = "_blank";
  siteLink.rel = "noopener noreferrer";
  siteLink.hidden = true;

  // -- View controllers ---------------------------------------------------
  // Constructed before their topbar DOM/shortcut commands, since both close
  // over these controllers' methods.

  const zoomController = initZoom(win, document);
  const fontScaleController = initFontScale(win, document);
  const themeController = initTheme(win);

  const SHORTCUT_COMMANDS: readonly ShortcutCommand[] = [
    {
      id: "zoom.in",
      category: "Zoom",
      label: "Zoom in",
      defaultBinding: { ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, code: "Equal" },
      run: () => zoomController.zoomIn(),
    },
    {
      id: "zoom.out",
      category: "Zoom",
      label: "Zoom out",
      defaultBinding: { ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, code: "Minus" },
      run: () => zoomController.zoomOut(),
    },
    {
      id: "zoom.reset",
      category: "Zoom",
      label: "Reset zoom to 100%",
      defaultBinding: { ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, code: "Digit0" },
      run: () => zoomController.reset(),
    },
    {
      id: "fontScale.increase",
      category: "Font Size",
      label: "Increase font size",
      defaultBinding: { ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, code: "Equal" },
      run: () => fontScaleController.increase(),
    },
    {
      id: "fontScale.decrease",
      category: "Font Size",
      label: "Decrease font size",
      defaultBinding: { ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, code: "Minus" },
      run: () => fontScaleController.decrease(),
    },
  ];
  const shortcutsController = initShortcuts(SHORTCUT_COMMANDS, win);
  const themeEditorController = initThemeEditor(themeController, win);

  function resetAllSettings(): void {
    themeController.setMode("system");
    zoomController.reset();
    fontScaleController.reset();
    shortcutsController.resetAll();
    themeEditorController.resetVariant("light");
    themeEditorController.resetVariant("dark");
    clearLastRoute(win);
  }

  // -- Zoom controls --------------------------------------------------------

  const zoomOutButton = document.createElement("button");
  zoomOutButton.type = "button";
  zoomOutButton.className = "wx-zoom-button";
  zoomOutButton.textContent = "−";
  zoomOutButton.setAttribute("aria-label", "Zoom out");
  const zoomLevelEl = document.createElement("span");
  zoomLevelEl.className = "wx-zoom-level";
  const zoomInButton = document.createElement("button");
  zoomInButton.type = "button";
  zoomInButton.className = "wx-zoom-button";
  zoomInButton.textContent = "+";
  zoomInButton.setAttribute("aria-label", "Zoom in");
  function renderZoom(): void {
    zoomLevelEl.textContent = `${zoomController.getLevel()}%`;
  }
  zoomOutButton.addEventListener("click", () => zoomController.zoomOut());
  zoomInButton.addEventListener("click", () => zoomController.zoomIn());
  renderZoom();
  zoomController.subscribe(renderZoom);
  const zoomGroup = document.createElement("div");
  zoomGroup.className = "wx-zoom-controls";
  zoomGroup.setAttribute("role", "group");
  zoomGroup.setAttribute("aria-label", "Zoom");
  zoomGroup.append(zoomOutButton, zoomLevelEl, zoomInButton);

  // -- Font-scale controls ----------------------------------------------------

  const fontScaleDownButton = document.createElement("button");
  fontScaleDownButton.type = "button";
  fontScaleDownButton.className = "wx-font-scale-button";
  fontScaleDownButton.textContent = "A−";
  fontScaleDownButton.setAttribute("aria-label", "Decrease font size");
  const fontScaleLevelEl = document.createElement("span");
  fontScaleLevelEl.className = "wx-font-scale-level";
  const fontScaleUpButton = document.createElement("button");
  fontScaleUpButton.type = "button";
  fontScaleUpButton.className = "wx-font-scale-button";
  fontScaleUpButton.textContent = "A+";
  fontScaleUpButton.setAttribute("aria-label", "Increase font size");
  function renderFontScale(): void {
    fontScaleLevelEl.textContent = `${fontScaleController.getLevel()}%`;
  }
  fontScaleDownButton.addEventListener("click", () => fontScaleController.decrease());
  fontScaleUpButton.addEventListener("click", () => fontScaleController.increase());
  renderFontScale();
  fontScaleController.subscribe(renderFontScale);
  const fontScaleGroup = document.createElement("div");
  fontScaleGroup.className = "wx-font-scale-controls";
  fontScaleGroup.setAttribute("role", "group");
  fontScaleGroup.setAttribute("aria-label", "Font size");
  fontScaleGroup.append(fontScaleDownButton, fontScaleLevelEl, fontScaleUpButton);

  // -- Zoom/font-scale tooltips ------------------------------------------------
  // Reflects each command's LIVE effective binding (which Settings > Keyboard
  // Shortcuts may have rebound away from the default shown here at
  // construction time) rather than a hardcoded "(Ctrl++)"-style string.

  function refreshShortcutTooltips(): void {
    const byId = new Map(shortcutsController.list().map((item) => [item.id, item]));
    const tooltip = (id: string, label: string): string => {
      const item = byId.get(id);
      if (item === undefined || item.disabled) return label;
      return `${label} (${formatBinding(item.binding)})`;
    };
    zoomInButton.title = tooltip("zoom.in", "Zoom in");
    zoomOutButton.title = tooltip("zoom.out", "Zoom out");
    fontScaleUpButton.title = tooltip("fontScale.increase", "Increase font size");
    fontScaleDownButton.title = tooltip("fontScale.decrease", "Decrease font size");
  }
  refreshShortcutTooltips();
  shortcutsController.subscribe(refreshShortcutTooltips);

  // -- Theme toggle -------------------------------------------------------------

  const THEME_ICONS: Record<ThemeMode, string> = { light: "☀️", dark: "🌙", system: "💻" };
  const THEME_LABELS: Record<ThemeMode, string> = {
    light: "Light theme",
    dark: "Dark theme",
    system: "Follow system theme",
  };
  const THEME_CYCLE: readonly ThemeMode[] = ["light", "dark", "system"];
  const themeToggle = document.createElement("button");
  themeToggle.type = "button";
  themeToggle.className = "wx-theme-toggle";
  function renderThemeToggle(): void {
    const mode = themeController.getMode();
    themeToggle.textContent = THEME_ICONS[mode];
    themeToggle.title = THEME_LABELS[mode];
    themeToggle.setAttribute("aria-label", THEME_LABELS[mode]);
  }
  themeToggle.addEventListener("click", () => {
    const mode = themeController.getMode();
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(mode) + 1) % THEME_CYCLE.length] ?? "system";
    themeController.setMode(next);
  });
  renderThemeToggle();
  themeController.subscribe(() => renderThemeToggle());

  // -- Screenshot -------------------------------------------------------------

  const screenshotButton = document.createElement("button");
  screenshotButton.type = "button";
  screenshotButton.className = "wx-screenshot-button";
  screenshotButton.textContent = "📷";
  screenshotButton.title = "Screenshot";
  screenshotButton.setAttribute("aria-label", "Take a screenshot");
  screenshotButton.addEventListener("click", () => void handleScreenshotClick());

  async function handleScreenshotClick(): Promise<void> {
    screenshotButton.disabled = true;
    try {
      const outcome = await captureScreenshot(win);
      if (!outcome.ok) {
        // "denied" covers the user cancelling the browser's own source
        // picker — not an app error worth a toast, same as cancelling any
        // other native browser dialog is silent elsewhere in the app.
        if (outcome.reason !== "denied") showTransientToast(outcome.message, "error");
        return;
      }
      flashScreen(win.document);
      const filename = screenshotFilename();
      downloadBlob(outcome.blob, filename, win.document);
      const copied = await copyBlobToClipboard(outcome.blob, win);
      showTransientToast(
        copied ? `Screenshot saved as ${filename} and copied to clipboard.` : `Screenshot saved as ${filename}.`,
        "info",
      );
    } finally {
      screenshotButton.disabled = false;
    }
  }

  // -- Settings toggle ------------------------------------------------------

  const settingsToggle = document.createElement("button");
  settingsToggle.type = "button";
  settingsToggle.className = "wx-settings-toggle";
  settingsToggle.textContent = "⚙️";
  settingsToggle.title = "Settings";
  settingsToggle.setAttribute("aria-label", "Settings");
  settingsToggle.addEventListener("click", () => navigateTo({ kind: "settings", page: "general" }, win));

  // -- Secondary-controls overflow popover (narrow viewports) ----------------
  // The site link + zoom/font-scale/screenshot/theme/settings controls are
  // wrapped in one container that is `display: contents` on wide viewports
  // (its children lay out as direct topbar items exactly as before) and a
  // hidden popover below ~720px, toggled by the ⋯ trigger — so the top bar
  // stays one row on a phone while every control remains reachable (see
  // style.css's `.wx-topbar-secondary` rules). The site link keeps its own
  // text label (it's not an icon); the icon buttons spell theirs out via
  // their aria-labels in the popover.
  const secondary = document.createElement("div");
  secondary.className = "wx-topbar-secondary";
  secondary.append(siteLink, zoomGroup, fontScaleGroup, screenshotButton, themeToggle, settingsToggle);

  const overflowButton = document.createElement("button");
  overflowButton.type = "button";
  overflowButton.className = "wx-topbar-overflow";
  overflowButton.textContent = "⋯";
  overflowButton.setAttribute("aria-label", "More controls");
  overflowButton.setAttribute("aria-haspopup", "true");
  overflowButton.setAttribute("aria-expanded", "false");

  function closeSecondary(): void {
    secondary.classList.remove("wx-topbar-secondary-open");
    overflowButton.setAttribute("aria-expanded", "false");
    // Attached only while open (see openSecondary) — no listener accumulation.
    document.removeEventListener("click", onSecondaryOutsideClick);
  }
  function onSecondaryOutsideClick(evt: Event): void {
    if (evt.target instanceof Node && secondary.contains(evt.target)) return;
    closeSecondary();
  }
  function openSecondary(): void {
    secondary.classList.add("wx-topbar-secondary-open");
    overflowButton.setAttribute("aria-expanded", "true");
    document.addEventListener("click", onSecondaryOutsideClick);
  }
  overflowButton.addEventListener("click", (evt) => {
    // The document-level outside-click listener is added during THIS event's
    // dispatch; without stopping propagation it would fire for this very
    // click (document is later in the bubble path) and instantly re-close.
    evt.stopPropagation();
    if (secondary.classList.contains("wx-topbar-secondary-open")) {
      closeSecondary();
    } else {
      openSecondary();
    }
  });
  function onSecondaryEscape(evt: KeyboardEvent): void {
    if (evt.key === "Escape") closeSecondary();
  }
  win.addEventListener("keydown", onSecondaryEscape);

  topbar.append(
    titleEl,
    spacer,
    secondary,
    overflowButton,
  );

  const body = document.createElement("div");
  body.className = "wx-body";
  const navEl = document.createElement("nav");
  navEl.className = "wx-nav";
  const main = document.createElement("main");
  main.className = "wx-main";
  main.textContent = "Loading…";
  body.append(navEl, main);

  // The slim edit bar's pinned home (decisions/00082): inside the shell's
  // non-scrolling chrome, NOT the scrolling main, so it can never scroll out
  // of reach (operator 2026-07-22: "that small top nav bar on Edit should
  // ALWAYS be visible"). CSS shows it only in edit view.
  const editBarHost = document.createElement("div");
  editBarHost.className = "wx-edit-bar-host";

  const toastRegion = document.createElement("div");
  toastRegion.className = "wx-toast-region";
  // Toasts are THE completion notification surface (publish-live included,
  // decisions/00089) — an aria-live status region, so they're announced, not
  // just painted.
  toastRegion.setAttribute("role", "status");

  container.append(statusBar, topbar, editBarHost, body, toastRegion);

  // -- Nav placement (decisions/00084) ------------------------------------------
  // Desktop keeps the nav inside .wx-body as the left sidebar. On narrow
  // screens it relocates into the shell chrome BETWEEN the topbar and the
  // pinned slim edit bar: inside .wx-body it would render BELOW the slim bar,
  // which is exactly where the ▾ chrome reveal showed the menu ("the gap
  // appears above but it is empty and the menu appears in the wrong place" —
  // operator 2026-07-21). The same navEl moves between the two homes (its
  // listeners travel with it); the stylesheet already styles it per-width, so
  // relocation is the whole change.
  const narrowMedia =
    typeof win.matchMedia === "function" ? win.matchMedia("(max-width: 720px)") : null;
  function placeNav(narrow: boolean): void {
    if (narrow) container.insertBefore(navEl, editBarHost);
    else body.insertBefore(navEl, main);
  }
  placeNav(narrowMedia?.matches ?? false);
  const onNarrowChange = (event: MediaQueryListEvent): void => placeNav(event.matches);
  narrowMedia?.addEventListener("change", onNarrowChange);

  // -- Nav --------------------------------------------------------------------

  function navButton(label: string, route: Route): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "wx-nav-item";
    button.textContent = label;
    button.dataset["routeKind"] = route.kind;
    button.addEventListener("click", () => navigateTo(route, win));
    return button;
  }

  // A real button, not a breadcrumb: it used to be created disabled with no
  // click handler — permanently dead until you were already editing, which read
  // as "the Edit button disabled itself" (operator report, 2026-07-19). Now it
  // opens the page you last edited, falling back to the home page / first
  // editable page, and only stays disabled while no editable page exists.
  const editNavItem = document.createElement("button");
  editNavItem.type = "button";
  editNavItem.className = "wx-nav-item wx-nav-item-edit";
  editNavItem.disabled = true;
  editNavItem.dataset["routeKind"] = "edit";
  editNavItem.textContent = "Edit";
  let lastEditPage: string | null = null;
  editNavItem.addEventListener("click", () => {
    const fallback =
      state?.pages.find((p) => p.slug === "index" && p.editable) ??
      state?.pages.find((p) => p.editable);
    const page = lastEditPage ?? fallback?.slug ?? null;
    if (page !== null) navigateTo({ kind: "edit", page }, win);
  });
  function updateEditNavItem(): void {
    editNavItem.disabled = state === null || !state.pages.some((p) => p.editable);
  }

  navEl.appendChild(navButton("Pages", { kind: "pages" }));
  navEl.appendChild(editNavItem);
  for (const item of NAV_ROUTES.slice(1)) {
    navEl.appendChild(navButton(item.label, item.route));
  }

  function setActiveNavItem(route: Route): void {
    navEl.querySelectorAll<HTMLElement>(".wx-nav-item").forEach((el) => {
      el.classList.toggle("wx-nav-active", el.dataset["routeKind"] === route.kind);
    });
    if (route.kind === "edit") lastEditPage = route.page;
    editNavItem.textContent = route.kind === "edit" ? `Edit: ${route.page}` : "Edit";
    settingsToggle.classList.toggle("wx-settings-toggle-active", route.kind === "settings");
  }

  // -- Top bar ------------------------------------------------------------------

  function renderTopBar(): void {
    updateEditNavItem();
    if (state === null) return;
    titleEl.textContent = `Wixy · ${state.project.name}`;
    const opCount = state.draft.opCount;
    const ahead = state.upstream.aheadOfPublished.length;
    // Layman wording (decisions/00082): no git jargon. "Unpublished changes"
    // are edits made in this editor not yet on the live site; "site updates"
    // are changes made OUTSIDE the editor (the AI assistant, a merged pull
    // request) that a publish will also take live — the drawer explains both.
    const parts: string[] = [];
    if (opCount > 0) parts.push(opCount === 1 ? "1 unpublished change" : `${opCount} unpublished changes`);
    if (ahead > 0) parts.push(ahead === 1 ? "1 site update" : `${ahead} site updates`);
    siteLink.href = `https://${state.project.domain}`;
    siteLink.hidden = false;

    const job = state.publishJob;
    if (publishInFlight || job?.isRunning === true) {
      // spec/05 §5: "Publishes are serialized server-side; the UI disables
      // Publish while one runs" — also true for the chip, the drawer's other
      // trigger. decisions/00089: disabled alone read as "broken" on a phone
      // with nothing happening for up to a minute — the button spins and the
      // chip narrates the stage instead of just greying. `publishInFlight`
      // bridges the gap between the drawer's confirm click and the POST
      // registering the job server-side (the busy affordance appears
      // synchronously with the click — fleet instant-feedback rule); the
      // shell's watch covers reload-mid-publish and other-tab/device starts.
      publishButton.disabled = true;
      chipEl.disabled = true;
      ensurePublishWatch();
      if (!publishButton.classList.contains("wx-button-busy")) {
        setButtonBusy(publishButton, "Publishing…");
      }
      publishButton.title = "Publishing — the site is being updated…";
      chipEl.textContent = job?.isRunning === true ? PUBLISH_STAGE_LABELS[job.stage] : "Publishing…";
      return;
    }
    publishButton.disabled = false;
    chipEl.disabled = false;
    if (publishButton.classList.contains("wx-button-busy")) {
      setButtonIdle(publishButton, "Publish");
    }
    publishButton.title = "";
    chipEl.textContent = parts.length === 0 ? "No unpublished changes" : parts.join(" · ");
  }

  // -- Toasts ---------------------------------------------------------------

  function showStateError(): void {
    toastRegion.innerHTML = "";
    const toast = document.createElement("div");
    toast.className = "wx-toast wx-toast-error";
    toast.textContent = "Can't reach the server — retrying…";
    toastRegion.appendChild(toast);
  }

  function hideStateError(): void {
    toastRegion.innerHTML = "";
  }

  function showTransientToast(message: string, variant: "error" | "info" = "error", durationMs = TRANSIENT_TOAST_MS): void {
    const toast = document.createElement("div");
    toast.className =
      variant === "error" ? "wx-toast wx-toast-error wx-toast-transient" : "wx-toast wx-toast-transient";
    toast.textContent = message;
    toastRegion.appendChild(toast);
    setTimeout(() => toast.remove(), durationMs);
  }

  // -- Publish progress watch (decisions/00089) -------------------------------
  // The shell — not the drawer — owns "a publish is running / it just went
  // live": the drawer may be closed mid-publish, the publish may have been
  // started in another tab or by the AI assistant, or the page may have been
  // reloaded mid-job. While `publishJob.isRunning` the watch polls state every
  // PUBLISH_POLL_MS (renderTopBar spins the Publish button and narrates the
  // stage in the chip) and on the terminal job fires exactly one toast —
  // version-guarded so the drawer's own success path and this watch never
  // double-announce.
  //
  // `publishInFlight` bridges the race between the drawer's confirm click and
  // the POST registering the job server-side (the first poll could otherwise
  // see "no job" and stop): set synchronously by onPublishStarted, cleared by
  // onPublishSettled (the drawer's promise settling in ANY outcome — including
  // a 409 that never started a job).
  //
  // Announcing is guarded against the STALE terminal job from a previous
  // publish (the server keeps the last job on `app.state.publish_job`) two
  // ways: `publishWatchSawRunning` (a job the watch itself observed running —
  // the reload-mid-publish / other-tab shape) OR a terminal job whose id
  // differs from the one the watch was armed with (the confirm-click shape —
  // REQUIRED, not redundant: `/api/admin/state`'s git work queues behind the
  // publish's own locks, so a 2s poll can BLOCK for the job's whole lifetime
  // and only ever return it terminal — the e2e "closing the drawer
  // mid-publish" found this).
  let publishWatchTimer: ReturnType<typeof setTimeout> | null = null;
  let publishWatchActive = false;
  let publishWatchPolls = 0;
  let publishWatchSawRunning = false;
  let publishWatchArmedJobId: string | null = null;
  let publishInFlight = false;
  let announcedPublishVersion: number | null = null;

  function ensurePublishWatch(): void {
    if (publishWatchActive) return;
    publishWatchActive = true;
    publishWatchPolls = 0;
    publishWatchSawRunning = false;
    publishWatchArmedJobId = state?.publishJob?.id ?? null;
    void publishWatchTick();
  }

  async function publishWatchTick(): Promise<void> {
    try {
      state = await api.getState();
    } catch {
      // A missed poll isn't independently actionable — stop watching; the
      // periodic revalidation re-arms the watch if the job is still running.
      publishWatchActive = false;
      return;
    }
    renderTopBar();
    const job = state.publishJob;
    if (job?.isRunning === true) {
      publishWatchSawRunning = true;
    } else if (!publishInFlight) {
      // Terminal (or vanished) and no in-flight POST still bridging: announce
      // a job that provably belongs to THIS watch (seen running, or new since
      // arming), never a previous publish's stale terminal record.
      publishWatchActive = false;
      if (
        job !== null &&
        (publishWatchSawRunning || job.id !== publishWatchArmedJobId)
      ) {
        announcePublishFinished(job);
      }
      return;
    }
    // Still running, or the confirm's POST hasn't registered the job yet.
    if (publishWatchPolls >= PUBLISH_WATCH_MAX_POLLS) {
      publishWatchActive = false;
      return;
    }
    publishWatchPolls += 1;
    publishWatchTimer = setTimeout(() => void publishWatchTick(), PUBLISH_POLL_MS);
  }

  function announcePublishSucceeded(version: number): void {
    if (announcedPublishVersion === version) return;
    announcedPublishVersion = version;
    showTransientToast(`Published — version ${version} is live.`, "info", PUBLISH_LIVE_TOAST_MS);
    // A publish changes what's LIVE — recapture every page (the draft's
    // pixels just became the site's).
    thumbnailService.refresh(state?.pages.map((p) => p.slug) ?? []);
  }

  function announcePublishFinished(job: PublishJobData): void {
    if (job.stage === "done" && job.version !== null) {
      announcePublishSucceeded(job.version);
      return;
    }
    if (job.stage === "failed") {
      showTransientToast(
        "Publish failed — your draft changes are safe.",
        "error",
        PUBLISH_FAIL_TOAST_MS,
      );
    }
  }

  // -- Drawer -----------------------------------------------------------------
  // Both drawer kinds share this one slot (never shown together) — switching
  // triggers (e.g. clicking Publish while page settings is open) closes
  // whichever is open and opens the newly-requested one, rather than the
  // single-drawer-era "any drawer open -> just close" toggle.

  let activeDrawer: Drawer | null = null;
  let activeDrawerKind: "pageSettings" | "publish" | null = null;

  function closeDrawer(): void {
    if (activeDrawer === null) return;
    activeDrawer.teardown();
    activeDrawer.element.remove();
    activeDrawer = null;
    activeDrawerKind = null;
  }

  function toggleDrawer(page: string): void {
    if (activeDrawerKind === "pageSettings") {
      closeDrawer();
      return;
    }
    closeDrawer();
    if (opQueue === null) return;
    const drawer = mountPageSettingsDrawer(page, { api, opQueue, onClose: closeDrawer });
    activeDrawer = drawer;
    activeDrawerKind = "pageSettings";
    container.appendChild(drawer.element);
  }

  function openPublishDrawer(): void {
    if (activeDrawerKind === "publish") {
      closeDrawer();
      return;
    }
    closeDrawer();
    if (state === null) return;
    const drawer = mountPublishDrawer({
      api,
      expectedRev: state.draft.rev,
      upstream: state.upstream.aheadOfPublished,
      onClose: closeDrawer,
      onPublishStarted: () => {
        // Bridge the gap until the POST registers the job (renderTopBar shows
        // the busy affordance from THIS click, synchronously) and arm the
        // watch — closing the drawer mid-publish keeps both alive.
        publishInFlight = true;
        renderTopBar();
        ensurePublishWatch();
      },
      onPublishSettled: () => {
        publishInFlight = false;
        renderTopBar();
      },
      onPublished: (version) => {
        void refreshStateInBackground();
        // Same terminal handling as the watch — version-guarded, so whichever
        // of the two paths fires second is a no-op (decisions/00089).
        announcePublishSucceeded(version);
      },
    });
    activeDrawer = drawer;
    activeDrawerKind = "publish";
    container.appendChild(drawer.element);
  }

  // -- Panels -------------------------------------------------------------------

  let state: StateResponse | null = null;
  let opQueue: OpQueue | null = null;
  let activeEditView: EditView | null = null;
  let activeThemePanel: ThemePanel | null = null;
  let activeRoute: Route | null = null;
  let activePanelTeardown: (() => void) | null = null;
  let stateRetryTimer: number | null = null;

  function comingSoon(label: string): HTMLElement {
    const el = document.createElement("div");
    el.className = "wx-coming-soon";
    el.textContent = `${label} is coming in a later milestone.`;
    return el;
  }

  function mountPanel(route: Route): void {
    main.innerHTML = "";
    // Deliberately NOT closeDrawer(): mountPanel is also invoked for SAME-route
    // re-renders (pages-panel refresh after duplicate/delete, and the 60s /
    // visibility revalidation below), which must not yank an open drawer out
    // from under the user — a browser-tab switch used to close the publish
    // review that way (operator report 2026-07-21). Genuine route changes
    // close it in handleRoute instead.

    if (route.kind === "pages") {
      if (state === null) {
        main.textContent = "Loading…";
        return;
      }
      main.appendChild(
        renderPagesPanel(state.pages, {
          onEdit: (slug) => navigateTo({ kind: "edit", page: slug }, win),
          onDuplicate: (fromSlug, slug, navLabel) =>
            api.duplicatePage(fromSlug, slug, navLabel, state?.draft.rev ?? 0),
          onDelete: (slug) => api.deletePage(slug, state?.draft.rev ?? 0),
          onChanged: () => {
            void refreshPagesPanel();
          },
          thumbSrcFor: (slug) => thumbnailUrl(slug, state?.draft.rev ?? 0),
          onThumbError: (slug) => thumbnailService.refresh([slug]),
        }),
      );
      return;
    }

    if (route.kind === "edit") {
      if (opQueue === null) {
        main.textContent = "Loading…";
        return;
      }
      const wrap = document.createElement("div");
      wrap.className = "wx-edit-wrap";

      // The slim one-line edit bar (decisions/00076): icon back button, the
      // device switcher (added by editView between leading/trailing), Settings
      // (renamed from "Page settings" so the row fits on a phone), and the ▾
      // chrome-reveal toggle. Both title bars are hidden in edit view via the
      // wx-shell-editing class (see handleRoute).
      const backButton = document.createElement("button");
      backButton.type = "button";
      backButton.className = "wx-edit-back";
      backButton.textContent = "←";
      backButton.title = "Back to pages";
      backButton.setAttribute("aria-label", "Back to pages");
      backButton.addEventListener("click", () => navigateTo({ kind: "pages" }, win));

      const settingsButton = document.createElement("button");
      settingsButton.type = "button";
      settingsButton.className = "wx-page-settings-trigger";
      settingsButton.textContent = "Settings";
      settingsButton.addEventListener("click", () => toggleDrawer(route.page));

      const revealButton = document.createElement("button");
      revealButton.type = "button";
      revealButton.className = "wx-chrome-reveal";
      revealButton.textContent = "▾";
      revealButton.title = "Show the menu (10 seconds)";
      revealButton.setAttribute("aria-label", "Show the menu temporarily");
      revealButton.setAttribute("aria-pressed", "false");
      revealButton.addEventListener("click", () => toggleChromeReveal(revealButton));

      const view = createEditView(route.page, {
        api,
        opQueue,
        win,
        onOverlayNavigated: (page) => navigateTo({ kind: "edit", page }, win),
        // No publish chrome here: the draft chip + Publish button live in the
        // always-visible status bar above (decisions/00083), so the slim bar
        // keeps just navigation, device, page settings, and chrome reveal.
        toolbarLeading: [backButton],
        toolbarTrailing: [settingsButton, revealButton],
        // And the bar itself pins into the shell chrome (decisions/00082) —
        // never the scrolling main.
        toolbarHost: editBarHost,
      });
      activeEditView = view;
      wrap.appendChild(view.element);
      main.appendChild(wrap);
      activePanelTeardown = () => {
        view.teardown();
        activeEditView = null;
      };
      return;
    }

    if (route.kind === "theme") {
      if (opQueue === null) {
        main.textContent = "Loading…";
        return;
      }
      const panel = mountThemePanel({ api, opQueue, mountEditView: createEditView, win });
      activeThemePanel = panel;
      main.appendChild(panel.element);
      activePanelTeardown = () => {
        panel.teardown();
        activeThemePanel = null;
      };
      return;
    }

    if (route.kind === "media") {
      const panel = mountMediaPanel(api, win);
      main.appendChild(panel.element);
      activePanelTeardown = () => panel.teardown();
      return;
    }

    if (route.kind === "history") {
      const panel = mountHistoryPanel({
        api,
        onDraftChanged: () => {
          void refreshStateInBackground();
          // Reinstate/restore rewrites draft state — recapture everything so
          // thumbnails track the reverted content (the "cancel reverts it"
          // half of the operator's graceful-handling ask).
          thumbnailService.refresh(state?.pages.map((p) => p.slug) ?? []);
        },
      });
      main.appendChild(panel.element);
      activePanelTeardown = () => panel.teardown();
      return;
    }

    if (route.kind === "chat") {
      const panel = createChatPanel(route.conversation, { api, win });
      main.appendChild(panel.element);
      activePanelTeardown = () => panel.teardown();
      return;
    }

    if (route.kind === "settings") {
      const panel = mountSettingsPanel({
        win,
        page: route.page,
        api,
        themeController,
        zoomController,
        fontScaleController,
        shortcutsController,
        themeEditorController,
        onNavigate: (page) => navigateTo({ kind: "settings", page }, win),
        onResetAll: resetAllSettings,
      });
      main.appendChild(panel.element);
      activePanelTeardown = () => panel.teardown();
      return;
    }
  }

  // -- Edit-view chrome (decisions/00076) --------------------------------------
  // In edit view both title bars hide (CSS, driven by wx-shell-editing) so the
  // preview owns the screen; the ▾ button in the slim edit bar slides the
  // chrome back down for CHROME_REVEAL_MS, then it auto-hides. Route changes
  // always restore the correct state.

  const CHROME_REVEAL_MS = 10_000;
  let chromeRevealTimer: ReturnType<typeof setTimeout> | null = null;

  function setChromeRevealed(revealed: boolean, button?: HTMLButtonElement): void {
    container.classList.toggle("wx-shell-chrome-revealed", revealed);
    button?.setAttribute("aria-pressed", String(revealed));
    if (chromeRevealTimer !== null) {
      clearTimeout(chromeRevealTimer);
      chromeRevealTimer = null;
    }
    if (revealed) {
      chromeRevealTimer = setTimeout(() => {
        chromeRevealTimer = null;
        container.classList.remove("wx-shell-chrome-revealed");
        container
          .querySelector(".wx-chrome-reveal")
          ?.setAttribute("aria-pressed", "false");
      }, CHROME_REVEAL_MS);
    }
  }

  function toggleChromeReveal(button: HTMLButtonElement): void {
    setChromeRevealed(!container.classList.contains("wx-shell-chrome-revealed"), button);
  }

  function handleRoute(route: Route): void {
    const reuseEditView =
      activeRoute?.kind === "edit" && route.kind === "edit" && activeEditView !== null;
    activeRoute = route;
    setChromeRevealed(false);
    container.classList.toggle("wx-shell-editing", route.kind === "edit");
    setActiveNavItem(route);
    saveLastRoute(route, win);
    // A genuine route change always closes an open drawer (it belongs to the
    // view you were on). Same-route panel re-renders never reach here — see
    // mountPanel's comment — so this can't fire on a background revalidation.
    closeDrawer();
    if (reuseEditView && route.kind === "edit" && activeEditView !== null) {
      activeEditView.setPage(route.page);
      return;
    }
    activePanelTeardown?.();
    activePanelTeardown = null;
    mountPanel(route);
  }

  // -- State loading ----------------------------------------------------------

  async function loadState(): Promise<void> {
    try {
      const fresh = await api.getState();
      const isFirstLoad = state === null;
      state = fresh;
      hideStateError();
      if (opQueue === null) {
        opQueue = new OpQueue(fresh.draft.rev, {
          sendPatch: (expectedRev, ops) => api.patchDraft(expectedRev, ops),
          fetchCurrentRev: async () => (await api.getState()).draft.rev,
          onAccepted: (ops) => {
            activeEditView?.applyOps(ops);
            activeThemePanel?.onOpsAccepted(ops);
            void refreshStateInBackground();
            refreshThumbnailsForOps(ops);
          },
          onError: () => showTransientToast("Couldn't save your last change — retrying…"),
        });
      }
      renderTopBar();
      if (isFirstLoad) handleRoute(currentRoute(win));
    } catch {
      showStateError();
      stateRetryTimer = setTimeout(() => void loadState(), STATE_RETRY_MS) as unknown as number;
    }
  }

  /** Refreshes top-bar data (draft opCount, upstream count) after an accepted
   * PATCH — deliberately never touches routing or the mounted panel: remounting
   * the edit view here would tear down and reload the iframe on every accepted
   * keystroke batch. The pages panel picks up fresh data next time it's mounted. */
  async function refreshStateInBackground(): Promise<void> {
    try {
      state = await api.getState();
      renderTopBar();
    } catch {
      // Best-effort — the OpQueue's own onError already surfaces a real save
      // failure; a background refresh miss here isn't independently actionable.
    }
  }

  /** Unlike `refreshStateInBackground` (deliberately never touches the mounted
   * panel, so an in-progress edit iframe isn't reloaded mid-keystroke), the
   * pages panel has no live-typing state to lose — re-rendering it after a
   * duplicate/delete succeeds is safe and is what actually shows the
   * new/removed page immediately. */
  async function refreshPagesPanel(): Promise<void> {
    await refreshStateInBackground();
    if (activeRoute?.kind === "pages") mountPanel(activeRoute);
  }

  // -- Revalidation (Edit-button latch incident, 2026-07-19) -------------------
  // A snapshot fetched at one bad moment used to latch forever: no periodic
  // refresh, no focus refresh, and a tab could outlive many Slots deploys.
  // Now: while the tab is visible, state revalidates every REVALIDATE_MS and
  // whenever the tab regains visibility; a mounted pages panel re-renders from
  // the fresh snapshot (it has no typing state to lose — same rationale as
  // refreshPagesPanel); and a server deploy (commit change on /api/version)
  // reloads the shell outside the edit view (inside it, a toast asks instead —
  // never yank a live editing iframe out from under a keystroke).

  const REVALIDATE_MS = 60_000;
  let knownServerCommit: string | null = null;

  async function revalidate(): Promise<void> {
    if (win.document.visibilityState !== "visible") return;
    const commit = await api.getServerCommit();
    if (commit !== null) {
      if (knownServerCommit === null) {
        knownServerCommit = commit;
      } else if (commit !== knownServerCommit) {
        if (activeRoute?.kind !== "edit") {
          win.location.reload();
          return;
        }
        showTransientToast("Wixy was updated — reload the page when you're done here");
        knownServerCommit = commit;
      }
    }
    await refreshStateInBackground();
    if (activeRoute?.kind === "pages") mountPanel(activeRoute);
  }

  // Capability-guarded: unit-test fakes of `win` may omit timers/document.
  const revalidateTimer =
    typeof win.setInterval === "function"
      ? win.setInterval(() => void revalidate(), REVALIDATE_MS)
      : null;
  const onVisibilityChange = (): void => {
    if (win.document?.visibilityState === "visible") void revalidate();
  };
  if (typeof win.document?.addEventListener === "function") {
    win.document.addEventListener("visibilitychange", onVisibilityChange);
  }

  // Uxer session-persistence mandate (item 6, "last active view/module"): an
  // explicit deep link always wins (normal web navigation expectations) — and a
  // LEGACY "#/…" deep link additionally gets canonicalized to its path spelling
  // (decisions/00087). Only a truly bare "/admin" load (no path route, no hash)
  // falls back to wherever the user last was, restored by navigating (not just
  // calling handleRoute directly) so the address bar stays truthful too; with
  // nothing stored, the bare URL is canonicalized to "/admin/pages".
  const hasLegacyHash = win.location.hash.replace(/^#/, "").length > 0;
  const isBareAdmin = win.location.pathname === "/admin" || win.location.pathname === "/admin/";
  if (hasLegacyHash) {
    canonicalizeUrl(win);
  } else if (isBareAdmin) {
    const lastRoute = loadLastRoute(win);
    if (lastRoute !== null) navigateTo(lastRoute, win);
    else canonicalizeUrl(win);
  }

  const unsubscribeRoute = onRouteChange(handleRoute, win);
  void loadState();

  return {
    teardown(): void {
      unsubscribeRoute();
      if (revalidateTimer !== null) win.clearInterval(revalidateTimer);
      if (typeof win.document?.removeEventListener === "function") {
        win.document.removeEventListener("visibilitychange", onVisibilityChange);
      }
      if (stateRetryTimer !== null) clearTimeout(stateRetryTimer);
      if (chromeRevealTimer !== null) clearTimeout(chromeRevealTimer);
      if (publishWatchTimer !== null) clearTimeout(publishWatchTimer);
      win.removeEventListener("keydown", onSecondaryEscape);
      closeSecondary();
      narrowMedia?.removeEventListener("change", onNarrowChange);
      activePanelTeardown?.();
      closeDrawer();
      thumbnailService.teardown();
      themeController.teardown();
      shortcutsController.teardown();
      themeEditorController.teardown();
    },
  };
}
