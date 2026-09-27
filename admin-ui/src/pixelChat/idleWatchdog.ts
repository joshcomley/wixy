// Idle watchdog for pixel chat animation
// Tracks user activity in the chat view; triggers the scene after 30s of inactivity.
// Immediately dismisses the animation when the user moves, scrolls, or types.

import type { SceneController } from "./scene";
import type { PixelChatController, PixelChatOptions } from "./types";

export const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

export function mountIdleWatchdog(
  containerEl: HTMLElement,
  scene: SceneController,
  options?: PixelChatOptions,
): PixelChatController {
  const win = options?.win ?? containerEl.ownerDocument.defaultView ?? window;
  const timeoutMs = options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const setTimeoutFn = typeof win?.setTimeout === "function" ? win.setTimeout.bind(win) : globalThis.setTimeout;
  const clearTimeoutFn = typeof win?.clearTimeout === "function" ? win.clearTimeout.bind(win) : globalThis.clearTimeout;

  let idleTimer: number | null = null;
  let lastActivityAt = Date.now();
  let teardownCalled = false;

  function onActivity(): void {
    if (teardownCalled) return;
    lastActivityAt = Date.now();

    if (scene.isRunning()) {
      scene.dismiss();
    }
    armTimer();
  }

  function armTimer(): void {
    if (idleTimer !== null) {
      clearTimeoutFn(idleTimer);
      idleTimer = null;
    }
    if (teardownCalled) return;

    idleTimer = setTimeoutFn(() => {
      if (teardownCalled) return;
      scene.start();
    }, timeoutMs) as unknown as number;
  }

  // Event handlers
  const activityEvents = ["mousemove", "mousedown", "keydown", "touchstart", "wheel"] as const;
  const onEvent = () => onActivity();

  for (const evt of activityEvents) {
    containerEl.addEventListener(evt, onEvent, { passive: true });
  }

  // Listen to scroll events on container
  containerEl.addEventListener("scroll", onEvent, { passive: true });

  // Start initial timer
  if (options?.debugAlwaysActive) {
    scene.start();
  } else {
    armTimer();
  }

  return {
    triggerNow(): void {
      if (scene.isRunning()) {
        scene.reset();
      }
      scene.start();
    },
    reset(): void {
      scene.reset();
      onActivity();
    },
    isAnimating(): boolean {
      return scene.isRunning();
    },
    getTimeUntilIdleMs(): number {
      const elapsed = Date.now() - lastActivityAt;
      return Math.max(0, timeoutMs - elapsed);
    },
    teardown(): void {
      teardownCalled = true;
      if (idleTimer !== null) {
        clearTimeoutFn(idleTimer);
        idleTimer = null;
      }
      for (const evt of activityEvents) {
        containerEl.removeEventListener(evt, onEvent);
      }
      containerEl.removeEventListener("scroll", onEvent);
      scene.stop();
      scene.reset();
    },
  };
}
