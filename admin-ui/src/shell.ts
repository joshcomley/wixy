// The admin shell (spec/05-editor.md §1): top bar (project name, draft-status
// chip, Publish button, "Site ▸" link) + left nav + main panel, hydrated from
// `/api/admin/state` (fleet instant-render rule: the shell chrome below paints
// synchronously in `mountShell`; panel content/data arrives async into
// skeletons). Owns the ONE OpQueue for the whole session (spec/05 §2: "the shell
// owns state") — panels never construct their own.

import { createApi, type AdminApi, type StateResponse } from "./api";
import { mountChatPanel as mountChatPanelReal, type ChatPanel, type ChatPanelDeps } from "./chatPanel";
import { mountEditView as mountEditViewReal, type EditView, type MountEditViewDeps } from "./editView";
import { mountHistoryPanel } from "./historyPanel";
import { mountMediaPanel, type MediaPanel } from "./mediaPanel";
import { OpQueue } from "./opQueue";
import { mountPageSettingsDrawer } from "./pageSettingsDrawer";
import { renderPagesPanel } from "./pagesPanel";
import { mountPublishDrawer } from "./publishDrawer";
import { currentRoute, navigateTo, onRouteChange, type Route } from "./router";
import { mountThemePanel, type ThemePanel } from "./themePanel";
import { initTheme, type ThemeController, type ThemeMode } from "./theme";
import { initZoom, type ZoomController } from "./zoom";
import { initFontScale, type FontScaleController } from "./fontScale";

interface Drawer {
  element: HTMLElement;
  teardown(): void;
}

