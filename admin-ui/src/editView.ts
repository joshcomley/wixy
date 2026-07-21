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
import { openMediaDialog } from "./mediaDialog";
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

/** The whole-iframe scale for device simulation: 1 when the wrap is at least as
 * wide as the device, otherwise the shrink factor that makes the full device
 * layout visible (squished) on a narrower screen (decisions/00076). Never 0 —
 * a not-yet-laid-out wrap (jsdom, hidden mount) yields 1 rather than collapse. */
export function viewportScaleFor(wrapWidth: number, deviceWidth: number): number {
  if (wrapWidth <= 0) return 1;
  return Math.min(1, wrapWidth / deviceWidth);
}

/** The device the edit view opens in: follow the USER'S OWN form factor
 * (decisions/00084 — operator 2026-07-21: "the default display should be what
 * the user is on, auto detected"). The predecessor check (`innerWidth < 480`)
 * read any phone reporting ≥480 CSS px (a real configuration — display-size
 * settings, unusual DPRs) as "desktop always", and had no tablet answer at
 * all. The coarse-pointer signal is what separates a big phone/small tablet
 * from a desktop window of the same width; width alone decides for non-touch
 * screens (a narrow desktop window previews as its closest small form factor). */
export function initialDeviceFor(width: number, coarsePointer: boolean): Device {
  if (width <= 0) return "desktop"; // unmeasurable (pre-layout, jsdom) — unchanged fallback
  if (width < 600) return "mobile"; // any phone portrait; also a narrow desktop window
  if (coarsePointer) {
    if (width < 768) return "mobile"; // phone landscape, small foldables
    if (width <= 1366) return "tablet"; // tablets up to iPad Pro landscape
    return "desktop";
  }
  return width < 1024 ? "tablet" : "desktop";
}

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
  /** The overlay wants to replace an image binding (spec/05 §2's "Replace image"
   * button emits `mediaRequest {key}`) — `key` is the RAW binding key as-is
   * (may be item-scoped, e.g. ".img"); this core never resolves it further, same
   * "DOM-adjacent effects belong to the caller" boundary as `onOverlayNavigated`. */
  onMediaRequest: (key: string) => void;
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
        case "mediaRequest":
          deps.onMediaRequest(message.key);
          return;
        case "selected":
          return; // no shell UI reacts to it yet
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
  /** Send an arbitrary shell -> overlay message to this view's iframe — the
   * general-purpose escape hatch `applyOps` is itself built on. The theme panel
   * (milestone 8 slice 2) uses this to live-apply `themeVars`/`themeFonts` to its
   * OWN embedded preview iframe; `editView.ts` stays free of theme-specific
   * knowledge (decisions/00021) by only exposing the generic send. */
  postMessage(message: ShellToOverlayMessage): void;
  teardown(): void;
}

export interface MountEditViewDeps {
  api: AdminApi;
  opQueue: OpQueueLike;
  onOverlayNavigated: (page: string) => void;
  win?: Window;
  /** Extra toolbar content the caller (shell) wants in the device toolbar's
   * row — leading goes before the device buttons (e.g. a back button),
   * trailing after the right-hand spacer (e.g. page settings, chrome reveal).
   * Kept as opaque elements so editView stays free of shell concerns. */
  toolbarLeading?: HTMLElement[];
  toolbarTrailing?: HTMLElement[];
  /** Fired each time the overlay inside the iframe (re)sends `ready` — i.e.
   * after every (re)load, when it can actually receive messages again. The
   * theme panel re-posts its live vars on this signal so a theme change made
   * while the iframe was still loading (or mid-reload) isn't silently lost
   * (the E2E-3 full-suite flake, decisions/00076). */
  onOverlayReady?: () => void;
  /** Mount the device toolbar into THIS host element instead of the edit
   * view's own root — the shell uses it to pin the slim edit bar in the
   * non-scrolling chrome (operator 2026-07-22: the bar must ALWAYS be
   * visible; inside the scrolling main it could scroll out of reach,
   * decisions/00082). The edit view's root then contains only the iframe. */
  toolbarHost?: HTMLElement;
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
  const deviceGroup = document.createElement("div");
  deviceGroup.className = "wx-device-group";
  (Object.keys(buttons) as Device[]).forEach((device) =>
    deviceGroup.appendChild(buttons[device]),
  );
  toolbar.innerHTML = "";
  for (const el of deps.toolbarLeading ?? []) toolbar.appendChild(el);
  toolbar.appendChild(deviceGroup);
  const toolbarSpacer = document.createElement("span");
  toolbarSpacer.className = "wx-device-toolbar-spacer";
  toolbar.appendChild(toolbarSpacer);
  for (const el of deps.toolbarTrailing ?? []) toolbar.appendChild(el);

  const frameWrap = document.createElement("div");
  frameWrap.className = "wx-iframe-wrap";
  const iframe = document.createElement("iframe");
  iframe.className = "wx-preview-iframe";
  iframe.title = "Page preview";
  frameWrap.appendChild(iframe);

