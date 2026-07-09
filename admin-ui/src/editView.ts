// The edit-mode iframe host (spec/05-editor.md §2): a device-width toolbar and an
// iframe loading `/admin/preview/<page>.html`, wired to the overlay via
// postMessage and to the server via the shared OpQueue (slice 1's
// `admin-ui/src/opQueue.ts`).
//
// Split into a pure-ish message-routing CORE (`createEditViewCore`, directly unit
// testable with fake `postToOverlay`/`loadPage`/api/queue — same shape as
// `editor/src/overlay.ts`'s internal handlers) and a thin DOM-mounting wrapper
// (`mountEditView`) that wires the core to a real iframe/device toolbar. Neither
// jsdom's `<iframe>` nor its cross-document postMessage is reliable enough to
// unit-test the real DOM wiring directly, so the core/wrapper split is what makes
// this testable at all, not just a style preference.

import type { AdminApi } from "./api";
import { parseOverlayToShellMessage, type DraftOp, type ShellToOverlayMessage } from "./protocol";

export type Device = "desktop" | "tablet" | "mobile";

/** The narrow slice of `OpQueue` (opQueue.ts) this module actually uses — a
 * structural interface rather than the concrete class, so tests can pass a
 * plain fake without constructing a real queue (OpQueue's private fields would
 * otherwise make a plain object literal structurally incompatible). The real
 * `OpQueue` class satisfies this without any change. */
export interface OpQueueLike {
  readonly rev: number;
  enqueue(op: DraftOp): void;
}

export const DEVICE_WIDTHS: Record<Device, number> = { desktop: 1280, tablet: 820, mobile: 390 };
export const DEVICE_LABELS: Record<Device, string> = {
  desktop: "Desktop",
  tablet: "Tablet",
  mobile: "Mobile",
};

export interface EditViewCoreDeps {
  api: AdminApi;
  opQueue: OpQueueLike;
  postToOverlay: (message: ShellToOverlayMessage) => void;
  /** Point the iframe element at a new page's preview URL (a real navigation —
   * the caller's job, this core never touches DOM). */
  loadPage: (page: string) => void;
  /** The overlay reported it navigated the iframe internally (an intercepted
   * content-link click, spec/05 §2) — the shell should follow along (URL hash,
   * pages-panel highlighting) WITHOUT calling `loadPage` again; the iframe
   * already navigated itself. */
  onOverlayNavigated: (page: string) => void;
}

export interface EditViewCore {
  /** Route one already-origin-checked postMessage payload. */
  handleMessage(data: unknown): void;
  /** Point at a different page. No-ops if already showing `page` — the case
   * right after `onOverlayNavigated` fires and the shell's own router re-enters
   * here in response to its own hash update. */
  setPage(page: string): void;
  readonly currentPage: string;
}

export function createEditViewCore(initialPage: string, deps: EditViewCoreDeps): EditViewCore {
  let currentPage = initialPage;
  let loadToken = 0;

  function requestInit(atToken: number): void {
    deps.api
      .getContent(currentPage)
      .then(({ bindings }) => {
        if (atToken !== loadToken) return; // superseded by a newer navigation
        deps.postToOverlay({
          wx: 1,
          type: "init",
          page: currentPage,
          bindings,
          draftRev: deps.opQueue.rev,
        });
      })
      .catch(() => {
        // A transient content-fetch failure here surfaces the same way any other
        // /api/admin/* failure does — via the shell's own state-refresh toast
        // (spec/05 §7); the overlay simply never receives `init` and stays
        // inert (no popovers open) until the next successful load/reload.
      });
  }

  return {
    handleMessage(data: unknown): void {
      const message = parseOverlayToShellMessage(data);
      if (message === null) return;
      switch (message.type) {
        case "ready":
          requestInit(loadToken);
          return;
        case "op": {
          const op: DraftOp = { file: message.file, path: message.path, value: message.value };
          deps.opQueue.enqueue(op);
          return;
        }
        case "navigate":
          currentPage = message.page;
          loadToken += 1;
          deps.onOverlayNavigated(message.page);
          return;
        case "selected":
        case "mediaRequest":
          return; // selected: no shell UI reacts to it yet; mediaRequest: milestone 8's media dialog
      }
    },
    setPage(page: string): void {
      if (page === currentPage) return;
      currentPage = page;
      loadToken += 1;
      deps.loadPage(page);
    },
    get currentPage(): string {
      return currentPage;
    },
  };
}

export interface EditView {
  readonly element: HTMLElement;
  setPage(page: string): void;
  /** Forward a server-accepted batch to the overlay as `applyOps` (spec/05 §2:
   * "echo after server accept") — a no-op if this view has since been torn down
   * or navigated to a different iframe document; the overlay ignores stale
   * echoes harmlessly in any case (decisions/00017: nothing to reconcile in v1). */
  applyOps(ops: DraftOp[]): void;
  teardown(): void;
}

export interface MountEditViewDeps {
  api: AdminApi;
  opQueue: OpQueueLike;
  onOverlayNavigated: (page: string) => void;
  win?: Window;
}

export function mountEditView(page: string, deps: MountEditViewDeps): EditView {
  const win = deps.win ?? window;

  const root = document.createElement("div");
  root.className = "wx-edit-view";

  const toolbar = document.createElement("div");
  toolbar.className = "wx-device-toolbar";
  const buttons = {} as Record<Device, HTMLButtonElement>;
  (Object.keys(DEVICE_WIDTHS) as Device[]).forEach((device) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = DEVICE_LABELS[device];
    button.addEventListener("click", () => setDevice(device));
    buttons[device] = button;
    toolbar.appendChild(button);
  });

  const frameWrap = document.createElement("div");
  frameWrap.className = "wx-iframe-wrap";
  const iframe = document.createElement("iframe");
  iframe.className = "wx-preview-iframe";
  iframe.title = "Page preview";
  frameWrap.appendChild(iframe);

  root.append(toolbar, frameWrap);

  function postToOverlay(message: ShellToOverlayMessage): void {
    iframe.contentWindow?.postMessage(message, win.location.origin);
  }

  function setDevice(device: Device): void {
    frameWrap.style.width = `${DEVICE_WIDTHS[device]}px`;
    (Object.keys(buttons) as Device[]).forEach((key) => {
      buttons[key].classList.toggle("wx-device-active", key === device);
    });
    postToOverlay({ wx: 1, type: "setDevice", device });
  }

  const core = createEditViewCore(page, {
    api: deps.api,
    opQueue: deps.opQueue,
    postToOverlay,
    loadPage: (nextPage) => {
      iframe.src = `/admin/preview/${nextPage}.html`;
    },
    onOverlayNavigated: deps.onOverlayNavigated,
  });

  const messageListener = (event: MessageEvent): void => {
    if (event.origin !== win.location.origin) return;
    core.handleMessage(event.data);
  };
  win.addEventListener("message", messageListener);

  iframe.src = `/admin/preview/${page}.html`;
  setDevice("desktop");

  return {
    element: root,
    setPage: (nextPage) => core.setPage(nextPage),
    applyOps: (ops) => postToOverlay({ wx: 1, type: "applyOps", ops }),
    teardown(): void {
      win.removeEventListener("message", messageListener);
    },
  };
}
