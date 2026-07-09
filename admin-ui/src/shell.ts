// The admin shell (spec/05-editor.md §1): top bar (project name, draft-status
// chip, Publish button, "Site ▸" link) + left nav + main panel, hydrated from
// `/api/admin/state` (fleet instant-render rule: the shell chrome below paints
// synchronously in `mountShell`; panel content/data arrives async into
// skeletons). Owns the ONE OpQueue for the whole session (spec/05 §2: "the shell
// owns state") — panels never construct their own.

import { createApi, type AdminApi, type StateResponse } from "./api";
import { mountEditView as mountEditViewReal, type EditView, type MountEditViewDeps } from "./editView";
import { OpQueue } from "./opQueue";
import { mountPageSettingsDrawer, type PageSettingsDrawer } from "./pageSettingsDrawer";
import { renderPagesPanel } from "./pagesPanel";
import { currentRoute, navigateTo, onRouteChange, type Route } from "./router";
import { mountThemePanel, type ThemePanel } from "./themePanel";

const STATE_RETRY_MS = 5000;
const TRANSIENT_TOAST_MS = 4000;

type MountEditViewFn = (page: string, deps: MountEditViewDeps) => EditView;

export interface ShellDeps {
  api?: AdminApi;
  win?: Window;
  mountEditView?: MountEditViewFn;
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

  container.innerHTML = "";
  container.className = "wx-shell";

  const topbar = document.createElement("div");
  topbar.className = "wx-topbar";
  const titleEl = document.createElement("span");
  titleEl.className = "wx-topbar-title";
  titleEl.textContent = "Wixy";
  const spacer = document.createElement("span");
  spacer.className = "wx-topbar-spacer";
  const chipEl = document.createElement("span");
  chipEl.className = "wx-draft-chip";
  const publishButton = document.createElement("button");
  publishButton.type = "button";
  publishButton.className = "wx-publish-button";
  publishButton.textContent = "Publish";
  publishButton.disabled = true;
  publishButton.title = "Publishing arrives in milestone 9";
  const siteLink = document.createElement("a");
  siteLink.className = "wx-site-link";
  siteLink.textContent = "Site ▸";
  siteLink.target = "_blank";
  siteLink.rel = "noopener noreferrer";
  siteLink.hidden = true;
  topbar.append(titleEl, spacer, chipEl, publishButton, siteLink);

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

  let activeDrawer: PageSettingsDrawer | null = null;

  function closeDrawer(): void {
    if (activeDrawer === null) return;
    activeDrawer.teardown();
    activeDrawer.element.remove();
    activeDrawer = null;
  }

  function toggleDrawer(page: string): void {
    if (activeDrawer !== null) {
      closeDrawer();
      return;
    }
    if (opQueue === null) return;
    const drawer = mountPageSettingsDrawer(page, { api, opQueue, onClose: closeDrawer });
    activeDrawer = drawer;
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

    const labels: Record<Exclude<Route["kind"], "pages" | "edit" | "theme">, string> = {
      media: "Media",
      chat: "Chat",
      history: "History",
    };
    main.appendChild(comingSoon(labels[route.kind]));
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

  const unsubscribeRoute = onRouteChange(handleRoute, win);
  void loadState();

  return {
    teardown(): void {
      unsubscribeRoute();
      if (stateRetryTimer !== null) clearTimeout(stateRetryTimer);
      activePanelTeardown?.();
      closeDrawer();
    },
  };
}