  if (deps.toolbarHost !== undefined) {
    deps.toolbarHost.appendChild(toolbar);
    root.appendChild(frameWrap);
  } else {
    root.append(toolbar, frameWrap);
  }

  function postToOverlay(message: ShellToOverlayMessage): void {
    iframe.contentWindow?.postMessage(message, win.location.origin);
  }

  // -- Device simulation -----------------------------------------------------
  // The iframe element is sized to the DEVICE's CSS width and, when the wrap
  // is narrower, transform-scaled down — so tablet/desktop previews on a phone
  // show the whole squished layout rather than three identical widths
  // (decisions/00076). The scale rides the setDevice message so overlay chrome
  // (the composer) can counter-scale and stay legible.

  let currentDevice: Device = "desktop";

  function applyViewport(): void {
    const wrapWidth = frameWrap.clientWidth || win.innerWidth;
    const wrapHeight = frameWrap.clientHeight;
    const deviceWidth = DEVICE_WIDTHS[currentDevice];
    const scale = viewportScaleFor(wrapWidth, deviceWidth);
    iframe.style.width = `${deviceWidth}px`;
    // Only size the height from a MEASURED wrap — the pre-layout fallback to
    // window.innerHeight overshoots (the wrap is shorter than the window once
    // the slim bar exists), and an over-tall iframe is exactly the sort of
    // thing that can push the main area into scrolling (decisions/00082).
    // Until the wrap has laid out, the stylesheet's height:100% covers it.
    if (wrapHeight > 0) {
      iframe.style.height = `${Math.max(1, Math.round(wrapHeight / scale))}px`;
    }
    iframe.style.transform = scale === 1 ? "" : `scale(${scale})`;
    // deviceWidth * scale == wrapWidth exactly when shrunk (fills the wrap);
    // at scale 1 on a wider wrap, center the device frame as before.
    iframe.style.marginLeft = `${Math.max(0, (wrapWidth - deviceWidth * scale) / 2)}px`;
    postToOverlay({ wx: 1, type: "setDevice", device: currentDevice, scale });
  }

  function setDevice(device: Device): void {
    currentDevice = device;
    (Object.keys(buttons) as Device[]).forEach((key) => {
      buttons[key].classList.toggle("wx-device-active", key === device);
    });
    applyViewport();
  }

  const resizeObserver =
    typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => applyViewport())
      : null;
  resizeObserver?.observe(frameWrap);

  const core = createEditViewCore(page, {
    api: deps.api,
    opQueue: deps.opQueue,
    postToOverlay,
    loadPage: (nextPage) => {
      iframe.src = `/admin/preview/${nextPage}.html`;
    },
    onOverlayNavigated: deps.onOverlayNavigated,
    onMediaRequest: (key) => {
      openMediaDialog({ api: deps.api, win }, (value) => {
        // A fresh object literal, not `value` passed straight through: TS only
        // structurally matches a plain interface (`MediaPickValue`) against
        // `JsonValue`'s indexed-object arm when the source is a literal, not a
        // named type without its own index signature (same reasoning as
        // themePanel.ts's `commitSpec`).
        postToOverlay({
          wx: 1,
          type: "applyOps",
          ops: value !== null ? [{ file: core.currentPage, path: key, value: { src: value.src, alt: value.alt } }] : [],
        });
      });
    },
  });

  const messageListener = (event: MessageEvent): void => {
    if (event.origin !== win.location.origin) return;
    // The core parses/validates again on its side; this pre-check only picks
    // out `ready` for the deps callback (a malformed payload yields no
    // callback, which is correct).
    if (parseOverlayToShellMessage(event.data)?.type === "ready") deps.onOverlayReady?.();
    core.handleMessage(event.data);
  };
  win.addEventListener("message", messageListener);

  iframe.src = `/admin/preview/${page}.html`;
  // First device follows the user's own form factor (decisions/00084): phone →
  // mobile, tablet → tablet, desktop → desktop. matchMedia is capability-guarded
  // the same way deps.win's other optional surfaces are.
  const coarsePointer =
    typeof win.matchMedia === "function" ? win.matchMedia("(pointer: coarse)").matches : false;
  setDevice(initialDeviceFor(win.innerWidth, coarsePointer));

  return {
    element: root,
    setPage: (nextPage) => core.setPage(nextPage),
    applyOps: (ops) => postToOverlay({ wx: 1, type: "applyOps", ops }),
    postMessage: (message) => postToOverlay(message),
    teardown(): void {
      win.removeEventListener("message", messageListener);
      resizeObserver?.disconnect();
      // The toolbar may live in the shell's pinned host (toolbarHost) rather
      // than inside this view's root — remove it from either parent or a
      // stale bar lingers on the next route (decisions/00082).
      toolbar.remove();
    },
  };
}
