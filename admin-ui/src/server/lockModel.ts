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

import type { LockCause } from "./types";

export type PinError =
  | { readonly kind: "wrong"; readonly attemptsLeft: number | null }
  | { readonly kind: "lockedOut"; readonly retryAfterS: number }
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
  | { readonly kind: "fading" };

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
  | { readonly type: "verifyUnavailable" }
  /** An explicit Cancel on the PIN pad — distinct from `lock`: nothing was
   * ever unlocked, so there's no chat subtree to detach. */
  | { readonly type: "cancel" }
  /** A qualifying R7 activity event, while revealed/pin/chat/fading. */
  | { readonly type: "activity" }
  /** The 800ms fade timer elapsed without being cancelled. */
  | { readonly type: "fadeComplete" }
  /** Any of R6's eight instant-lock causes — see the design note above for
   * why "idle" is included here rather than as its own event. */
  | { readonly type: "lock"; readonly cause: LockCause };

export type LockEffect =
  /** (Re)start the 10s idle timer from now. */
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

export const INITIAL_STATE: LockState = { kind: "decoy" };

const NO_OP = (state: LockState): LockTransitionResult => ({ state, effects: [] });

function reduceDecoy(state: LockState, event: LockEvent): LockTransitionResult {
  if (event.type === "tap") {
    return { state: { kind: "revealed" }, effects: ["resetIdleTimer"] };
  }
  // Already locked — every lock cause, a stray multiTap (no meaning here
  // per R2 v1.3), and anything else, is a no-op.
  return NO_OP(state);
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

function reduceChat(state: LockState, event: LockEvent): LockTransitionResult {
  switch (event.type) {
    case "activity":
      return { state, effects: ["resetIdleTimer"] };
    case "multiTap":
      // R3: a multi-tap anywhere inside the chat view locks instantly.
      return { state: { kind: "decoy" }, effects: ["detachChat", "clearIdleTimer"] };
    case "lock":
      if (event.cause === "idle") {
        // The one non-instant cause: fade first (§6's diagram).
        return { state: { kind: "fading" }, effects: ["startFadeTimer", "clearIdleTimer"] };
      }
      return { state: { kind: "decoy" }, effects: ["detachChat", "clearIdleTimer"] };
    default:
      return NO_OP(state);
  }
}

function reduceFading(state: LockState, event: LockEvent): LockTransitionResult {
  switch (event.type) {
    case "activity":
      // R7: any activity while fading cancels it and restores the chat.
      return { state: { kind: "chat" }, effects: ["clearFadeTimer", "resetIdleTimer"] };
    case "fadeComplete":
      return { state: { kind: "decoy" }, effects: ["detachChat", "clearIdleTimer"] };
    case "multiTap":
    case "lock":
      // Defensive: correct regardless of the driver's event-dispatch order
      // (see gestures.ts's own note on why a real double-tap during a fade
      // never actually reaches this branch — activity fires first and
      // restores "chat", where the SAME multiTap/lock semantics apply).
      return { state: { kind: "decoy" }, effects: ["detachChat", "clearFadeTimer", "clearIdleTimer"] };
    default:
      return NO_OP(state);
  }
}

/** `now` is accepted to match §6's frozen `(state, event, now) => {state,
 * effects[]}` signature; no branch here currently needs it (every timer is
 * driven by the caller's own clock via the `effects` it receives back) — kept
 * so a future transition can start depending on it without a signature
 * change every other module would need to follow. */
export function reduce(state: LockState, event: LockEvent, now: number): LockTransitionResult {
  void now;
  switch (state.kind) {
    case "decoy":
      return reduceDecoy(state, event);
    case "revealed":
      return reduceRevealed(state, event);
    case "pin":
      return reducePin(state, event);
    case "verifying":
      return reduceVerifying(state, event);
    case "chat":
      return reduceChat(state, event);
    case "fading":
      return reduceFading(state, event);
  }
}
