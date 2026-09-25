// The "Server" panel's orchestrator (spec/server-chat/00-brief.md §6, R2
// v1.3 per operator decision #974): wires the pure `lockModel` reducer to
// real timers, BOTH gesture detectors (a single tap anywhere in the panel
// reveals the decoy's affordance; a multi-tap inside the chat view locks,
// R3 — see gestures.ts), R7's activity/suspension bookkeeping, and the
// decoy/pin-pad/chat views. This is the ONLY module that touches the DOM
// event loop, `fetch`, or `setTimeout` for the lock machine — every decision
// about WHAT state comes next lives in `lockModel.ts` instead, so it can be
// tested without any of this.
//
// "Keep this device unlocked" (spec/server-chat/03-permanent-unlock.md) adds three things
// here, all as INPUTS to that same machine rather than a second one: a device grant that
// replaces typing the PIN (`deviceGrant.ts`, `api/grants.ts`), a silent re-mint of the
// unlock token before it expires, and the two "lock when I change tab / lock my screen"
// checkboxes (§8), which decide what a background switch does.

import type { AdminApi } from "../api";
import { unlockWithGrant } from "./api/grants";
import { unlock } from "./api/unlock";
import {
  FADE_MS,
  GRANT_RENEW_BEFORE_MS,
  GRANT_RENEW_LAST_CHANCE_MS,
  GRANT_RENEW_LOOP_GUARD_MS,
  GRANT_RENEW_MEDIA_DEFER_MS,
  GRANT_RENEW_RETRY_MS,
  MULTI_TAP_INTERVAL_MS,
  PICKER_SUSPEND_MAX_MS,
  SCREEN_LOCK_EVIDENCE_AFTER_MS,
  SCREEN_LOCK_EVIDENCE_BEFORE_MS,
  SHIELD_WAIT_MS,
} from "./constants";
import { mountDecoy, type DecoyView } from "./decoy";
import { clearDeviceGrant, isGrantActive, onGrantStateChanged, readDeviceGrant, setGrantPaused } from "./deviceGrant";
import { attachMultiTapListener, attachTapListener, createMultiTapDetector, createTapDetector } from "./gestures";
import { chatIdleLockMs, onIdleLockPreferenceChanged } from "./idlePreference";
import {
  classifyHide,
  effectiveLockSettings,
  hiddenPolicy,
  idleRemainingMs,
  INITIAL_STATE,
  pausesGrant,
  reduce,
  screenLockEvidence,
  shieldOutcome,
  type LockContext,
  type LockEffect,
  type LockEvent,
  type LockSettings,
  type LockState,
} from "./lockModel";
import { isScreenLockProven, onLockSettingsChanged, readStoredLockSettings, setScreenLockProven } from "./lockSettings";
import { mountPinPad, type PinPadView } from "./pinPad";
import { createScreenWatcher } from "./screenWatcher";
import type {
  CreateServerChatView,
  LockCause,
  LockHooks,
  ServerApi,
  ServerChatView,
  ServerSession,
  SuspendReason,
} from "./types";

export interface ServerPanelDeps {
  api: Pick<AdminApi, "getSystemStatus" | "getServerVersion">;
  win?: Window;
  /** Injected so this parcel can ship before P5b's real `server/chatView.ts`
   * lands (wave 2, concurrent build) — defaults to a minimal stub honouring
   * the same frozen `ServerChatView` contract (types.ts). DM integration
   * swaps in the real factory (and a real assembled `ServerApi`) once it
   * exists; nothing else about this module needs to change for that. */
  createServerChatView?: CreateServerChatView;
}

export interface ServerPanel {
  readonly element: HTMLElement;
  teardown(): void;
}

const ACTIVITY_EVENT_TYPES: readonly (keyof DocumentEventMap)[] = [
  "pointerdown",
  "pointermove",
  "touchstart",
  "touchmove",
  "wheel",
  "keydown",
  "input",
];

/** Placeholder `ServerApi` — see types.ts: this parcel constructs no real
 * livechat API surface (messages/uploads/push aren't P4's scope), so the
 * stub view below never dereferences it. */
const STUB_API: ServerApi = {};

let stubInstanceCounter = 0;

/** Stands in for P5b's real `server/chatView.ts` until it lands — but does
 * more than the bare minimum: a panic button and a draft-preserving
 * textarea, matching the REAL view's eventual shape closely enough (§6's
 * "header: ... a panic ✕ (aria-label='Close')"; draft text living in the
 * view's own DOM) that this parcel's own e2e spec (`server-lock.spec.ts`)
 * can exercise panic and draft-survival against real DOM/browser behaviour
 * today, not just assert them in principle. `data-stub-instance` is a
 * test-only marker (unique per factory call) proving the SAME instance
 * persists across a lock/unlock cycle rather than being recreated — the
 * actual mechanism draft-survival (R6) depends on. */
