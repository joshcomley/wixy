// Shared test double for window.visualViewport (jsdom doesn't implement one).
// Lets tests simulate the two mobile-only viewport states that break fixed
// bottom chrome: the on-screen keyboard shrinking the VISUAL viewport below
// the layout viewport, and pinch-zoom panning it (offsetTop/offsetLeft).

/** The real VisualViewport's geometry fields are readonly; the fake must let
 * tests mutate them mid-scenario, so they're dropped via Omit and redeclared
 * mutable. */
export type FakeVisualViewport = Omit<VisualViewport, "height" | "offsetLeft" | "offsetTop" | "width"> & {
  width: number;
  height: number;
  offsetTop: number;
  offsetLeft: number;
  /** Deliver an event ("resize" | "scroll") to registered listeners. */
  fire: (type: string) => void;
};

export function installFakeVisualViewport(init: {
  width: number;
  height: number;
  offsetTop?: number;
  offsetLeft?: number;
}): FakeVisualViewport {
  const listeners = new Map<string, Set<EventListener>>();
  const vv = {
    width: init.width,
    height: init.height,
    offsetTop: init.offsetTop ?? 0,
    offsetLeft: init.offsetLeft ?? 0,
    scale: 1,
    pageTop: 0,
    pageLeft: 0,
    onresize: null,
    onscroll: null,
    addEventListener: (type: string, listener: EventListener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(listener);
    },
    removeEventListener: (type: string, listener: EventListener) => {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent: () => true,
    fire: (type: string) => {
      listeners.get(type)?.forEach((listener) => listener(new Event(type)));
    },
  };
  Object.defineProperty(window, "visualViewport", {
    value: vv,
    configurable: true,
    writable: true,
  });
  return vv as unknown as FakeVisualViewport;
}

/** Restore jsdom's default (no visualViewport) between tests. */
export function uninstallFakeVisualViewport(): void {
  Object.defineProperty(window, "visualViewport", {
    value: undefined,
    configurable: true,
    writable: true,
  });
}
