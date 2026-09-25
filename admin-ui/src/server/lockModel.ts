// The "Server" panel's lock state machine — a PURE reducer (§6's diagram),
// the single most safety-critical piece of this feature: every path that
// ends anywhere other than "decoy" must be reachable only through a
// deliberate, correct unlock. `panel.ts` is the only caller — it owns every
// timer (idle/fade), the gesture detector, and the network calls; this
// module just decides what state comes next and what the driver must DO
// about it (`effects`), so the transition table itself is exhaustively
// testable with no DOM, no timers, no network.
//
// Design note on "tap" vs "multiTap": R2 v1.3 (operator decision #974,
// overriding the brief's original R2 text) made these two SEPARATE
// gestures with no shared meaning. A single qualifying tap ANYWHERE inside
// the panel reveals the affordance from "decoy"; a multi-tap only ever
// means anything from "chat"/"fading" (R3, unchanged). `gestures.ts` emits
// them from two independently-attached detectors — see its own file
// comment — so this reducer never needs to reconcile one gesture meaning
// two things; each event already arrives pre-classified.
//
// Design note on the single `lock` event: R6 lists EIGHT lock triggers
// (10s idle, panic, a multi-tap in chat, Escape, tab hidden, routing away,
// a 401/`locked` event, and the token's `expiresAt`) and `LockCause` names
// all eight. Seven of them are instant from every state. The eighth —
// "idle" — is instant from every state EXCEPT "chat", where it goes through
// the 800ms fade first (§6's diagram: "fading(800ms) ◀── idle 10s ── chat").
// Modelling all eight as one `{type:"lock", cause}` event (rather than a
// bespoke "idle" event with its own wiring) keeps that single exception
// local to `reduceChat` instead of duplicated across every other state's
// idle handling.
//
// Design note on device grants (spec/server-chat/03-permanent-unlock.md): "Keep this device
// unlocked" is NOT a second state machine. It is one input, `LockContext.grantActive`, and
// two extra states. While a grant is active the AUTOMATIC locks that would end the chat —
// idle and routing away — are ignored from "chat"/"fading"; every deliberate lock (panic,
// multi-tap, Escape) is unchanged. The other automatic locks are decided by the driver:
// token expiry and a 401 are answered with a silent re-mint before locking, and a background
// switch is governed by the two per-device checkboxes (§8) through `hiddenPolicy` /
// `shieldOutcome` below. The extra states are "granting" (the grant is minting this visit's
// first token; nothing is shown) and "shielded" (a background switch whose cause is not yet
// known: the decoy is up and the chat is detached, but the in-memory session is kept so a
// cause that turns out harmless can restore it).

import { IDLE_LOCK_MS, SCREEN_LOCK_EVIDENCE_AFTER_MS, SCREEN_LOCK_EVIDENCE_BEFORE_MS } from "./constants";
import type { LockCause } from "./types";

export type PinError =
  | { readonly kind: "wrong"; readonly attemptsLeft: number | null }
  | { readonly kind: "lockedOut"; readonly retryAfterS: number }
  | { readonly kind: "pinChanged" }
  | { readonly kind: "invalid" }
  | { readonly kind: "unexpected" }
  | { readonly kind: "unavailable" };

// Note: there is deliberately no "needsName" tracked here. §6's "the first
// unlock without a display name shows a name sub-step inside chat; idle
// applies there too" is the CHAT VIEW's own internal concern (it can read
// `localStorage["wx-srv-name"]` itself, R8) — the frozen `ServerChatView`
// interface (types.ts) has no hook to report a name back to this reducer,
// and "idle applies there too" just means the outer machine treats a
// name-prompt sub-view exactly like any other chat content: still "chat",
// same idle/fade/lock behaviour, nothing extra to model here.
export type LockState =
  | { readonly kind: "decoy" }
  | { readonly kind: "revealed" }
  | { readonly kind: "pin"; readonly error: PinError | null }
  | { readonly kind: "verifying" }
  | { readonly kind: "chat" }
  | { readonly kind: "fading" }
  /** A device grant is minting the first token of this visit (a mount or reload with the
   * setting on and not paused). Nothing is shown — not even the decoy — until it answers. */
  | { readonly kind: "granting" }
  /** A background switch on an open chat whose cause is not yet known (§8). Looks like the
   * decoy and has the chat detached, but the in-memory session is kept until the driver
   * resolves the cause: restore silently, or lock. */
  | { readonly kind: "shielded" };