const createStubServerChatView: CreateServerChatView = (deps) => {
  const element = document.createElement("div");
  // `.wx-srv-thread` matches the class P5's real thread view will use
  // (§11's e2e matrix asserts its absence from the DOM after a lock) — the
  // stub honours the same contract so this panel's own detach behaviour is
  // meaningfully testable today, and stays correct once the real view
  // replaces this factory.
  element.className = "wx-srv-chat-stub wx-srv-thread";
  element.dataset["stubInstance"] = String(++stubInstanceCounter);

  const notice = document.createElement("p");
  notice.textContent = "Server chat is coming soon.";
  element.appendChild(notice);

  const draft = document.createElement("textarea");
  draft.className = "wx-srv-draft-stub";
  draft.placeholder = "Draft…";
  element.appendChild(draft);

  const panicButton = document.createElement("button");
  panicButton.type = "button";
  panicButton.className = "wx-srv-panic";
  panicButton.setAttribute("aria-label", "Close");
  panicButton.textContent = "✕";
  panicButton.addEventListener("click", () => deps.hooks.lockNow("panic"));
  element.appendChild(panicButton);

  return {
    element,
    attach(): void {},
    detach(): void {},
    dispose(): void {},
  };
};

export function mountServerPanel(deps: ServerPanelDeps): ServerPanel {
  const win = deps.win ?? window;
  const createChatView = deps.createServerChatView ?? createStubServerChatView;

  const root = document.createElement("div");
  root.className = "wx-srv-panel";

  const decoy: DecoyView = mountDecoy({ api: deps.api, win });
  root.appendChild(decoy.element);

  const affordanceButton = document.createElement("button");
  affordanceButton.type = "button";
  affordanceButton.className = "wx-srv-affordance";
  affordanceButton.textContent = "Open server settings";
  affordanceButton.hidden = true;
  affordanceButton.addEventListener("click", () => {
    // R2 v1.3: "ignore taps <400ms after reveal" — a rapid double-tap that
    // revealed the affordance and then immediately happened to also land on
    // it (finger hasn't moved) must not ALSO count as deliberately opening
    // the pin pad; require a genuinely separate tap after the debounce
    // window. `revealedAtMs` is stamped by `dispatch` the moment the
    // decoy->revealed transition actually happens.
    if (revealedAtMs !== null && win.performance.now() - revealedAtMs < MULTI_TAP_INTERVAL_MS) return;
    dispatch({ type: "tapAffordance" });
  });
  root.appendChild(affordanceButton);

  const pinPadHost = document.createElement("div");
  pinPadHost.className = "wx-srv-pinpad-host";
  pinPadHost.hidden = true;
  const pinPad: PinPadView = mountPinPad({
    win,
    onSubmit: (pin) => submitPin(pin),
    onCancel: () => dispatch({ type: "cancel" }),
  });
  pinPadHost.appendChild(pinPad.element);
  root.appendChild(pinPadHost);

  const chatMountEl = document.createElement("div");
  chatMountEl.className = "wx-srv-chat-host";
  chatMountEl.hidden = true;
  root.appendChild(chatMountEl);

  // -- Lock state -------------------------------------------------------------

  let state: LockState = INITIAL_STATE;
  let session: ServerSession | null = null;
  let chatView: ServerChatView | null = null;
  let chatAttached = false;
  let verifyRequestSeq = 0;
  /** Stale-response filter for the grant unlock a mount starts, like `verifyRequestSeq`. */
  let grantRequestSeq = 0;
  /** R2 v1.3's reveal-affordance debounce (see the affordance click handler
   * above) — `dispatch` stamps this the instant a "tap" event actually
   * produces the decoy->revealed transition. */
  let revealedAtMs: number | null = null;

  function ensureChatView(): ServerChatView {
    if (chatView === null) {
      chatView = createChatView({ api: STUB_API, hooks, win, session: () => session });
    }
    return chatView;
  }

  function detachChatView(): void {
    if (!chatAttached) return;
    chatView?.detach();
    chatView?.element.remove();
    chatAttached = false;
  }

  function render(): void {
    const kind = state.kind;
    affordanceButton.hidden = kind !== "revealed";
    // While a device grant is minting this visit's token nothing is shown, not even the
    // decoy: a flash of disguise followed by the chat would tell a bystander which is which.
    root.classList.toggle("wx-srv-granting", kind === "granting");

    const showPinPad = kind === "pin" || kind === "verifying";
    pinPadHost.hidden = !showPinPad;
    if (kind === "pin") {
      // Deliberately NOT `pinPad.setError(state.error)` here: render() runs
      // on EVERY dispatch while still in "pin" (e.g. each digit's own
      // "activity" event), and `setError` clears entered digits as a side
      // effect (a fresh error means the last attempt was rejected) — calling
      // it on every unrelated re-render would wipe physical-keyboard PIN
      // entry mid-typing. The error only ever actually CHANGES on a
      // transition INTO "pin" (`tapAffordance`, or a verify failure), and
      // every one of those carries a `focusPin` effect — see `applyEffects`,
      // which syncs the error there instead, exactly once per real change.
      pinPad.setBusy(false);
    } else if (kind === "verifying") {
      pinPad.setBusy(true);
    } else {
      pinPad.reset();
    }

    const showChat = kind === "chat" || kind === "fading";
    if (showChat && !chatAttached) {
      const view = ensureChatView();
      chatMountEl.appendChild(view.element);
      if (session !== null) view.attach(session);
      chatAttached = true;
    }
    chatMountEl.hidden = !showChat;
    chatMountEl.classList.toggle("wx-srv-fading", kind === "fading");
  }

  // -- Idle / fade / expiry timers ---------------------------------------------

  let idleTimer: ReturnType<typeof win.setTimeout> | null = null;
  /** Whether the state machine currently wants a running idle timer — kept
   * distinct from `idleTimer !== null` because a suspension pauses the
   * concrete timer while this stays true, so `armIdleTimer` knows to
   * actually restart it once every suspension has released (R7). */
  let idleTimerArmed = false;
  /** `performance.now()` at the last (re)start of the idle period — a real
   * activity event, or a suspension ending. The deadline is always this plus
   * the current state's idle timeout, so a settings change can re-schedule
   * against it without ever restarting the clock. */
  let idleStartedAtMs = 0;
  /** The same instant on the wall clock. `performance.now()` need not advance while a phone
   * sleeps, so a return from the background compares this instead. */
  let lastActivityWallMs = Date.now();
  let fadeTimer: ReturnType<typeof win.setTimeout> | null = null;
  let expiryTimer: ReturnType<typeof win.setTimeout> | null = null;
  let renewTimer: ReturnType<typeof win.setTimeout> | null = null;

  function fireIdle(): void {
    idleTimer = null;
    dispatch({ type: "lock", cause: "idle" });
  }

  /** With a device grant active the open chat never idles out — no timer is scheduled at
   * all, rather than one that fires into a reducer that ignores it. The decoy's reveal
   * button and the PIN pad keep their own idle re-hide either way. */
  function idleSuppressedByGrant(): boolean {
    return state.kind === "chat" && isGrantActive(win);
  }

  /** (Re)schedules the concrete idle timer for whatever is left of the
   * current period: the last (re)start plus this state's idle timeout — the
   * device's chosen duration in "chat", the fixed 10s in "revealed"/"pin" —
   * read fresh from the preference every time. Never moves `idleStartedAtMs`. */
  function scheduleIdleTimer(): void {
    if (idleTimer !== null) {
      win.clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (totalSuspensionCount > 0) return; // stays paused — see `release()` below
    if (idleSuppressedByGrant()) return;
    const remainingMs = idleRemainingMs(state, chatIdleLockMs(win), idleStartedAtMs, win.performance.now());
    idleTimer = win.setTimeout(fireIdle, remainingMs);
  }

  /** Real user activity (or a suspension ending): a FRESH full idle period. */
  function armIdleTimer(): void {
    idleTimerArmed = true;
    idleStartedAtMs = win.performance.now();
    lastActivityWallMs = Date.now();
    scheduleIdleTimer();
  }

  /** The "Extend auto-lock to 1 minute" box changed (here, or in another tab):
   * apply it at once, measured from the last activity — NOT a restart. While
   * suspended (or with no idle timer wanted at all) there is nothing to
   * re-schedule; the next real restart reads the new value itself. */
  function onIdlePreferenceChanged(): void {
    if (idleTimerArmed) scheduleIdleTimer();
  }

  function disarmIdleTimer(): void {
    idleTimerArmed = false;
    if (idleTimer !== null) {
      win.clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function armFadeTimer(): void {
    if (fadeTimer !== null) win.clearTimeout(fadeTimer);
    fadeTimer = win.setTimeout(() => {
      fadeTimer = null;
      dispatch({ type: "fadeComplete" });
    }, FADE_MS);
  }

  function disarmFadeTimer(): void {
    if (fadeTimer !== null) {
      win.clearTimeout(fadeTimer);
      fadeTimer = null;
    }
  }

  function msUntilExpiry(): number {
    return session === null ? 0 : session.expiresAt * 1000 - Date.now();
  }

  /** The token's two deadlines: renewal `GRANT_RENEW_BEFORE_MS` early (acted on only if a
   * grant is active when it fires), and expiry itself. Re-armed whenever the session or the
   * grant changes. */
  function armSessionTimers(expiresAtEpochS: number): void {
    clearSessionTimers();
    const untilExpiryMs = expiresAtEpochS * 1000 - Date.now();
    expiryTimer = win.setTimeout(onExpiry, Math.max(0, untilExpiryMs));
    renewTimer = win.setTimeout(() => void renewSession("scheduled"), Math.max(0, untilExpiryMs - GRANT_RENEW_BEFORE_MS));
  }

  function clearSessionTimers(): void {
    if (expiryTimer !== null) {
      win.clearTimeout(expiryTimer);
      expiryTimer = null;
    }
    if (renewTimer !== null) {
      win.clearTimeout(renewTimer);
      renewTimer = null;
    }
  }

  function onExpiry(): void {
    expiryTimer = null;
    // The token ran out. A grant gets one last silent try before the chat locks.
    if (grantUsable() && session !== null) {
      void renewSession("expiry");
      return;
    }
    dispatch({ type: "lock", cause: "expired" });
  }

  function applyEffects(effects: readonly LockEffect[]): void {
    for (const effect of effects) {
      switch (effect) {
        case "resetIdleTimer":
          armIdleTimer();
          break;
        case "clearIdleTimer":
          disarmIdleTimer();
          break;
        case "startFadeTimer":
          armFadeTimer();
          break;
        case "clearFadeTimer":
          disarmFadeTimer();
          break;
        case "detachChat":
          detachChatView();
          break;
        case "focusPin":
          // Every path that carries this effect lands in "pin" — see
          // `render`'s comment on why the error is synced here rather than
          // on every render.
          if (state.kind === "pin") pinPad.setError(state.error);
          pinPad.focus();
          break;
      }
    }
    if (state.kind !== "shielded") {
      cancelShieldResolve();
      restoreAfterRenewal = false;
      shieldPausedGrant = false;
    }
    if (state.kind === "decoy") {
      // R4/R6: nothing sensitive survives a return to the decoy — the token
      // is discarded and the expiry timer has nothing left to guard. (A
      // "shielded" chat is deliberately NOT here: it holds the session until
      // the shield resolves, and every path out of it that is not a restore
      // ends here.)
      session = null;
      clearSessionTimers();
      renewalInFlight = false;
    }
  }

  function dispatch(event: LockEvent, contextOverride?: Partial<LockContext>): void {
    const previousKind = state.kind;
    const context: LockContext = { grantActive: contextOverride?.grantActive ?? isGrantActive(win) };
    const result = reduce(state, event, Date.now(), context);
    state = result.state;
    if (previousKind === "decoy" && result.state.kind === "revealed") {
      // Stamped here, not inside `reduce` (a pure function with no clock of
      // its own) — see the affordance click handler's debounce. Reads
      // `result.state.kind` rather than the just-reassigned `state.kind`
      // (equivalent value) so this check reads cleanly regardless of when
      // the reassignment above happened.
      revealedAtMs = win.performance.now();
    }
    if (previousKind !== "chat" && result.state.kind === "chat") {
      // R3's multiTapDetector is attached to `document` for the panel's
      // WHOLE mounted lifetime (see below), not scoped to the chat view —
      // `isExcludedTapTarget` excludes textarea/input/contenteditable/audio/
      // video, but NOT the PIN pad's own <button> elements, so every PIN
      // digit/backspace/checkmark tap feeds the SAME detector R3 uses inside
      // chat. Without this reset, a leftover odd tap count from PIN entry
      // can combine with the very first tap made inside the just-unlocked
      // chat view to spuriously complete a "multi-tap" and instantly
      // panic-lock the view that was only just unlocked.
      multiTapDetector.reset();
    }
    render();
    applyEffects(result.effects);
  }

  // -- Device grant: pausing, the mount unlock, and silent renewal ------------------------

  /** A chat that was open (or opening) is being locked by something the owner did or asked
   * for: pause the grant so the PIN is needed again, and a reload cannot undo it. Locks the
   * grant exists to smooth over — idle, route-away, expiry, a 401 — never call this. */
  function pauseGrantForLock(cause: LockCause): void {
    if (!pausesGrant(cause)) return;
    const chatWasOpen =
      state.kind === "chat" || state.kind === "fading" || state.kind === "shielded" || state.kind === "granting";
    if (chatWasOpen && isGrantActive(win)) setGrantPaused(win, true);
  }

  /** Locks even though a grant is active — for the moments the grant has run out of road
   * (it was revoked, or the token expired and cannot be renewed). */
  function forceLock(cause: LockCause): void {
    dispatch({ type: "lock", cause }, { grantActive: false });
  }

  let renewalInFlight = false;
  let lastRenewedAtMs: number | null = null;
  /** A shield resolved to "restore" but the token had expired while away: the chat comes back
   * the moment a renewal lands (see `adoptSession`); a failed one locks instead. */
  let restoreAfterRenewal = false;
  /** The panel has been torn down: no late answer (a renewal, a grant unlock, a detector
   * start) may bring anything back to life. */
  let disposed = false;
  /** The grant was paused AT THE START of the current shield, by this panel (see
   * `beginShield`). Only a restore undoes it. */
  let shieldPausedGrant = false;

  /** A grant this panel can still use right now: active, or paused only by the shield that is
   * in progress (which is what lets a shielded chat with an expired token still re-mint). */
  function grantUsable(): boolean {
    return isGrantActive(win) || (state.kind === "shielded" && shieldPausedGrant && readDeviceGrant(win) !== null);
  }

  function mediaIsPlaying(): boolean {
    return (suspensionsByReason.get("mediaPlaying") ?? 0) > 0;
  }

  /** Swaps in the renewed token with no visible change: the chat view re-attaches with it
   * (reopening its stream from where it left off and refreshing the signed media URLs, which
   * are bound to the OLD token's expiry). A shielded chat has no view attached — it just
   * holds the new session until it is restored. */
  function adoptSession(next: ServerSession): void {
    if (disposed) return;
    session = next;
    lastRenewedAtMs = win.performance.now();
    armSessionTimers(next.expiresAt);
    if (chatAttached && chatView !== null) chatView.attach(next);
    // A shield that resolved to "restore" while the token had already run out was waiting for
    // exactly this — whichever renewal it was, its own or one that was already in flight.
    // Only while the page is still in front of the owner and nothing has voided the decision:
    // a second switch or a screen lock since then means the cause can no longer be read.
    if (
      restoreAfterRenewal &&
      state.kind === "shielded" &&
      !shieldTainted &&
      win.document.visibilityState !== "hidden" &&
      msUntilExpiry() > 0
    ) {
      restoreAfterRenewal = false;
      commitShieldRestore();
    }
  }

  /** Mints a fresh token from the device grant. `scheduled` is the early renewal, `expiry`
   * the last chance, `unauthorized` a 401 that arrived while the grant is active. */
  async function renewSession(reason: "scheduled" | "expiry" | "unauthorized"): Promise<void> {
    if (disposed || renewalInFlight || session === null) return;
    const lockCause: LockCause = reason === "unauthorized" ? "unauthorized" : "expired";
    const grant = grantUsable() ? readDeviceGrant(win) : null;
    if (grant === null) {
      if (reason !== "scheduled") forceLock(lockCause);
      return;
    }
    if (reason === "scheduled" && mediaIsPlaying() && msUntilExpiry() > GRANT_RENEW_LAST_CHANCE_MS) {
      // Refreshing the signed media URLs restarts a playing voice note or video: wait for it.
      renewTimer = win.setTimeout(() => void renewSession("scheduled"), GRANT_RENEW_MEDIA_DEFER_MS);
      return;
    }
    const holding = session;
    renewalInFlight = true;
    const result = await unlockWithGrant(grant);
    renewalInFlight = false;
    // Torn down, locked, or replaced by a PIN unlock while the request was out: this answer is
    // stale.
    if (disposed || session !== holding) return;
    if (result.ok) {
      adoptSession({ token: result.token, expiresAt: result.expiresAt });
      return;
    }
    if (result.kind === "invalid") {
      clearDeviceGrant(win); // revoked or expired on the server: this device forgets it
      forceLock(lockCause);
      return;
    }
    // Offline, a proxy error, or a rate limit: the grant may still be good.
    if (reason === "scheduled" && msUntilExpiry() > 0) {
      renewTimer = win.setTimeout(() => void renewSession("scheduled"), GRANT_RENEW_RETRY_MS);
      return;
    }
    forceLock(lockCause);
  }

  /** A mount (or reload) with the setting on and not paused opens straight into the chat:
   * no decoy step, no PIN. Anything short of a fresh token falls back to the decoy. */
  function startGrantUnlock(): void {
    const grant = readDeviceGrant(win);
    if (grant === null || !isGrantActive(win)) return;
    dispatch({ type: "grantUnlock" });
    if (state.kind !== "granting") return;
    const requestId = ++grantRequestSeq;
    void unlockWithGrant(grant).then((result) => {
      // Locked, escaped or torn down while the request was out: never resurrect the chat.
      if (disposed || requestId !== grantRequestSeq || state.kind !== "granting") return;
      if (result.ok) {
        session = { token: result.token, expiresAt: result.expiresAt };
        armSessionTimers(result.expiresAt);
        lastRenewedAtMs = win.performance.now();
        dispatch({ type: "grantOk" });
        return;
      }
      if (result.kind === "invalid") clearDeviceGrant(win); // revoked or expired: forget it
      dispatch({ type: "grantFailed" });
    });
  }

  /** The grant was turned on or off, paused or resumed (here or in another tab): the idle
   * timer and the renewal schedule both depend on it. */
  function onGrantChanged(): void {
    if (idleTimerArmed) scheduleIdleTimer();
    if (session !== null) armSessionTimers(session.expiresAt);
  }

  // -- R7 suspension bookkeeping ------------------------------------------------

  const suspensionsByReason = new Map<SuspendReason, number>();
  let totalSuspensionCount = 0;

  function incrementSuspension(reason: SuspendReason): void {
    suspensionsByReason.set(reason, (suspensionsByReason.get(reason) ?? 0) + 1);
    totalSuspensionCount += 1;
  }

  function decrementSuspension(reason: SuspendReason): void {
    const next = (suspensionsByReason.get(reason) ?? 0) - 1;
    if (next <= 0) suspensionsByReason.delete(reason);
    else suspensionsByReason.set(reason, next);
    totalSuspensionCount = Math.max(0, totalSuspensionCount - 1);
  }

  /** R6's `hidden` exception is narrower than R7's general suspension set —
   * only an open file picker or a pending mic-permission prompt excuses a
   * backgrounded tab from locking; `recording`/`mediaPlaying` do not. */
  function isPickerOrMicOpen(): boolean {
    return (suspensionsByReason.get("filePicker") ?? 0) > 0 || (suspensionsByReason.get("micPermission") ?? 0) > 0;
  }

  const hooks: LockHooks = {
    suspend(reason: SuspendReason): () => void {
      let released = false;
      incrementSuspension(reason);
      if (idleTimer !== null) {
        win.clearTimeout(idleTimer);
        idleTimer = null;
      }
      const safetyTimer =
        reason === "filePicker" ? win.setTimeout(() => release(), PICKER_SUSPEND_MAX_MS) : null;
      function release(): void {
        if (released) return;
        released = true;
        if (safetyTimer !== null) win.clearTimeout(safetyTimer);
        decrementSuspension(reason);
        if (totalSuspensionCount === 0 && idleTimerArmed) armIdleTimer();
      }
      return release;
    },
    lockNow(cause: LockCause): void {
      if (cause === "unauthorized" && shouldRenewInsteadOfLocking()) {
        void renewSession("unauthorized");
        return;
      }
      pauseGrantForLock(cause);
      dispatch({ type: "lock", cause });
    },
  };

  /** A 401 while a grant is active usually means the token ran out or was dropped: mint a new
   * one silently instead of locking. A 401 right after a renewal is not that — the server is
   * refusing tokens for a reason a fresh one will not fix — so it locks. */
  function shouldRenewInsteadOfLocking(): boolean {
    if (session === null || !isGrantActive(win)) return false;
    if (state.kind !== "chat" && state.kind !== "fading") return false;
    if (renewalInFlight) return true;
    return lastRenewedAtMs === null || win.performance.now() - lastRenewedAtMs > GRANT_RENEW_LOOP_GUARD_MS;
  }

  // -- Unlock -------------------------------------------------------------------

  function submitPin(pin: string): void {
    dispatch({ type: "submit" });
    const requestId = ++verifyRequestSeq;
    void unlock(pin).then((result) => {
      // A stale response (the user backed out, or another attempt started)
      // must never resurrect a finished verify — the reducer itself has no
      // way to reject a late event by identity, so the driver filters here.
      if (requestId !== verifyRequestSeq || state.kind !== "verifying") return;
      if (result.ok) {
        session = { token: result.token, expiresAt: result.expiresAt };
        armSessionTimers(result.expiresAt);
        // A correct PIN ends a pause: a device that keeps itself unlocked is permanently
        // unlocked again (03-permanent-unlock.md §1). Cleared BEFORE the transition so the
        // reducer already sees the grant as active.
        setGrantPaused(win, false);
        dispatch({ type: "verifyOk" });
        return;
      }
      if (result.kind === "wrongPin") {
        dispatch({ type: "verifyWrong", attemptsLeft: result.attemptsLeft });
      } else if (result.kind === "lockedOut") {
        dispatch({ type: "verifyLockedOut", retryAfterS: result.retryAfterS });
      } else if (result.kind === "pinChanged") {
        dispatch({ type: "verifyPinChanged" });
      } else if (result.kind === "invalid") {
        dispatch({ type: "verifyInvalid" });
      } else if (result.kind === "unexpected") {
        dispatch({ type: "verifyUnexpected" });
      } else {
        dispatch({ type: "verifyUnavailable" });
      }
    });
  }

  // -- Gestures + document-level listeners (R2 v1.3, R3, R6, R7) ------------------

  // R3 (unchanged): a multi-tap ANYWHERE while the panel is mounted — only
  // "chat"/"fading" give the resulting event any meaning (lockModel.ts).
  const multiTapDetector = createMultiTapDetector(
    () => {
      // A deliberate lock: it also pauses a device grant. Only from the states where the
      // reducer really locks on it — it means nothing anywhere else.
      if (state.kind === "chat" || state.kind === "fading") pauseGrantForLock("multiTap");
      dispatch({ type: "multiTap" });
    },
    () => win.performance.now(),
  );
  const detachMultiTapListener = attachMultiTapListener(win.document, multiTapDetector);

  // R2 v1.3 (operator decision #974): a single tap, scoped to the panel's
  // OWN root — "inside the Server panel element, not nav/topbar" is free
  // here since anything outside `root`'s subtree never reaches a listener
  // attached to it (see gestures.ts's own note).
  const singleTapDetector = createTapDetector(() => dispatch({ type: "tap" }));
  const detachSingleTapListener = attachTapListener(root, singleTapDetector);

  function onActivity(): void {
    dispatch({ type: "activity" });
  }
  const detachActivityListeners = ACTIVITY_EVENT_TYPES.map((type) => {
    win.document.addEventListener(type, onActivity, { passive: true });
    return () => win.document.removeEventListener(type, onActivity);
  });

  function onKeyDownForEscape(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    pauseGrantForLock("escape");
    dispatch({ type: "lock", cause: "escape" });
  }
  win.document.addEventListener("keydown", onKeyDownForEscape);

  // -- Background switches and the two "lock when I…" checkboxes (§8) ---------------------

  const screenWatcher = createScreenWatcher(win);
  /** Whether a detector is running, i.e. this browser CAN tell a screen lock from a tab
   * switch. Until it is (and whenever it is lost) the two boxes follow each other. */
  let screenDistinct = false;
  /** `performance.now()` at which each `screenState = "locked"` event was DISPATCHED, oldest
   * first — the cause of a hide is judged from these (see `screenLockEvidence`). */
  let screenLockTimes: number[] = [];
  /** When the page last went to the background (`performance.now()`), or null. */
  let lastHideAtMs: number | null = null;
  /** The hide that began the current shield. */
  let shieldHideAtMs = 0;
  /** A SECOND background switch began before the current shield resolved. With two switches in
   * one absence the cause can no longer be read, so it stays locked. */
  let shieldTainted = false;
  let shieldResolveTimer: ReturnType<typeof win.setTimeout> | null = null;
  /** A hide dropped a grant unlock that was still answering: try again on return. */
  let retryGrantUnlockOnVisible = false;
  /** Lock events older than this are of no interest to any hide still to come. */
  const SCREEN_LOCK_KEEP_MS = 10 * 60_000;

  function currentLockSettings(): LockSettings {
    return effectiveLockSettings(readStoredLockSettings(win), screenDistinct);
  }

  function cancelShieldResolve(): void {
    if (shieldResolveTimer !== null) {
      win.clearTimeout(shieldResolveTimer);
      shieldResolveTimer = null;
    }
  }

  function recordScreenLock(at: number): void {
    screenLockTimes.push(at);
    const oldest = at - SCREEN_LOCK_KEEP_MS;
    screenLockTimes = screenLockTimes.filter((t) => t >= oldest).slice(-64);
  }

  /** A device is PROVEN only by a lock event dispatched within the causal window of a hide —
   * i.e. it reported the lock as it happened. A phone that always freezes first, and delivers
   * everything batched on return, never becomes proven (§8, Architect ruling). */
  function proveIfCausal(): void {
    if (!screenDistinct || lastHideAtMs === null) return;
    if (screenLockEvidence(screenLockTimes, lastHideAtMs, Number.POSITIVE_INFINITY).causal) setScreenLockProven(win, true);
  }

  function onScreenLocked(): void {
    const now = win.performance.now();
    recordScreenLock(now);
    const hidden = win.document.visibilityState === "hidden";
    if (hidden || state.kind === "shielded") {
      proveIfCausal();
      if (state.kind === "shielded" && !hidden) {
        if (shieldResolveTimer !== null) {
          // Any event during the return shield settles it: causal -> screen lock, otherwise the
          // cause is ambiguous. Either way there is nothing left to wait for.
          resolveShield();
        } else if (restoreAfterRenewal) {
          // The decision to restore was already made and is only waiting for a token: a screen
          // lock now voids it.
          restoreAfterRenewal = false;
          shieldTainted = true;
          dispatch({ type: "lock", cause: "screenLock" });
        }
      }
      return;
    }
    // The screen locked while the page stayed visible. Recorded above (a device may report it
    // just BEFORE the page hides, and that lock then counts for that hide). A desktop Win+L may
    // not hide the page at all: lock at once, if the owner asked for that.
    if ((state.kind === "chat" || state.kind === "fading") && currentLockSettings().lockOnScreen) {
      pauseGrantForLock("screenLock");
      dispatch({ type: "lock", cause: "screenLock" });
    }
  }

  function onScreenWatchLost(): void {
    screenDistinct = false;
    setScreenLockProven(win, false);
  }

  /** One start at a time. A request that arrives while one is in flight (the permission was
   * granted a moment after the mount's own attempt read "prompt") is not dropped: it runs once
   * more when the first finishes, but only if that first attempt did not succeed. */
  let screenWatchStarting = false;
  let screenWatchAgain = false;

  async function refreshScreenWatch(): Promise<void> {
    if (screenWatchStarting) {
      screenWatchAgain = true;
      return;
    }
    screenWatchStarting = true;
    try {
      do {
        screenWatchAgain = false;
        screenDistinct = await screenWatcher.start(onScreenLocked, onScreenWatchLost);
        // Torn down while the start was in flight: leave nothing running.
        if (disposed) screenWatcher.stop();
      } while (screenWatchAgain && !screenDistinct && !disposed);
      // No usable detector (no permission, unsupported, refused to start): a device that has no
      // detector cannot be "proven". Announces only if the flag really changes, so this cannot loop.
      if (!screenDistinct) setScreenLockProven(win, false);
    } finally {
      screenWatchStarting = false;
    }
  }

  function beginShield(): void {
    shieldHideAtMs = lastHideAtMs ?? win.performance.now();
    shieldTainted = false;
    cancelShieldResolve();
    // The grant is paused NOW, not when the shield resolves half a second after the owner is
    // back: a page that is closed, reloaded or DISCARDED while away never resolves it, and would
    // otherwise re-open on the next visit with no PIN — exactly what the pause exists to prevent.
    // Only a restore undoes it (`commitShieldRestore`).
    shieldPausedGrant = false;
    if (isGrantActive(win)) {
      setGrantPaused(win, true);
      shieldPausedGrant = true;
    }
    dispatch({ type: "shield" });
  }

  /** The shield resolved to "the cause was harmless": undo the pause it wrote (and ONLY that
   * one), and bring the chat back. */
  function commitShieldRestore(): void {
    if (shieldPausedGrant) {
      shieldPausedGrant = false;
      setGrantPaused(win, false);
    }
    dispatch({ type: "shieldRestore" });
  }

  function resolveShield(): void {
    shieldResolveTimer = null;
    if (state.kind !== "shielded") return;
    if (shieldTainted) {
      // Two switches in one absence: the cause can no longer be read.
      dispatch({ type: "lock", cause: "hidden" });
      return;
    }
    const evidence = screenLockEvidence(screenLockTimes, shieldHideAtMs, win.performance.now());
    const cause = classifyHide({
      causalScreenLock: evidence.causal,
      anyScreenLock: evidence.any,
      deviceProven: screenDistinct && isScreenLockProven(win),
    });
    if (shieldOutcome(cause, currentLockSettings()) === "stayLocked") {
      const lockCause: LockCause = cause === "screenLock" ? "screenLock" : "hidden";
      pauseGrantForLock(lockCause);
      dispatch({ type: "lock", cause: lockCause });
      return;
    }
    restoreShield();
  }

  /** The cause was harmless: bring the same chat back, with the session it was holding —
   * unless the idle period ran out while it was away (a grant excuses that), or the token
   * did (only a grant can mint another one silently). */
  function restoreShield(): void {
    if (idleRanOutWhileAway()) {
      dispatch({ type: "lock", cause: "idleAway" });
      return;
    }
    if (msUntilExpiry() > 0) {
      commitShieldRestore();
      return;
    }
    if (!grantUsable()) {
      dispatch({ type: "lock", cause: "expired" });
      return;
    }
    restoreAfterRenewal = true;
    void renewSession("expiry");
  }

  /** The idle period ended while the page was in the background. Never true with a grant
   * active, or while something (a recording, playback, an upload picker) is legitimately
   * holding the idle timer paused — R7 applies to a backgrounded page too. */
  function idleRanOutWhileAway(): boolean {
    if (grantUsable() || totalSuspensionCount > 0) return false;
    return Date.now() - lastActivityWallMs >= chatIdleLockMs(win);
  }

  /** The page is being unloaded (a reload, a navigation, a closing tab), not sent to the
   * background. Browsers fire `pagehide` and then `visibilitychange → hidden` for both, so
   * without this a reload would count as "the owner changed tab", lock, and — with a device
   * grant active — PAUSE the grant, undoing "keep this device unlocked" on every reload. The
   * chat's memory is about to be discarded anyway. A page that goes into the back/forward
   * cache (`persisted`) can be restored open, so it stays an ordinary background switch. */
  let unloading = false;

  function onPageHide(event: PageTransitionEvent): void {
    unloading = !event.persisted;
  }

  function onPageShow(): void {
    unloading = false;
  }

  function onHidden(): void {
    if (unloading) return;
    lastHideAtMs = win.performance.now();
    // A lock event reported up to a second BEFORE the page hid belongs to this hide, and proves
    // the device delivers them as they happen.
    proveIfCausal();
    // R7: an open file picker or a pending mic-permission prompt never lock, nor shield.
    if (isPickerOrMicOpen()) return;
    if (state.kind === "shielded") {
      // Away again before the last switch resolved. That is a second switch in one absence, so
      // the cause can no longer be read: keep the decoy up, drop any pending restore, and lock
      // when the page is next in front of the owner.
      shieldTainted = true;
      restoreAfterRenewal = false;
      cancelShieldResolve();
      return;
    }
    if (state.kind !== "chat") {
      // Every state that is not an open chat locks on a background switch exactly as before.
      // A grant unlock still answering when the page is hidden is dropped, and tried again on
      // return (it is not a lock the owner asked for, so it does not pause the grant).
      if (state.kind === "granting") retryGrantUnlockOnVisible = true;
      dispatch({ type: "lock", cause: "hidden" });
      return;
    }
    const policy = hiddenPolicy(currentLockSettings());
    if (policy === "ignore") return;
    if (policy === "lockNow") {
      pauseGrantForLock("hidden");
      dispatch({ type: "lock", cause: "hidden" });
      return;
    }
    beginShield();
  }

  function onVisible(): void {
    if (state.kind === "shielded") {
      cancelShieldResolve();
      // A switch that can no longer be read, or a lock event already seen (causal, or late and
      // so ambiguous), needs no waiting; otherwise give queued IdleDetector events a moment to
      // arrive before deciding.
      const seen = screenLockEvidence(screenLockTimes, shieldHideAtMs, win.performance.now()).any;
      if (shieldTainted || seen) resolveShield();
      else shieldResolveTimer = win.setTimeout(resolveShield, SHIELD_WAIT_MS);
      return;
    }
    if (state.kind === "fading") {
      // An idle fade began while the page was away; its (throttled) timer may never have run.
      // Nobody watched it, and a touch on return must not be able to cancel it.
      dispatch({ type: "fadeComplete" });
      return;
    }
    if (state.kind === "decoy" && retryGrantUnlockOnVisible) {
      retryGrantUnlockOnVisible = false;
      startGrantUnlock();
      return;
    }
    // Timers can stall while a page is in the background: if the idle period ran out while
    // away, lock NOW — instantly, with no fade a touch could cancel — instead of waiting for a
    // timer that may never have fired.
    if (state.kind === "chat" && idleRanOutWhileAway()) dispatch({ type: "lock", cause: "idleAway" });
  }

  function onVisibilityChange(): void {
    if (win.document.visibilityState === "hidden") onHidden();
    else onVisible();
  }
  win.document.addEventListener("visibilitychange", onVisibilityChange);
  win.addEventListener("pagehide", onPageHide);
  win.addEventListener("pageshow", onPageShow);

  const detachIdlePreferenceListener = onIdleLockPreferenceChanged(win, onIdlePreferenceChanged);
  const detachGrantStateListener = onGrantStateChanged(win, onGrantChanged);
  // The settings sheet may have just been granted the Idle Detection permission: start the
  // detector then. A RUNNING one is left alone — restarting it on every settings write could
  // drop the very events it is there to catch, and losing the permission is reported by the
  // watcher itself.
  const detachLockSettingsListener = onLockSettingsChanged(win, () => {
    if (!screenDistinct) void refreshScreenWatch();
  });

  render();
  void refreshScreenWatch();
  startGrantUnlock();

  return {
    element: root,
    teardown(): void {
      disposed = true;
      // Routing away from `/admin/server` is itself one of R6's lock causes
      // — run it through the reducer (rather than skipping straight to
      // cleanup) so a mid-chat departure still detaches/aborts/pauses
      // correctly, not just disappears mid-state. (With a device grant active the reducer
      // leaves an open chat alone: the panel is destroyed below, and the next visit re-mints.)
      if (state.kind !== "decoy") {
        dispatch({ type: "lock", cause: "routeAway" });
      }
      disarmIdleTimer();
      disarmFadeTimer();
      cancelShieldResolve();
      clearSessionTimers();
      grantRequestSeq += 1;
      // With a grant active the reducer leaves an open chat alone above; this panel is gone, so
      // nothing may keep the token.
      session = null;
      screenWatcher.stop();
      chatView?.dispose();
      detachMultiTapListener();
      detachSingleTapListener();
      detachIdlePreferenceListener();
      detachGrantStateListener();
      detachLockSettingsListener();
      for (const off of detachActivityListeners) off();
      win.document.removeEventListener("keydown", onKeyDownForEscape);
      win.document.removeEventListener("visibilitychange", onVisibilityChange);
      win.removeEventListener("pagehide", onPageHide);
      win.removeEventListener("pageshow", onPageShow);
      decoy.teardown();
      pinPad.teardown();
    },
  };
}
