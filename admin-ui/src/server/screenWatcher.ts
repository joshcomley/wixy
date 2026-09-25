// The one real way to tell a SCREEN LOCK from a tab switch (spec/server-chat/
// 03-permanent-unlock.md §8): the Idle Detection API's `screenState`. Both a tab switch and
// a screen lock fire the same `visibilitychange → hidden`; only Chromium's `IdleDetector`
// (desktop and Android, never Safari or Firefox) reports `screenState: "locked"`. It needs a
// one-time permission requested from a user tap, and `threshold >= 60000` — the threshold
// only governs `userState`, and this module reads `screenState` alone.
//
// This module only reports what the browser says. It never decides anything: `panel.ts`
// owns every lock decision, and treats "the detector said nothing" as ambiguous, never as
// proof that nothing happened.

import { IDLE_DETECTOR_THRESHOLD_MS } from "./constants";

export type ScreenWatchStatus = "unsupported" | "prompt" | "granted" | "denied";

interface IdleDetectorLike extends EventTarget {
  readonly screenState: "locked" | "unlocked" | null;
  start(options: { threshold: number; signal?: AbortSignal }): Promise<void>;
}

interface IdleDetectorConstructorLike {
  new (): IdleDetectorLike;
  requestPermission(): Promise<"granted" | "denied">;
}

interface PermissionStatusLike extends EventTarget {
  readonly state: PermissionState;
}

export interface ScreenWatcher {
  /** Whether this browser has an `IdleDetector` at all. */
  readonly supported: boolean;
  /** True while a detector is started and reporting. */
  readonly running: boolean;
  /** Reads the permission WITHOUT prompting. */
  status(): Promise<ScreenWatchStatus>;
  /** Shows the browser's permission prompt. Must run inside a user gesture (a tap). */
  requestPermission(): Promise<ScreenWatchStatus>;
  /** Starts reporting if — and only if — permission is already granted. `onScreenLocked`
   * fires each time the screen reports "locked"; `onLost` fires when the permission is
   * revoked or the detector stops for any reason. Resolves whether it is now running. */
  start(onScreenLocked: () => void, onLost: () => void): Promise<boolean>;
  stop(): void;
}

function detectorConstructor(win: Window): IdleDetectorConstructorLike | null {
  const candidate = (win as unknown as { IdleDetector?: unknown }).IdleDetector;
  return typeof candidate === "function" ? (candidate as IdleDetectorConstructorLike) : null;
}

async function queryPermission(win: Window): Promise<PermissionStatusLike | null> {
  const permissions = win.navigator.permissions as Permissions | undefined;
  if (permissions === undefined || typeof permissions.query !== "function") return null;
  try {
    return await permissions.query({ name: "idle-detection" as PermissionName });
  } catch {
    return null;
  }
}

export function createScreenWatcher(win: Window): ScreenWatcher {
  const ctor = detectorConstructor(win);
  let controller: AbortController | null = null;
  let permissionStatus: PermissionStatusLike | null = null;
  let permissionListener: (() => void) | null = null;
  let running = false;
  /** Bumped by every `start`/`stop`, so a slow start that finishes after a stop stays stopped. */
  let generation = 0;

  async function status(): Promise<ScreenWatchStatus> {
    if (ctor === null) return "unsupported";
    const permission = await queryPermission(win);
    // A browser that ships `IdleDetector` but no `permissions.query` support for it: the
    // only way to learn is to ask, so report "prompt" and let `requestPermission` decide.
    if (permission === null) return "prompt";
    return permission.state;
  }

  async function requestPermission(): Promise<ScreenWatchStatus> {
    if (ctor === null) return "unsupported";
    try {
      const result = await ctor.requestPermission();
      return result === "granted" ? "granted" : "denied";
    } catch {
      return "denied";
    }
  }

  function release(): void {
    generation += 1;
    running = false;
    if (controller !== null) {
      controller.abort();
      controller = null;
    }
    if (permissionStatus !== null && permissionListener !== null) {
      permissionStatus.removeEventListener("change", permissionListener);
    }
    permissionStatus = null;
    permissionListener = null;
  }

  async function start(onScreenLocked: () => void, onLost: () => void): Promise<boolean> {
    release();
    const myGeneration = generation;
    if (ctor === null) return false;
    const permission = await queryPermission(win);
    if (myGeneration !== generation) return false;
    if (permission === null || permission.state !== "granted") return false;

    const detector = new ctor();
    const abort = new AbortController();
    controller = abort;
    permissionStatus = permission;
    permissionListener = () => {
      if (myGeneration !== generation || permission.state === "granted") return;
      release();
      onLost();
    };
    permission.addEventListener("change", permissionListener);
    detector.addEventListener("change", () => {
      if (myGeneration !== generation) return;
      if (detector.screenState === "locked") onScreenLocked();
    });
    try {
      await detector.start({ threshold: IDLE_DETECTOR_THRESHOLD_MS, signal: abort.signal });
    } catch {
      if (myGeneration === generation) {
        release();
        onLost();
      }
      return false;
    }
    if (myGeneration !== generation) return false;
    running = true;
    return true;
  }

  return {
    supported: ctor !== null,
    get running(): boolean {
      return running;
    },
    status,
    requestPermission,
    start,
    stop: release,
  };
}