export type LockEvent =
  /** R2 v1.3: a single qualifying tap anywhere inside the panel. Reveals the
   * affordance from "decoy"; has no other meaning (see the design note
   * above). */
  | { readonly type: "tap" }
  /** R3 (unchanged): a qualifying multi-tap (gestures.ts already debounced
   * it to one logical gesture) — locks instantly from inside the chat view.
   * Has NO meaning on the decoy any more (R2 v1.3). */
  | { readonly type: "multiTap" }
  /** The "Open server settings" affordance was tapped (`panel.ts` debounces
   * a tap landing within MULTI_TAP_INTERVAL_MS of the reveal itself before
   * ever dispatching this — R2 v1.3). */
  | { readonly type: "tapAffordance" }
  /** The PIN pad's submit (✓ / Enter). */
  | { readonly type: "submit" }
  /** The unlock call answered 200. */
  | { readonly type: "verifyOk" }
  | { readonly type: "verifyWrong"; readonly attemptsLeft: number | null }
  | { readonly type: "verifyLockedOut"; readonly retryAfterS: number }
  | { readonly type: "verifyPinChanged" }
  | { readonly type: "verifyInvalid" }
  | { readonly type: "verifyUnexpected" }
  | { readonly type: "verifyUnavailable" }
  /** An explicit Cancel on the PIN pad — distinct from `lock`: nothing was
   * ever unlocked, so there's no chat subtree to detach. */
  | { readonly type: "cancel" }
  /** A qualifying R7 activity event, while revealed/pin/chat/fading. */
  | { readonly type: "activity" }
  /** The 800ms fade timer elapsed without being cancelled. */
  | { readonly type: "fadeComplete" }
  /** The panel mounted with a device grant that is set and not paused: mint this visit's
   * token from it instead of asking for the PIN. Ignored unless `grantActive`. */
  | { readonly type: "grantUnlock" }
  /** The grant minted a token. */
  | { readonly type: "grantOk" }
  /** The grant could not open the chat (revoked, offline, rate limited): the decoy and
   * the PIN flow, exactly as if there were no grant. */
  | { readonly type: "grantFailed" }
  /** A background switch on an open chat whose cause is not known yet (§8): put the decoy
   * up, detach the chat, keep the session. Only "chat" answers it. */
  | { readonly type: "shield" }
  /** The shield resolved to a cause whose checkbox is off: bring the chat back with the
   * session it was holding. Only "shielded" answers it. */
  | { readonly type: "shieldRestore" }
  /** Any of R6's instant-lock causes — see the design note above for
   * why "idle" is included here rather than as its own event. */
  | { readonly type: "lock"; readonly cause: LockCause };

export type LockEffect =
  /** (Re)start the idle timer from now — its duration for the current state is
   * `idleTimeoutMs` (10s, or the device's chosen chat duration in "chat"). */
  | "resetIdleTimer"
  /** Stop the idle timer — nothing left to time out from. */
  | "clearIdleTimer"
  /** Start the 800ms fade-to-decoy timer. */
  | "startFadeTimer"
  /** Cancel a running fade timer. */
  | "clearFadeTimer"
  /** Detach the chat subtree per R6: `ServerChatView.detach()`, then remove
   * `element` from the document — the instance itself survives in memory. */
  | "detachChat"
  /** Move focus into the PIN pad's (hidden) input, so physical digit keys
   * work immediately. */
  | "focusPin";

export interface LockTransitionResult {
  readonly state: LockState;
  readonly effects: readonly LockEffect[];
}

/** The one input besides state and event: whether a device grant is set AND not paused. The
 * driver reads it from storage each time it dispatches. */
export interface LockContext {
  readonly grantActive: boolean;
}

export const NO_GRANT: LockContext = { grantActive: false };

export const INITIAL_STATE: LockState = { kind: "decoy" };

const NO_OP = (state: LockState): LockTransitionResult => ({ state, effects: [] });

/** The two automatic locks an active grant silences from an open chat. */
function isQuietedByGrant(cause: LockCause): boolean {
  return cause === "idle" || cause === "routeAway";
}

function reduceDecoy(state: LockState, event: LockEvent, context: LockContext): LockTransitionResult {
  if (event.type === "tap") {
    return { state: { kind: "revealed" }, effects: ["resetIdleTimer"] };
  }
  if (event.type === "grantUnlock" && context.grantActive) {
    return { state: { kind: "granting" }, effects: [] };
  }
  // Already locked — every lock cause, a stray multiTap (no meaning here
  // per R2 v1.3), and anything else, is a no-op.
  return NO_OP(state);
}

