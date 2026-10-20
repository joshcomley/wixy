// The good-night scene's wiring API for `thread.ts` (spec/server-chat/goodnight-scene.md).
//
// thread.ts reports every live message (an arrival over the stream, or this device's own send once
// the server confirms it); this decides WHETHER it fires: the sender is one of GOODNIGHT_SENDERS,
// the text says good night, the message is fresh (not a reconnect catch-up), the tab is out of its
// cool-down, and no scene or starfield is already up. So the scene plays on her screen as she sends
// it and on the other person's as it arrives - never for anyone else's good night (operator
// decision #1919). Purely local - nothing is sent.

import { isGoodNight } from "./match";
import { startScene, type SceneDeps, type SceneHandle } from "./scene";

export { isGoodNight } from "./match";
export type { SceneHandle } from "./scene";

/** The chat display names whose good night plays the scene (matched trimmed, case-insensitively). */
export const GOODNIGHT_SENDERS: readonly string[] = ["bubble"];

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

export interface GoodnightMessage {
  /** The sender's display name, as on `Message.sender`. */
  readonly sender: string;
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
  /** A live message: an arrival over the stream, or this device's own confirmed send. Returns
   * whether a scene started. */
  noteMessage(message: GoodnightMessage): boolean;
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
    noteMessage(message: GoodnightMessage): boolean {
      if (!GOODNIGHT_SENDERS.includes(message.sender.trim().toLowerCase())) return false;
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
