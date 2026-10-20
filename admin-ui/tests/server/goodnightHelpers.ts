// Test doubles for the good-night scene: jsdom has no 2D canvas, so getContext is stubbed with a
// recording fake, and the scene gets a fake window with a manually stepped rAF.

import { vi } from "vitest";

export interface FakeContext {
  imageSmoothingEnabled: boolean;
  fillStyle: string;
  clearRect: ReturnType<typeof vi.fn>;
  fillRect: ReturnType<typeof vi.fn>;
  drawImage: ReturnType<typeof vi.fn>;
  createImageData: ReturnType<typeof vi.fn>;
  putImageData: ReturnType<typeof vi.fn>;
}

export interface CanvasStub {
  /** The context handed to the scene's visible canvas (the first one created after install). */
  readonly contexts: FakeContext[];
  readonly restore: () => void;
}

/** Replace HTMLCanvasElement.prototype.getContext with a recording fake. */
export function stubCanvas(): CanvasStub {
  const original = HTMLCanvasElement.prototype.getContext;
  const contexts: FakeContext[] = [];
  HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement) {
    const ctx: FakeContext = {
      imageSmoothingEnabled: true,
      fillStyle: "",
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      drawImage: vi.fn(),
      createImageData: vi.fn((w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h })),
      putImageData: vi.fn(),
    };
    contexts.push(ctx);
    return ctx as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  return {
    contexts,
    restore: () => {
      HTMLCanvasElement.prototype.getContext = original;
    },
  };
}

export interface FakeWin {
  readonly win: Window;
  /** Run the pending animation frame callbacks once. */
  step(): void;
  pendingFrames(): number;
  listenerCount(): number;
  fire(type: string): void;
  innerWidth: number;
  innerHeight: number;
}

export function fakeWin(opts: { reducedMotion?: boolean; width?: number; height?: number } = {}): FakeWin {
  let nextId = 1;
  const frames = new Map<number, () => void>();
  const listeners = new Map<string, Set<() => void>>();
  const state = { innerWidth: opts.width ?? 360, innerHeight: opts.height ?? 640 };
  const win = {
    get innerWidth() {
      return state.innerWidth;
    },
    get innerHeight() {
      return state.innerHeight;
    },
    matchMedia: (query: string) => ({ matches: opts.reducedMotion === true && query.includes("reduce") }),
    requestAnimationFrame: (cb: () => void) => {
      const id = nextId++;
      frames.set(id, cb);
      return id;
    },
    cancelAnimationFrame: (id: number) => {
      frames.delete(id);
    },
    addEventListener: (type: string, fn: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: () => void) => {
      listeners.get(type)?.delete(fn);
    },
  };
  return {
    win: win as unknown as Window,
    step() {
      const pending = [...frames.entries()];
      frames.clear();
      for (const [, cb] of pending) cb();
    },
    pendingFrames: () => frames.size,
    listenerCount: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
    fire(type) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn();
    },
    get innerWidth() {
      return state.innerWidth;
    },
    set innerWidth(v: number) {
      state.innerWidth = v;
    },
    get innerHeight() {
      return state.innerHeight;
    },
    set innerHeight(v: number) {
      state.innerHeight = v;
    },
  };
}

/** Listeners of one type still registered on `doc` (adds minus removes), calling through. */
export function trackDocumentListeners(doc: Document, type: string): { live(): number; restore(): void } {
  const add = vi.spyOn(doc, "addEventListener");
  const remove = vi.spyOn(doc, "removeEventListener");
  const count = (calls: readonly (readonly unknown[])[]): number => calls.filter((c) => c[0] === type).length;
  return {
    live: () => count(add.mock.calls) - count(remove.mock.calls),
    restore: () => {
      add.mockRestore();
      remove.mockRestore();
    },
  };
}