function reduceGranting(state: LockState, event: LockEvent): LockTransitionResult {
  switch (event.type) {
    case "grantOk":
      return { state: { kind: "chat" }, effects: ["resetIdleTimer"] };
    case "grantFailed":
    case "lock":
      // A lock while the grant is still answering (a route change, a 401, Escape) wins: the
      // driver drops the late answer, so nothing can resurrect the chat afterwards.
      return { state: { kind: "decoy" }, effects: [] };
    default:
      // Taps, activity and gestures do nothing while nothing is showing.
      return NO_OP(state);
  }
}

function reduceRevealed(state: LockState, event: LockEvent): LockTransitionResult {
  switch (event.type) {
    case "tapAffordance":
      return { state: { kind: "pin", error: null }, effects: ["resetIdleTimer", "focusPin"] };
    case "activity":
    case "tap": // another tap while already revealed — just activity
    case "multiTap": // no meaning here either (R2 v1.3) — just activity
      return { state, effects: ["resetIdleTimer"] };
    case "lock":
      return { state: { kind: "decoy" }, effects: ["clearIdleTimer"] };
    default:
      return NO_OP(state);
  }
}

function reducePin(state: LockState, event: LockEvent): LockTransitionResult {
  switch (event.type) {
    case "submit":
      return { state: { kind: "verifying" }, effects: ["clearIdleTimer"] };
    case "cancel":
      return { state: { kind: "decoy" }, effects: ["clearIdleTimer"] };
    case "activity":
      return { state, effects: ["resetIdleTimer"] };
    case "lock":
      // Covers Escape too (R2: "pin ... cancel/Esc/idle 10s" all land on decoy).
      return { state: { kind: "decoy" }, effects: ["clearIdleTimer"] };
    default:
      return NO_OP(state);
  }
}

function reduceVerifying(state: LockState, event: LockEvent): LockTransitionResult {
  switch (event.type) {
    case "verifyOk":
      return { state: { kind: "chat" }, effects: ["resetIdleTimer"] };
    case "verifyWrong":
      return {
        state: { kind: "pin", error: { kind: "wrong", attemptsLeft: event.attemptsLeft } },
        effects: ["resetIdleTimer", "focusPin"],
      };
    case "verifyLockedOut":
      return {
        state: { kind: "pin", error: { kind: "lockedOut", retryAfterS: event.retryAfterS } },
        effects: ["resetIdleTimer", "focusPin"],
      };
    case "verifyPinChanged":
      return { state: { kind: "pin", error: { kind: "pinChanged" } }, effects: ["resetIdleTimer", "focusPin"] };
    case "verifyInvalid":
      return { state: { kind: "pin", error: { kind: "invalid" } }, effects: ["resetIdleTimer", "focusPin"] };
    case "verifyUnexpected":
      return { state: { kind: "pin", error: { kind: "unexpected" } }, effects: ["resetIdleTimer", "focusPin"] };
    case "verifyUnavailable":
      return {
        state: { kind: "pin", error: { kind: "unavailable" } },
        effects: ["resetIdleTimer", "focusPin"],
      };
    case "lock":
      // e.g. hidden/routeAway/expired while a verify is in flight — the
      // driver is responsible for ignoring a late response against a stale
      // request once this has fired (not this reducer's concern).
      return { state: { kind: "decoy" }, effects: [] };
    default:
      return NO_OP(state);
  }
}

function reduceChat(state: LockState, event: LockEvent, context: LockContext): LockTransitionResult {
  switch (event.type) {
    case "activity":
      return { state, effects: ["resetIdleTimer"] };
    case "multiTap":
      // R3: a multi-tap anywhere inside the chat view locks instantly.
      return { state: { kind: "decoy" }, effects: ["detachChat", "clearIdleTimer"] };
    case "shield":
      // §8: a background switch whose cause is not known yet. The decoy goes up and the chat
      // is detached exactly as for a lock — the difference is only that the driver keeps the
      // session, so a harmless cause can bring the same chat back.
      return { state: { kind: "shielded" }, effects: ["detachChat", "clearIdleTimer"] };
    case "lock":
      if (context.grantActive && isQuietedByGrant(event.cause)) return NO_OP(state);
      if (event.cause === "idle") {
        // The one non-instant cause: fade first (§6's diagram).
        return { state: { kind: "fading" }, effects: ["startFadeTimer", "clearIdleTimer"] };
      }
      return { state: { kind: "decoy" }, effects: ["detachChat", "clearIdleTimer"] };
    default:
      return NO_OP(state);
  }
}

