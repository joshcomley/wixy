// Two (or more) devices, kept awake from BEFORE the first unlock.
//
// The Server chat idle-locks a device that has had no activity for 10 s (R7), in every state: the unlocked chat, the
// revealed "Open server settings" button and the PIN pad. A spec that unlocks device A and then device B, and only
// afterwards starts its keep-awake, leaves A untouched for as long as B's unlock takes. On a loaded box that is
// longer than 10 s, A is back on the decoy, and the next step waits for an element that is gone (five specs failed
// this way: server-drawing, server-cookout-twists, server-goodnight, server-chat long-press, server-adventure Nay).
//
// So every spec that unlocks more than one device unlocks them through `unlockTogether`, which starts the keep-awake
// first. The keep-awake is a `Shift` key press on every page every 2 s: a key press counts as activity and, unlike a
// mouse move, cannot disturb a hover or click another call is making on the same page. It stops by itself when any of
// its pages closes (which is what `context.close()` does), so a test needs no cleanup; `stop` is for tests that want to
// end it earlier. Proven deterministically by `two-devices.spec.ts` (an 11 s stall before the second unlock).

import type { Page } from "@playwright/test";

/** How often each page gets a key press; well inside the 10 s idle lock. */
export const KEEP_AWAKE_EVERY_MS = 2_000;

/** Keeps every page awake until `stop()` or until any of them closes. */
export function keepPagesAwake(pages: readonly Page[]): () => void {
  let stopped = false;
  const timer = setInterval(() => {
    for (const page of pages) void page.keyboard.press("Shift").catch(() => undefined);
  }, KEEP_AWAKE_EVERY_MS);
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
  for (const page of pages) page.once("close", stop);
  return stop;
}

/** Unlocks each `[page, name]` in order, with every page already being kept awake. Returns the keep-awake's stop.
 *
 * `keepAwakeAfter: false` is for a test that asserts the idle lock itself (a ring pauses it, a frozen page locks at
 * once): the keep-awake then covers only the unlock phase, which is the window that stalls under load, and stops
 * before the test's own idle countdown begins. */
export async function unlockTogether(
  unlock: (page: Page, name: string) => Promise<void>,
  devices: ReadonlyArray<readonly [Page, string]>,
  options: { readonly keepAwakeAfter?: boolean } = {},
): Promise<() => void> {
  const stop = keepPagesAwake(devices.map(([page]) => page));
  try {
    for (const [page, name] of devices) await unlock(page, name);
  } catch (error) {
    stop();
    throw error;
  }
  if (options.keepAwakeAfter === false) stop();
  return stop;
}
