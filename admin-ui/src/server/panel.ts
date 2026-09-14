// The "Server" panel's orchestrator (spec/server-chat/00-brief.md §6, R2
// v1.3 per operator decision #974): wires the pure `lockModel` reducer to
// real timers, BOTH gesture detectors (a single tap anywhere in the panel
// reveals the decoy's affordance; a multi-tap inside the chat view locks,
// R3 — see gestures.ts), R7's activity/suspension bookkeeping, and the
// decoy/pin-pad/chat views. This is the ONLY module that touches the DOM
// event loop, `fetch`, or `setTimeout` for the lock machine — every decision
// about WHAT state comes next lives in `lockModel.ts` instead, so it can be
// tested without any of this.

import type { AdminApi } from "../api";
import { unlock } from "./api/unlock";
import { FADE_MS, IDLE_LOCK_MS, MULTI_TAP_INTERVAL_MS, PICKER_SUSPEND_MAX_MS } from "./constants";
import { mountDecoy, type DecoyView } from "./decoy";
import { attachMultiTapListener, attachTapListener, createMultiTapDetector, createTapDetector } from "./gestures";
import { INITIAL_STATE, reduce, type LockEffect, type LockEvent, type LockState } from "./lockModel";
import { mountPinPad, type PinPadView } from "./pinPad";
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

function stubServerChatView(): ServerChatView {
  const element = document.createElement("div");
  // `.wx-srv-thread` matches the class P5's real thread view will use
  // (§11's e2e matrix asserts its absence from the DOM after a lock) — the
  // stub honours the same contract so this panel's own detach behaviour is
  // meaningfully testable today, and stays correct once the real view
  // replaces this factory.
  element.className = "wx-srv-chat-stub wx-srv-thread";
  element.textContent = "Server chat is coming soon.";
  return {
    element,
    attach(): void {},
    detach(): void {},
    dispose(): void {},
  };
}

export function mountServerPanel(deps: ServerPanelDeps): ServerPanel {
  const win = deps.win ?? window;
  const createChatView = deps.createServerChatView ?? stubServerChatView;

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
  let fadeTimer: ReturnType<typeof win.setTimeout> | null = null;
  let expiryTimer: ReturnType<typeof win.setTimeout> | null = null;

  function fireIdle(): void {
    idleTimer = null;
    dispatch({ type: "lock", cause: "idle" });
  }

  function armIdleTimer(): void {
    idleTimerArmed = true;
    if (idleTimer !== null) {
      win.clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (totalSuspensionCount > 0) return; // stays paused — see `release()` below
    idleTimer = win.setTimeout(fireIdle, IDLE_LOCK_MS);
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

  function armExpiryTimer(expiresAtEpochS: number): void {
    clearExpiryTimer();
    const delayMs = expiresAtEpochS * 1000 - Date.now();
    expiryTimer = win.setTimeout(() => dispatch({ type: "lock", cause: "expired" }), Math.max(0, delayMs));
  }

  function clearExpiryTimer(): void {
    if (expiryTimer !== null) {
      win.clearTimeout(expiryTimer);
      expiryTimer = null;
    }
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
    if (state.kind === "decoy") {
      // R4/R6: nothing sensitive survives a return to the decoy — the token
      // is discarded and the expiry timer has nothing left to guard.
      session = null;
      clearExpiryTimer();
    }
  }

  function dispatch(event: LockEvent): void {
    const previousKind = state.kind;
    const result = reduce(state, event, Date.now());
    state = result.state;
    if (previousKind === "decoy" && result.state.kind === "revealed") {
      // Stamped here, not inside `reduce` (a pure function with no clock of
      // its own) — see the affordance click handler's debounce. Reads
      // `result.state.kind` rather than the just-reassigned `state.kind`
      // (equivalent value) so this check reads cleanly regardless of when
      // the reassignment above happened.
      revealedAtMs = win.performance.now();
    }
    render();
    applyEffects(result.effects);
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
      dispatch({ type: "lock", cause });
    },
  };

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
        armExpiryTimer(result.expiresAt);
        dispatch({ type: "verifyOk" });
        return;
      }
      if (result.kind === "wrongPin") {
        dispatch({ type: "verifyWrong", attemptsLeft: result.attemptsLeft });
      } else if (result.kind === "lockedOut") {
        dispatch({ type: "verifyLockedOut", retryAfterS: result.retryAfterS });
      } else {
        dispatch({ type: "verifyUnavailable" });
      }
    });
  }

  // -- Gestures + document-level listeners (R2 v1.3, R3, R6, R7) ------------------

  // R3 (unchanged): a multi-tap ANYWHERE while the panel is mounted — only
  // "chat"/"fading" give the resulting event any meaning (lockModel.ts).
  const multiTapDetector = createMultiTapDetector(
    () => dispatch({ type: "multiTap" }),
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
    if (event.key === "Escape") dispatch({ type: "lock", cause: "escape" });
  }
  win.document.addEventListener("keydown", onKeyDownForEscape);

  function onVisibilityChange(): void {
    if (win.document.visibilityState !== "hidden") return;
    if (isPickerOrMicOpen()) return;
    dispatch({ type: "lock", cause: "hidden" });
  }
  win.document.addEventListener("visibilitychange", onVisibilityChange);

  render();

  return {
    element: root,
    teardown(): void {
      // Routing away from `/admin/server` is itself one of R6's lock causes
      // — run it through the reducer (rather than skipping straight to
      // cleanup) so a mid-chat departure still detaches/aborts/pauses
      // correctly, not just disappears mid-state.
      if (state.kind !== "decoy") {
        dispatch({ type: "lock", cause: "routeAway" });
      }
      disarmIdleTimer();
      disarmFadeTimer();
      clearExpiryTimer();
      chatView?.dispose();
      detachMultiTapListener();
      detachSingleTapListener();
      for (const off of detachActivityListeners) off();
      win.document.removeEventListener("keydown", onKeyDownForEscape);
      win.document.removeEventListener("visibilitychange", onVisibilityChange);
      decoy.teardown();
      pinPad.teardown();
    },
  };
}