function reduceFading(state: LockState, event: LockEvent, context: LockContext): LockTransitionResult {
  switch (event.type) {
    case "activity":
      // R7: any activity while fading cancels it and restores the chat.
      return { state: { kind: "chat" }, effects: ["clearFadeTimer", "resetIdleTimer"] };
    case "fadeComplete":
      return { state: { kind: "decoy" }, effects: ["detachChat", "clearIdleTimer"] };
    case "multiTap":
      return { state: { kind: "decoy" }, effects: ["detachChat", "clearFadeTimer", "clearIdleTimer"] };
    case "lock":
      // Defensive: correct regardless of the driver's event-dispatch order
      // (see gestures.ts's own note on why a real double-tap during a fade
      // never actually reaches this branch — activity fires first and
      // restores "chat", where the SAME multiTap/lock semantics apply).
      if (context.grantActive && isQuietedByGrant(event.cause)) return NO_OP(state);
      return { state: { kind: "decoy" }, effects: ["detachChat", "clearFadeTimer", "clearIdleTimer"] };
    default:
      return NO_OP(state);
  }
}

function reduceShielded(state: LockState, event: LockEvent): LockTransitionResult {
  switch (event.type) {
    case "shieldRestore":
      return { state: { kind: "chat" }, effects: ["resetIdleTimer"] };
    case "lock":
      // Any lock while shielded — including a route change or the token expiring — drops the
      // held session (the driver discards it on every return to the decoy).
      return { state: { kind: "decoy" }, effects: ["clearIdleTimer"] };
    default:
      // A tap or activity during the (at most half-second) shield does nothing: the decoy is
      // up, and the shield resolves to the chat or to the ordinary decoy on its own.
      return NO_OP(state);
  }
}

/** `now` is accepted to match §6's frozen `(state, event, now) => {state,
 * effects[]}` signature; no branch here currently needs it (every timer is
 * driven by the caller's own clock via the `effects` it receives back) — kept
 * so a future transition can start depending on it without a signature
 * change every other module would need to follow. `context` is the one added
 * input (see `LockContext`); omitting it means "no device grant". */
export function reduce(
  state: LockState,
  event: LockEvent,
  now: number,
  context: LockContext = NO_GRANT,
): LockTransitionResult {
  void now;
  switch (state.kind) {
    case "decoy":
      return reduceDecoy(state, event, context);
    case "granting":
      return reduceGranting(state, event);
    case "revealed":
      return reduceRevealed(state, event);
    case "pin":
      return reducePin(state, event);
    case "verifying":
      return reduceVerifying(state, event);
    case "chat":
      return reduceChat(state, event, context);
    case "fading":
      return reduceFading(state, event, context);
    case "shielded":
      return reduceShielded(state, event);
  }
}

/** How long the idle timer runs while the machine sits in `state`.
 *
 * ONLY the unlocked chat (name prompt included — it is still "chat") takes
 * `idleLockMs`, the duration the UI layer chose for this device ("Extend
 * auto-lock to 1 minute" — see `idlePreference.ts`). Every other state that
 * runs the idle timer — the decoy's revealed "Open server settings" button
 * and the PIN pad — stays on the fixed `IDLE_LOCK_MS` no matter what was
 * chosen. The chosen duration is an INPUT: no second idle constant lives here. */
export function idleTimeoutMs(state: LockState, idleLockMs: number): number {
  return state.kind === "chat" ? idleLockMs : IDLE_LOCK_MS;
}

/** Milliseconds left on the idle timer: `lastActivityAtMs` + the state's idle
 * timeout − `nowMs`, floored at 0 ("the deadline has passed — lock now").
 * Measuring from the LAST ACTIVITY (not from whenever a timer happened to be
 * scheduled) is what lets a settings change apply at once without ever
 * restarting the clock — only real user activity does that. */
export function idleRemainingMs(
  state: LockState,
  idleLockMs: number,
  lastActivityAtMs: number,
  nowMs: number,
): number {
  return Math.max(0, lastActivityAtMs + idleTimeoutMs(state, idleLockMs) - nowMs);
}

// -- Which locks pause a device grant (03-permanent-unlock.md §1, §8) --------------------

/** A lock that PAUSES the device's grant until the PIN is entered again: the three
 * deliberate ones (panic, a multi-tap, Escape) and the two checkbox-caused ones (`hidden`,
 * `screenLock`). Without the pause the grant would re-mint on return and the lock would
 * mean nothing. Idle, route-away, expiry and a 401 do NOT pause it: they are the very locks
 * a grant exists to smooth over. */
