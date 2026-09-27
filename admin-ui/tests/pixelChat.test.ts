import { describe, expect, it, vi } from "vitest";
import {
  buildTrajectoryPlan,
  createSyntheticBlocks,
  extractBubbleRects,
  getSpriteMatrix,
  mountIdleWatchdog,
  mountPixelChat,
  DEFAULT_IDLE_TIMEOUT_MS,
  drawPixelMatrix,
  drawCoupleCuddle,
  drawCoupleEmbrace,
  drawPixelPlatform,
  GUY_PALETTE,
} from "../src/pixelChat";
import type { SceneController } from "../src/pixelChat/scene";

describe("Pixel Art Sprites", () => {
  it("returns distinct sprite matrices for all guy animation states", () => {
    const states = ["walk_top", "climb_up", "hang_traverse", "crawl", "jump", "embrace", "cuddle", "scamper"] as const;
    for (const state of states) {
      const frame0 = getSpriteMatrix("guy", state, 0);
      const frame1 = getSpriteMatrix("guy", state, 1);
      expect(frame0.length).toBeGreaterThan(0);
      expect(frame1.length).toBeGreaterThan(0);
    }
  });

  it("returns distinct sprite matrices for all woman animation states", () => {
    const states = ["walk_top", "climb_down", "hang_traverse", "crawl", "jump", "embrace", "cuddle", "scamper"] as const;
    for (const state of states) {
      const frame0 = getSpriteMatrix("woman", state, 0);
      const frame1 = getSpriteMatrix("woman", state, 1);
      expect(frame0.length).toBeGreaterThan(0);
      expect(frame1.length).toBeGreaterThan(0);
    }
  });

  it("drawPixelMatrix safely handles drawing without errors", () => {
    const mockCtx = {
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      scale: vi.fn(),
      fillRect: vi.fn(),
      globalAlpha: 1.0,
      fillStyle: "",
    } as unknown as CanvasRenderingContext2D;

    const matrix = [".PP.", "PPPP", ".PP."];
    drawPixelMatrix(mockCtx, matrix, GUY_PALETTE, 10, 20, 2);

    expect(mockCtx.save).toHaveBeenCalled();
    expect(mockCtx.restore).toHaveBeenCalled();
    expect(mockCtx.fillRect).toHaveBeenCalled();
  });

  it("draws couple embrace, cuddle, and platform without errors", () => {
    const mockCtx = {
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      scale: vi.fn(),
      fillRect: vi.fn(),
      globalAlpha: 1.0,
      fillStyle: "",
    } as unknown as CanvasRenderingContext2D;

    drawCoupleEmbrace(mockCtx, 10, 10, 2);
    drawCoupleCuddle(mockCtx, 20, 20, 2);
    drawPixelPlatform(mockCtx, 30, 30, 100, 14, 2);

    expect(mockCtx.fillRect).toHaveBeenCalled();
  });
});

describe("Pathfinder & Trajectory Planner", () => {
  it("creates synthetic blocks when container has no bubbles", () => {
    const blocks = createSyntheticBlocks(600, 800);
    expect(blocks.length).toBe(4);
    // Blocks sorted top-to-bottom
    expect(blocks[0]!.y).toBeLessThan(blocks[1]!.y);
    expect(blocks[1]!.y).toBeLessThan(blocks[2]!.y);
  });

  it("builds trajectory plan identifying overhangs for crawl traversal", () => {
    const synthetic = [
      { x: 260, y: 50, width: 240, height: 50 },  // 0 (top)
      { x: 160, y: 150, width: 340, height: 50 }, // 1 (overhang for woman descending)
      { x: 180, y: 250, width: 320, height: 50 }, // 2 (meeting block)
      { x: 280, y: 350, width: 220, height: 50 }, // 3 (overhang above: block 2 sticks out further left than block 3)
      { x: 200, y: 450, width: 300, height: 50 }, // 4 (bottom)
    ];

    const plan = buildTrajectoryPlan(600, 600, synthetic);

    expect(plan.guyWaypoints.length).toBeGreaterThan(4);
    expect(plan.womanWaypoints.length).toBeGreaterThan(4);
    expect(plan.platformRect.width).toBeGreaterThan(0);

    // Guy path must contain crawl state when navigating under overhangs
    const guyHasCrawl = plan.guyWaypoints.some((w) => w.state === "crawl");
    expect(guyHasCrawl).toBe(true);

    // Guy path must contain climb_up state
    const guyHasClimb = plan.guyWaypoints.some((w) => w.state === "climb_up");
    expect(guyHasClimb).toBe(true);

    // Woman path must contain crawl or climb_down state
    const womanHasClimb = plan.womanWaypoints.some((w) => w.state === "climb_down");
    expect(womanHasClimb).toBe(true);
  });

  it("extracts bubble rects from DOM elements", () => {
    const thread = document.createElement("div");
    const b1 = document.createElement("div");
    b1.className = "wx-chat-bubble wx-chat-bubble-assistant";
    const b2 = document.createElement("div");
    b2.className = "wx-chat-bubble wx-chat-bubble-user";
    thread.append(b1, b2);

    const rects = extractBubbleRects(thread);
    expect(Array.isArray(rects)).toBe(true);
  });
});

