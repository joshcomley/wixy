// Tuning constants for the "Server" panel's lock/disguise state machine
// (spec/server-chat/00-brief.md §6). Every value here is quoted verbatim by
// the frozen brief — do not retune without going back through the Architect.

/** R6/R7: 10s with no qualifying activity (and no active suspension) locks.
 * This is the normal idle period AND the fixed one for the decoy's "Open
 * server settings" re-hide and the PIN pad's idle close, which share the same
 * timer but are never affected by the auto-lock checkbox. */
export const IDLE_LOCK_MS = 10_000;

/** The unlocked chat's idle period on a device whose owner ticked "Extend
 * auto-lock to 1 minute" (`idlePreference.ts`). Lives ONLY here — `lockModel`
 * receives the chosen duration as an input and never holds a second copy. */
export const IDLE_LOCK_EXTENDED_MS = 60_000;

/** R6: the chat text fades out over this long before the panel actually
 * detaches and falls back to the decoy — any activity during the fade
 * cancels it and restores the chat instantly (R7). */
export const FADE_MS = 800;

/** R3: two taps at most this many ms apart, INSIDE the chat view, count as
 * one "multi-tap" and lock instantly. Also reused by R2 v1.3 (operator
 * decision #974) as the decoy's reveal-affordance debounce window: a tap on
 * "Open server settings" within this long of the single tap that revealed it
 * is ignored, so a single accidental rapid double-tap on the decoy can never
 * reveal-and-open in one motion. Two different meanings, same window, by the
 * Architect's own design — see `lockModel.ts`'s and `panel.ts`'s own notes. */
export const MULTI_TAP_INTERVAL_MS = 400;

/** R3: the number of taps within MULTI_TAP_INTERVAL_MS, inside the chat
 * view, that counts as a "multi-tap" and locks. Multi-tap has NO meaning on
 * the decoy (R2 v1.3) — reaching it there reveals nothing itself; see
 * `lockModel.ts`'s decoy/revealed states, which react to a single `"tap"`
 * event instead. */
export const MULTI_TAP_COUNT = 2;

/** R3 v1.7 (operator report, round 2: two unrelated taps — a scroll flick, or two different
 * menu items tapped quickly — were locking the chat). Each LATER tap in a multi-tap run must
 * land within this many CSS px of the run's FIRST tap — about 5mm on a phone, comfortably
 * covering finger wobble on a genuine same-spot double-tap while rejecting a tap a finger-width
 * away. Anchored to the first tap (never "the previous tap"), so a run cannot walk across the
 * screen. */
export const MULTI_TAP_RADIUS_PX = 32;

/** R3 v1.7: how far a pointer may move between its `pointerdown` and `pointerup` and still count
 * as one TAP (not a drag or a scroll's initial flick). Matches `messageActions.ts`'s own
 * `LONG_PRESS_MOVE_PX` — the same slop this codebase already uses for "did the finger move". */
export const TAP_SLOP_PX = 10;

/** R3 v1.7: how long a `pointerdown`→`pointerup` pair may span and still count as one TAP.
 * Comfortably below `messageActions.ts`'s `LONG_PRESS_MS` (500ms, opens the action sheet), so a
 * long-press is never also read as a tap. */
export const TAP_MAX_MS = 300;

/** R7: the file-picker suspension's safety cap — a picker left open (dialog
 * abandoned, app backgrounded) can't suspend the idle timer forever. */
export const PICKER_SUSPEND_MAX_MS = 300_000;