export function pausesGrant(cause: LockCause): boolean {
  return (
    cause === "panic" ||
    cause === "multiTap" ||
    cause === "escape" ||
    cause === "hidden" ||
    cause === "screenLock"
  );
}

// -- "Lock when I change tab" / "Lock when I lock my screen" (§8) ------------------------

export interface LockSettings {
  readonly lockOnTab: boolean;
  readonly lockOnScreen: boolean;
}

/** Both boxes ticked: today's behaviour, fail-closed for a disguised chat. */
export const DEFAULT_LOCK_SETTINGS: LockSettings = { lockOnTab: true, lockOnScreen: true };

/** The settings the driver should act on. When this browser can tell a screen lock from a
 * tab switch they are the stored ones. When it cannot (no `IdleDetector`, or permission
 * denied) the two boxes follow each other; if the stored values disagree the safe reading is
 * used — lock if EITHER box is ticked — so losing the detector can never quietly turn a
 * lock the owner asked for into no lock. */
export function effectiveLockSettings(stored: LockSettings, screenDistinct: boolean): LockSettings {
  if (screenDistinct) return stored;
  const lock = stored.lockOnTab || stored.lockOnScreen;
  return { lockOnTab: lock, lockOnScreen: lock };
}

/** What a `visibilitychange → hidden` on an open chat does:
 * - both boxes ticked: lock at once (today's behaviour);
 * - both unticked: nothing (the idle timer still applies unless a grant is active);
 * - they differ: the cause is unknown until the page is back, so lock at once and fail
 *   closed — a "shield" — then decide on return. */
export type HiddenPolicy = "ignore" | "lockNow" | "shield";

export function hiddenPolicy(settings: LockSettings): HiddenPolicy {
  if (settings.lockOnTab && settings.lockOnScreen) return "lockNow";
  if (!settings.lockOnTab && !settings.lockOnScreen) return "ignore";
  return "shield";
}

/** What the screen-lock events dispatched around one hide say about it. `causal`: one was
 * dispatched within `[hideAt - BEFORE, hideAt + AFTER]` — delivered in real time, near the hide.
 * `any`: one was dispatched at any time from `hideAt - BEFORE` until `endAt` (the end of the
 * return shield), including a late one or one batched when a frozen page resumed. All times are
 * `performance.now()` values, which keep counting while a page is frozen. */
export interface ScreenLockEvidence {
  readonly causal: boolean;
  readonly any: boolean;
}

export function screenLockEvidence(lockTimes: readonly number[], hideAt: number, endAt: number): ScreenLockEvidence {
  const from = hideAt - SCREEN_LOCK_EVIDENCE_BEFORE_MS;
  const causalUntil = hideAt + SCREEN_LOCK_EVIDENCE_AFTER_MS;
  let causal = false;
  let any = false;
  for (const at of lockTimes) {
    if (at < from || at > endAt) continue;
    any = true;
    if (at <= causalUntil) causal = true;
  }
  return { causal, any };
}

/** Why the page went to the background, as far as it can be told (Architect ruling, §8):
 * - "screenLock": a lock event was dispatched near the hide — positive, CAUSAL evidence;
 * - "tabChange": NO lock event of any kind (batched ones included) around the absence AND this
 *   device has proven it reports screen locks as they happen — there is never positive evidence
 *   of a TAB switch, only of a screen lock, so "no event" can only be read as "tab" on a device
 *   that has shown it would have reported one;
 * - "ambiguous": everything else — a lock event outside the causal window (later in the
 *   absence, or batched on return), or no event on a device that has not proven itself. */
export type HideCause = "screenLock" | "tabChange" | "ambiguous";

export function classifyHide(input: {
  readonly causalScreenLock: boolean;
  readonly anyScreenLock: boolean;
  readonly deviceProven: boolean;
}): HideCause {
  if (input.causalScreenLock) return "screenLock";
  if (input.anyScreenLock) return "ambiguous";
  return input.deviceProven ? "tabChange" : "ambiguous";
}

/** After a shield: restore the chat silently only when the cause is KNOWN and its own box is
 * unticked. A ticked box, or an ambiguous cause, stays locked. */
export type ShieldOutcome = "restore" | "stayLocked";

export function shieldOutcome(cause: HideCause, settings: LockSettings): ShieldOutcome {
  if (cause === "ambiguous") return "stayLocked";
  const boxTicked = cause === "screenLock" ? settings.lockOnScreen : settings.lockOnTab;
  return boxTicked ? "stayLocked" : "restore";
}