const STATE_RETRY_MS = 5000;
const TRANSIENT_TOAST_MS = 4000;

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

  container.innerHTML = "";
  container.className = "wx-shell";

  const topbar = document.createElement("div");
  topbar.className = "wx-topbar";
  const titleEl = document.createElement("span");
  titleEl.className = "wx-topbar-title";
  titleEl.textContent = "Wixy";
  const spacer = document.createElement("span");
  spacer.className = "wx-topbar-spacer";
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
  const siteLink = document.createElement("a");
  siteLink.className = "wx-site-link";
  siteLink.textContent = "Site ▸";
  siteLink.target = "_blank";
  siteLink.rel = "noopener noreferrer";
  siteLink.hidden = true;

  const zoomOutButton = document.createElement("button");
  zoomOutButton.type = "button";
  zoomOutButton.className = "wx-zoom-button";
  zoomOutButton.textContent = "−";
  zoomOutButton.title = "Zoom out (Ctrl+-)";
  zoomOutButton.setAttribute("aria-label", "Zoom out");
  const zoomLevelEl = document.createElement("span");
  zoomLevelEl.className = "wx-zoom-level";
  const zoomInButton = document.createElement("button");
  zoomInButton.type = "button";
  zoomInButton.className = "wx-zoom-button";
  zoomInButton.textContent = "+";
  zoomInButton.title = "Zoom in (Ctrl++)";
  zoomInButton.setAttribute("aria-label", "Zoom in");
  function renderZoom(): void {
    zoomLevelEl.textContent = `${zoomController.getLevel()}%`;
  }
  // `onChange` (not just the click handlers below) drives the label so a
  // Ctrl+Plus/Minus/0 keyboard shortcut — handled entirely inside zoom.ts's
  // own listener — still refreshes it; relying only on click handlers left
  // the label silently stale after a keyboard-triggered change.
  const zoomController = initZoom(win, document, renderZoom);
  zoomOutButton.addEventListener("click", () => zoomController.zoomOut());
  zoomInButton.addEventListener("click", () => zoomController.zoomIn());
  renderZoom();
  const zoomGroup = document.createElement("div");
  zoomGroup.className = "wx-zoom-controls";
  zoomGroup.setAttribute("role", "group");
  zoomGroup.setAttribute("aria-label", "Zoom");
  zoomGroup.append(zoomOutButton, zoomLevelEl, zoomInButton);

  const fontScaleDownButton = document.createElement("button");
  fontScaleDownButton.type = "button";
  fontScaleDownButton.className = "wx-font-scale-button";
  fontScaleDownButton.textContent = "A−";
  fontScaleDownButton.title = "Decrease font size (Ctrl+Shift+-)";
  fontScaleDownButton.setAttribute("aria-label", "Decrease font size");
  const fontScaleLevelEl = document.createElement("span");
  fontScaleLevelEl.className = "wx-font-scale-level";
  const fontScaleUpButton = document.createElement("button");
  fontScaleUpButton.type = "button";
  fontScaleUpButton.className = "wx-font-scale-button";
  fontScaleUpButton.textContent = "A+";
  fontScaleUpButton.title = "Increase font size (Ctrl+Shift++)";
  fontScaleUpButton.setAttribute("aria-label", "Increase font size");
  function renderFontScale(): void {
    fontScaleLevelEl.textContent = `${fontScaleController.getLevel()}%`;
  }
  // Same onChange reasoning as zoomController above.
  const fontScaleController = initFontScale(win, document, renderFontScale);
  fontScaleDownButton.addEventListener("click", () => fontScaleController.decrease());
  fontScaleUpButton.addEventListener("click", () => fontScaleController.increase());
  renderFontScale();
  const fontScaleGroup = document.createElement("div");
  fontScaleGroup.className = "wx-font-scale-controls";
  fontScaleGroup.setAttribute("role", "group");
  fontScaleGroup.setAttribute("aria-label", "Font size");
  fontScaleGroup.append(fontScaleDownButton, fontScaleLevelEl, fontScaleUpButton);

  const themeController = initTheme(win);
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
    renderThemeToggle();
  });
  renderThemeToggle();

  topbar.append(
    titleEl,
    spacer,
    chipEl,
    publishButton,
    siteLink,
    zoomGroup,
    fontScaleGroup,
    themeToggle,
  );

  const body = document.createElement("div");
  body.className = "wx-body";
  const navEl = document.createElement("nav");
  navEl.className = "wx-nav";
  const main = document.createElement("main");
  main.className = "wx-main";
  main.textContent = "Loading…";
  body.append(navEl, main);

  const toastRegion = document.createElement("div");
  toastRegion.className = "wx-toast-region";

  container.append(topbar, body, toastRegion);

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

  const editNavItem = document.createElement("button");
  editNavItem.type = "button";
  editNavItem.className = "wx-nav-item wx-nav-item-edit";
  editNavItem.disabled = true;
  editNavItem.dataset["routeKind"] = "edit";
  editNavItem.textContent = "Edit";

  navEl.appendChild(navButton("Pages", { kind: "pages" }));
  navEl.appendChild(editNavItem);
  for (const item of NAV_ROUTES.slice(1)) {
    navEl.appendChild(navButton(item.label, item.route));
  }

  function setActiveNavItem(route: Route): void {
    navEl.querySelectorAll<HTMLElement>(".wx-nav-item").forEach((el) => {
      el.classList.toggle("wx-nav-active", el.dataset["routeKind"] === route.kind);
    });
    editNavItem.textContent = route.kind === "edit" ? `Edit: ${route.page}` : "Edit";
  }

  // -- Top bar ------------------------------------------------------------------

  function renderTopBar(): void {
    if (state === null) return;
    titleEl.textContent = `Wixy · ${state.project.name}`;
    const opCount = state.draft.opCount;
    const ahead = state.upstream.aheadOfPublished.length;
    const parts: string[] = [opCount === 1 ? "1 change" : `${opCount} changes`];
    if (ahead > 0) parts.push(ahead === 1 ? "1 upstream commit" : `${ahead} upstream commits`);
    chipEl.textContent = parts.join(" · ");
    siteLink.href = `https://${state.project.domain}`;
    siteLink.hidden = false;

    // spec/05 §5: "Publishes are serialized server-side; the UI disables
    // Publish while one runs" — also true for the chip, the drawer's other
    // trigger.
    const publishing = state.publishJob?.isRunning === true;
    publishButton.disabled = publishing;
    chipEl.disabled = publishing;
    publishButton.title = publishing ? "A publish is already running…" : "";
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

  function showTransientError(message: string): void {
    const toast = document.createElement("div");
    toast.className = "wx-toast wx-toast-error wx-toast-transient";
    toast.textContent = message;
    toastRegion.appendChild(toast);
    setTimeout(() => toast.remove(), TRANSIENT_TOAST_MS);
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
      onPublished: () => {
        void refreshStateInBackground();
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
    closeDrawer();

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
      const toolbarRow = document.createElement("div");
      toolbarRow.className = "wx-edit-toolbar-row";
      const settingsButton = document.createElement("button");
      settingsButton.type = "button";
      settingsButton.className = "wx-page-settings-trigger";
      settingsButton.textContent = "Page settings";
      settingsButton.addEventListener("click", () => toggleDrawer(route.page));
      toolbarRow.appendChild(settingsButton);
      wrap.appendChild(toolbarRow);

      const view = createEditView(route.page, {
        api,
        opQueue,
        win,
        onOverlayNavigated: (page) => navigateTo({ kind: "edit", page }, win),
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
        onRestored: () => {
          void refreshStateInBackground();
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
  }

  function handleRoute(route: Route): void {
    const reuseEditView =
      activeRoute?.kind === "edit" && route.kind === "edit" && activeEditView !== null;
    activeRoute = route;
    setActiveNavItem(route);
    if (reuseEditView && route.kind === "edit" && activeEditView !== null) {
      closeDrawer();
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
          },
          onError: () => showTransientError("Couldn't save your last change — retrying…"),
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

  const unsubscribeRoute = onRouteChange(handleRoute, win);
  void loadState();

  return {
    teardown(): void {
      unsubscribeRoute();
      if (stateRetryTimer !== null) clearTimeout(stateRetryTimer);
      activePanelTeardown?.();
      closeDrawer();
      themeController.teardown();
      zoomController.teardown();
      fontScaleController.teardown();
    },
  };
}
