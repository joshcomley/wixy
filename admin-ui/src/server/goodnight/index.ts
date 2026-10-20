// The good-night scene's wiring API for `thread.ts` (spec/server-chat/goodnight-scene.md).
//
// thread.ts decides WHO sent it (a live arrival from the other person); this decides WHETHER it
// fires: the text says good night, the message is fresh (not a reconnect catch-up), the tab is
// out of its cool-down, and no scene or starfield is already up. Purely local - nothing is sent.

import { isGoodNight } from "./match";
import { startScene, type SceneDeps, type SceneHandle } from "./scene";

export { isGoodNight } from "./match";
export type { SceneHandle } from "./scene";

/** Ignore a message older than this by `createdAt` (a reconnect replaying the backlog). */
export const MAX_MESSAGE_AGE_MS = 120_000;
/** At most one scene per this long, per tab. */
export const COOLDOWN_MS = 10 * 60_000;

// Module scope = per tab (every page load is a fresh module).
let lastFiredAt: number | null = null;

/** Test hook: forget the tab's cool-down. */
export function resetGoodnightCooldown(): void {
  lastFiredAt = null;
}

export interface GoodnightArrival {
  readonly text: string | null;
  /** Epoch SECONDS, as on `Message.createdAt`. */
  readonly createdAt: number;
}

export interface GoodnightDeps extends Omit<SceneDeps, "now"> {
  /** Milliseconds clock (default `Date.now`). */
  readonly now?: () => number;
  /** Test seam. */
  readonly start?: (deps: SceneDeps) => SceneHandle;
}

export interface GoodnightController {
  /** The caller has already established this is a live arrival from the other person. Returns
   * whether a scene started. */
  noteArrival(message: GoodnightArrival): boolean;
  /** Remove the scene / starfield (lock, detach, wipe, teardown). Idempotent. */
  stop(): void;
}

export function createGoodnightController(deps: GoodnightDeps): GoodnightController {
  const now = deps.now ?? (() => Date.now());
  const start = deps.start ?? startScene;
  let scene: SceneHandle | null = null;

  function live(): boolean {
    if (scene !== null && scene.phase === "closed") scene = null;
    return scene !== null;
  }

  return {
    noteArrival(message: GoodnightArrival): boolean {
      if (!isGoodNight(message.text)) return false;
      const t = now();
      if (t - message.createdAt * 1000 > MAX_MESSAGE_AGE_MS) return false;
      if (lastFiredAt !== null && t - lastFiredAt < COOLDOWN_MS) return false;
      if (live()) return false;
      const { start: _start, ...sceneDeps } = deps;
      scene = start({ ...sceneDeps, now });
      lastFiredAt = t;
      return true;
    },
    stop(): void {
      scene?.close();
      scene = null;
    },
  };
}