describe("Idle Watchdog", () => {
  it("arms 30s timer and triggers scene start on expiration", () => {
    vi.useFakeTimers();

    const container = document.createElement("div");
    let started = false;
    let stopped = false;
    let dismissed = false;

    const fakeScene: SceneController = {
      start: () => { started = true; },
      stop: () => { stopped = true; },
      dismiss: (cb) => { dismissed = true; cb?.(); },
      interrupt: () => {},
      reset: () => {},
      isRunning: () => started && !stopped,
      setSpeed: () => {},
    };

    const controller = mountIdleWatchdog(container, fakeScene, {
      idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
    });

    expect(started).toBe(false);
    expect(controller.getTimeUntilIdleMs()).toBeGreaterThan(0);

    // Advance 29s — still waiting
    vi.advanceTimersByTime(29_000);
    expect(started).toBe(false);

    // Advance 2s more — 31s total, triggers start!
    vi.advanceTimersByTime(2_000);
    expect(started).toBe(true);

    controller.teardown();
    vi.useRealTimers();
  });

  it("resets and dismisses scene on user activity", () => {
    vi.useFakeTimers();

    const container = document.createElement("div");
    let isRunning = false;
    let dismissed = false;

    const fakeScene: SceneController = {
      start: () => { isRunning = true; },
      stop: () => { isRunning = false; },
      dismiss: (cb) => { dismissed = true; isRunning = false; cb?.(); },
      interrupt: () => { dismissed = true; isRunning = false; },
      reset: () => { isRunning = false; },
      isRunning: () => isRunning,
      setSpeed: () => {},
    };

    const controller = mountIdleWatchdog(container, fakeScene, {
      idleTimeoutMs: 10_000,
    });

    // Fire timer
    vi.advanceTimersByTime(11_000);
    expect(isRunning).toBe(true);

    // User moves mouse
    container.dispatchEvent(new MouseEvent("mousemove"));

    expect(dismissed).toBe(true);
    expect(controller.getTimeUntilIdleMs()).toBeGreaterThan(9_000);

    controller.teardown();
    vi.useRealTimers();
  });

  it("calls interrupt when onIncomingMessage is received", () => {
    let interruptedReason: string | undefined = undefined;
    let running = true;

    const fakeScene: SceneController = {
      start: () => { running = true; },
      stop: () => { running = false; },
      dismiss: () => {},
      interrupt: (reason) => { interruptedReason = reason; },
      reset: () => {},
      isRunning: () => running,
      setSpeed: () => {},
    };

    const container = document.createElement("div");
    const controller = mountIdleWatchdog(container, fakeScene);

    controller.onIncomingMessage();
    expect(interruptedReason).toBe("message");

    controller.teardown();
  });

  it("triggerNow starts scene immediately", () => {
    const container = document.createElement("div");
    let started = false;

    const fakeScene: SceneController = {
      start: () => { started = true; },
      stop: () => {},
      dismiss: () => {},
      interrupt: () => {},
      reset: () => {},
      isRunning: () => false,
      setSpeed: () => {},
    };

    const controller = mountIdleWatchdog(container, fakeScene);
    controller.triggerNow();

    expect(started).toBe(true);
    controller.teardown();
  });

  it("mountPixelChat mounts onto a DOM container and tears down cleanly", () => {
    const container = document.createElement("div");
    const controller = mountPixelChat(container);

    expect(controller).toBeDefined();
    expect(typeof controller.triggerNow).toBe("function");
    expect(typeof controller.interrupt).toBe("function");
    expect(typeof controller.onIncomingMessage).toBe("function");
    expect(typeof controller.teardown).toBe("function");

    controller.teardown();
  });

  it("provides stumble and slide_fall sprite matrices for characters", () => {
    const guyStumble = getSpriteMatrix("guy", "stumble", 0);
    expect(guyStumble.length).toBeGreaterThan(10);

    const womanStumble = getSpriteMatrix("woman", "stumble", 0);
    expect(womanStumble.length).toBeGreaterThan(10);

    const guySlide = getSpriteMatrix("guy", "slide_fall", 0);
    expect(guySlide.length).toBeGreaterThan(10);
  });
});
