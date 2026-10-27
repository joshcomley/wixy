// A recording stand-in for CanvasRenderingContext2D (jsdom has no canvas): every method call is logged
// as `[name, ...args]`, property writes are remembered, gradients are inert objects and `measureText`
// answers 7 px a character. Enough to drive the globe renderer and the trail without a browser.

export interface Recording {
  readonly ctx: CanvasRenderingContext2D;
  readonly calls: Array<[string, ...unknown[]]>;
  readonly props: Record<string, unknown>;
  count(name: string): number;
  clear(): void;
}

export function recordingContext(): Recording {
  const calls: Array<[string, ...unknown[]]> = [];
  const props: Record<string, unknown> = {};
  const gradient = { addColorStop() {} };
  const handler: ProxyHandler<object> = {
    get(_target, key) {
      if (typeof key !== "string") return undefined;
      if (key in props) return props[key];
      if (key === "measureText") {
        return (text: string) => {
          calls.push(["measureText", text]);
          return { width: text.length * 7 };
        };
      }
      if (key === "createLinearGradient" || key === "createRadialGradient") {
        return (...args: unknown[]) => {
          calls.push([key, ...args]);
          return gradient;
        };
      }
      return (...args: unknown[]) => {
        calls.push([key, ...args]);
      };
    },
    set(_target, key, value) {
      if (typeof key === "string") props[key] = value;
      return true;
    },
  };
  const ctx = new Proxy({}, handler) as unknown as CanvasRenderingContext2D;
  return {
    ctx,
    calls,
    props,
    count: (name) => calls.filter((c) => c[0] === name).length,
    clear: () => {
      calls.length = 0;
    },
  };
}

/** A canvas whose `getContext("2d")` hands back `recording.ctx` (or null). */
export function canvasWith(recording: Recording | null): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.getContext = ((kind: string) => (kind === "2d" && recording !== null ? recording.ctx : null)) as typeof canvas.getContext;
  return canvas;
}
