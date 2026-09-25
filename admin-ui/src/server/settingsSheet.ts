// The Server chat's settings sheet (spec/server-chat/00-brief.md §10 P5b):
// name, storage used (`/usage`), a push-notification slot P3b mounts its
// toggle into, and a Lock button. Round 2 adds the per-device lock preferences
// (spec/server-chat/03-permanent-unlock.md): "Keep this device unlocked" with its inline
// PIN pad and "Sign out other devices", and the two "lock when I…" checkboxes (§8).

import { createDeviceGrant, revokeAllDeviceGrants, revokeDeviceGrant, type CreateGrantResult } from "./api/grants";
import { getUsage } from "./api/messages";
import {
  ServerErasureOutcomeUnknownError,
  ServerLockedError,
  ServerWipeAbandonedError,
} from "./api/http";
import { clearDeviceGrant, deviceLabel, onGrantStateChanged, readDeviceGrant, storeDeviceGrant } from "./deviceGrant";
import type { ServerIdentity } from "./identity";
import { isIdleLockExtended, onIdleLockPreferenceChanged, setIdleLockExtended } from "./idlePreference";
import { effectiveLockSettings, type PinError } from "./lockModel";
import { isScreenLockProven, onLockSettingsChanged, readStoredLockSettings, setLockSettings } from "./lockSettings";
import { mountPinPad, type PinPadView } from "./pinPad";
import { isAndroidPushCapable, mountPushToggle, mountUnsupportedPushNotice, type PushToggle } from "./pushToggle";
import { createScreenWatcher, type ScreenWatchStatus } from "./screenWatcher";
import type { LockHooks, ServerSession } from "./types";

export interface ServerSettingsSheetDeps {
  identity: ServerIdentity;
  hooks: LockHooks;
  win: Window;
  getSession: () => ServerSession | null;
  onWipe: (onOutcomeUnknown: () => void) => Promise<boolean>;
  onNameChanged: () => void;
  onClose: () => void;
  document?: Document;
}

export interface ServerSettingsSheetView {
  readonly element: HTMLElement;
  /** The element P3b's push toggle should be mounted into once that parcel
   * lands — present from the first render, always in the DOM (hidden or
   * not is P3b's own call), so no other module here needs to change. */
  readonly pushSlot: HTMLElement;
  open(): void;
  close(): void;
  teardown(): void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const unit = units[unitIndex] ?? "TB";
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${unit}`;
}

/** Gives each mounted sheet's checkbox its own id, so its <label for> always
 * points at its own box even if two sheets ever share a document. */
let idleCheckboxSequence = 0;

export function mountServerSettingsSheet(deps: ServerSettingsSheetDeps): ServerSettingsSheetView {
  const { identity, hooks, win } = deps;
  const documentRef = deps.document ?? document;

  const backdrop = documentRef.createElement("div");
  backdrop.className = "wx-srv-sheet-backdrop";
  backdrop.hidden = true;

  const sheet = documentRef.createElement("div");
  sheet.className = "wx-srv-sheet";
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-label", "Server settings");
  // Focusing a real text input on open pops a phone's soft keyboard the instant the sheet
  // appears, before the owner has chosen to edit anything (operator report, round 2). Standard
  // dialog-open focus practice, and the same pattern pinPad.ts already uses: a `tabIndex=-1`
  // element is programmatically focusable (keeps Escape/focus-trap semantics working, and a
  // screen reader still announces the dialog) but never invites the keyboard, since it isn't
  // text-editable. Tapping into the name field afterwards still focuses and edits it normally.
  sheet.tabIndex = -1;

  const header = documentRef.createElement("div");
  header.className = "wx-srv-sheet-header";
  const heading = documentRef.createElement("h3");
  heading.textContent = "Settings";
  const closeButton = documentRef.createElement("button");
  closeButton.type = "button";
  closeButton.className = "wx-srv-sheet-close";
  closeButton.textContent = "✕";
  closeButton.setAttribute("aria-label", "Close settings");
  header.append(heading, closeButton);

  const nameLabel = documentRef.createElement("label");
  nameLabel.className = "wx-srv-sheet-name-label";
  nameLabel.textContent = "Name";
  const nameInput = documentRef.createElement("input");
  nameInput.type = "text";
  nameInput.className = "wx-srv-sheet-name-input";
  nameInput.maxLength = 32;
  nameLabel.appendChild(nameInput);
  const nameRow = documentRef.createElement("div");
  nameRow.className = "wx-srv-sheet-name-row";
  const saveNameButton = documentRef.createElement("button");
  saveNameButton.type = "button";
  saveNameButton.className = "wx-srv-sheet-save-name";
  saveNameButton.textContent = "Save";
  nameRow.append(nameLabel, saveNameButton);

  // "Extend auto-lock to 1 minute" — a per-DEVICE preference (localStorage,
  // never sent anywhere). The whole row is the <label>, so the tap target is
  // the full row width and at least 44px tall (chat.css).
  const idleLabel = documentRef.createElement("label");
  idleLabel.className = "wx-srv-sheet-idle wx-srv-sheet-idle-row";
  const idleInput = documentRef.createElement("input");
  idleInput.type = "checkbox";
  idleInput.className = "wx-srv-sheet-idle-input";
  idleInput.id = `wx-srv-idle-extended-${++idleCheckboxSequence}`;
  idleLabel.htmlFor = idleInput.id;
  const idleText = documentRef.createElement("span");
  idleText.className = "wx-srv-sheet-idle-text";
  idleText.textContent = "Extend auto-lock to 1 minute";
  idleLabel.append(idleInput, idleText);
  const idleNote = documentRef.createElement("p");
  idleNote.className = "wx-srv-sheet-note wx-srv-sheet-idle-note";
  idleNote.id = `wx-srv-idle-note-${idleCheckboxSequence}`;
  idleNote.setAttribute("role", "status");
  idleNote.hidden = true;
  idleNote.textContent = "Off — nothing to extend while this device is kept unlocked.";
  idleInput.setAttribute("aria-describedby", idleNote.id);

  // -- "Keep this device unlocked" (03-permanent-unlock.md §4) -------------------------------

  const keepGroup = documentRef.createElement("div");
  keepGroup.className = "wx-srv-sheet-keep";
  const keepLabel = documentRef.createElement("label");
  keepLabel.className = "wx-srv-sheet-idle wx-srv-sheet-keep-row";
  const keepInput = documentRef.createElement("input");
  keepInput.type = "checkbox";
  keepInput.className = "wx-srv-sheet-idle-input wx-srv-sheet-keep-input";
  keepInput.id = `wx-srv-keep-unlocked-${idleCheckboxSequence}`;
  keepLabel.htmlFor = keepInput.id;
  const keepText = documentRef.createElement("span");
  keepText.className = "wx-srv-sheet-idle-text";
  keepText.textContent = "Keep this device unlocked";
  keepLabel.append(keepInput, keepText);
  const keepNote = documentRef.createElement("p");
  keepNote.className = "wx-srv-sheet-note wx-srv-sheet-keep-note";
  keepNote.id = `wx-srv-keep-note-${idleCheckboxSequence}`;
  keepNote.setAttribute("role", "status");
  keepNote.hidden = true;
  keepInput.setAttribute("aria-describedby", keepNote.id);
  const keepPadHost = documentRef.createElement("div");
  keepPadHost.className = "wx-srv-sheet-keep-pad";
  keepPadHost.hidden = true;
  const keepPad: PinPadView = mountPinPad({
    win,
    title: "Enter PIN to keep this device unlocked",
    gestureExempt: true,
    onSubmit: (pin) => void submitEnrolment(pin),
    onCancel: () => closeEnrolment(),
  });
  keepPadHost.appendChild(keepPad.element);
  const signOutButton = documentRef.createElement("button");
  signOutButton.type = "button";
  signOutButton.className = "wx-srv-sheet-signout";
  signOutButton.textContent = "Sign out other devices";
  const signOutStatus = documentRef.createElement("p");
  signOutStatus.className = "wx-srv-sheet-note wx-srv-sheet-signout-status";
  signOutStatus.setAttribute("role", "status");
  signOutStatus.hidden = true;
  keepGroup.append(keepLabel, keepNote, keepPadHost, signOutButton, signOutStatus);

  // -- "Lock when I change tab" / "Lock when I lock my screen" (§8) -------------------------

  const lockGroup = documentRef.createElement("div");
  lockGroup.className = "wx-srv-sheet-lockprefs";
  const lockTabLabel = documentRef.createElement("label");
  lockTabLabel.className = "wx-srv-sheet-idle wx-srv-sheet-locktab-row";
  const lockTabInput = documentRef.createElement("input");
  lockTabInput.type = "checkbox";
  lockTabInput.className = "wx-srv-sheet-idle-input wx-srv-sheet-locktab-input";
  lockTabInput.id = `wx-srv-lock-on-tab-${idleCheckboxSequence}`;
  lockTabLabel.htmlFor = lockTabInput.id;
  const lockTabText = documentRef.createElement("span");
  lockTabText.className = "wx-srv-sheet-idle-text";
  lockTabText.textContent = "Lock when I change tab";
  lockTabLabel.append(lockTabInput, lockTabText);
  const lockScreenLabel = documentRef.createElement("label");
  lockScreenLabel.className = "wx-srv-sheet-idle wx-srv-sheet-lockscreen-row";
  const lockScreenInput = documentRef.createElement("input");
  lockScreenInput.type = "checkbox";
  lockScreenInput.className = "wx-srv-sheet-idle-input wx-srv-sheet-lockscreen-input";
  lockScreenInput.id = `wx-srv-lock-on-screen-${idleCheckboxSequence}`;
  lockScreenLabel.htmlFor = lockScreenInput.id;
  const lockScreenText = documentRef.createElement("span");
  lockScreenText.className = "wx-srv-sheet-idle-text";
  lockScreenText.textContent = "Lock when I lock my screen";
  lockScreenLabel.append(lockScreenInput, lockScreenText);
  const lockNote = documentRef.createElement("p");
  lockNote.className = "wx-srv-sheet-note wx-srv-sheet-lockprefs-note";
  lockNote.id = `wx-srv-lockprefs-note-${idleCheckboxSequence}`;
  lockNote.setAttribute("role", "status");
  lockNote.hidden = true;
  lockTabInput.setAttribute("aria-describedby", lockNote.id);
  lockScreenInput.setAttribute("aria-describedby", lockNote.id);
  lockGroup.append(lockTabLabel, lockScreenLabel, lockNote);

  const usageRow = documentRef.createElement("p");
  usageRow.className = "wx-srv-sheet-usage";
  usageRow.textContent = "Storage: loading…";
  const wipeStatus = documentRef.createElement("p");
  wipeStatus.className = "wx-srv-sheet-wipe-status";
  wipeStatus.hidden = true;
  let scrubPollGeneration = 0;
  let scrubPollTimer: number | null = null;
  let pushToggle: PushToggle | null = null;
  let wipeOutcomeUnknown = false;
  /** True from the confirm click until `onWipe` settles. While it is, the thread is still
   * reconciling an unconfirmed wipe and is the only authority on its outcome. */
  let wipeInFlight = false;

  function unmountPushToggle(): void {
    pushToggle?.teardown();
    pushToggle = null;
  }

  function mountPushToggleIfCapable(session: ServerSession | null): void {
    unmountPushToggle();
    if (session === null) return;
    const sender = identity.getName();
    if (sender === null) return;
    if (isAndroidPushCapable(win)) {
      pushToggle = mountPushToggle(pushSlot, {
        deviceId: identity.getDeviceId(),
        sender,
        win,
        getToken: () => deps.getSession()?.token ?? null,
      });
    } else {
      pushToggle = mountUnsupportedPushNotice(pushSlot, win);
    }
  }

  function stopScrubPolling(): void {
    scrubPollGeneration += 1;
    if (scrubPollTimer !== null) {
      win.clearTimeout(scrubPollTimer);
      scrubPollTimer = null;
    }
  }

  function startScrubPolling(session: ServerSession, outcomeUnknown = false): void {
    stopScrubPolling();
    const generation = scrubPollGeneration;
    const stopAt = Date.now() + 60_000;
    wipeStatus.textContent = outcomeUnknown
      ? "Couldn't confirm — checking…"
      : "Deleted. Erasing leftover traces…";
    wipeStatus.hidden = false;

    const poll = (): void => {
      if (generation !== scrubPollGeneration) return;
      if (Date.now() >= stopAt) {
        if (outcomeUnknown) settleUnknownWipeAsUnclear();
        return;
      }
      scrubPollTimer = win.setTimeout(() => {
        scrubPollTimer = null;
        void getUsage(session)
          .then((usage) => {
            if (generation !== scrubPollGeneration) return;
            if (!usage.erasurePending) {
              if (outcomeUnknown) settleUnknownWipeAsUnclear();
              else wipeStatus.textContent = "Done";
              return;
            }
            poll();
          })
          .catch(() => poll());
      }, 1000);
    };
    poll();
  }

  /** The sheet's own way out of an unconfirmed wipe when nothing is reconciling it (an
   * `onWipe` that rejected with `ServerErasureOutcomeUnknownError` and has no thread behind
   * it): say so honestly and hand the decision back to the owner instead of leaving the
   * control disabled for good (F16). A wipe is still never re-sent on its own — the owner
   * has to confirm it again. */
  function unknownWipeNeedsCheck(): boolean {
    return wipeOutcomeUnknown && !wipeInFlight;
  }

  function settleUnknownWipeAsUnclear(): void {
    if (wipeInFlight) return; // the thread is still reconciling — it decides, not this poll
    wipeOutcomeUnknown = false;
    wipeButton.disabled = false;
    wipeStatus.textContent = "Status unclear. Check the messages to confirm.";
    wipeStatus.hidden = false;
  }

  function announceWipeOutcomeUnknown(): void {
    wipeOutcomeUnknown = true;
    wipeConfirmation.hidden = true;
    wipeButton.disabled = true;
    wipeStatus.textContent = "Couldn't confirm — checking…";
    wipeStatus.hidden = false;
  }

  const pushSlot = documentRef.createElement("div");
  pushSlot.className = "wx-srv-sheet-push-slot";

  const lockButton = documentRef.createElement("button");
  lockButton.type = "button";
  lockButton.className = "wx-srv-sheet-lock";
  lockButton.textContent = "Lock";

  const wipeButton = documentRef.createElement("button");
  wipeButton.type = "button";
  wipeButton.className = "wx-srv-sheet-wipe";
  wipeButton.textContent = "Delete all messages";
  wipeButton.dataset["srvGestureBoundary"] = "";

  const wipeConfirmation = documentRef.createElement("div");
  wipeConfirmation.className = "wx-srv-sheet-wipe-confirm";
  wipeConfirmation.hidden = true;
  const wipeQuestion = documentRef.createElement("p");
  wipeQuestion.textContent =
    "Delete every message, photo, video and voice note for everyone? This can't be undone.";
  const wipeError = documentRef.createElement("p");
  wipeError.className = "wx-srv-sheet-wipe-error";
  wipeError.hidden = true;
  const wipeConfirmButtons = documentRef.createElement("div");
  wipeConfirmButtons.className = "wx-srv-sheet-wipe-buttons";
  const wipeConfirmButton = documentRef.createElement("button");
  wipeConfirmButton.type = "button";
  wipeConfirmButton.className = "wx-srv-sheet-wipe-confirm-button";
  wipeConfirmButton.textContent = "Delete everything";
  const wipeCancelButton = documentRef.createElement("button");
  wipeCancelButton.type = "button";
  wipeCancelButton.className = "wx-srv-sheet-wipe-cancel";
  wipeCancelButton.textContent = "Cancel";
  wipeConfirmButtons.append(wipeConfirmButton, wipeCancelButton);
  wipeConfirmation.append(wipeQuestion, wipeError, wipeConfirmButtons);

  sheet.append(
    header,
    nameRow,
    usageRow,
    wipeStatus,
    pushSlot,
    idleLabel,
    idleNote,
    keepGroup,
    lockGroup,
    wipeButton,
    wipeConfirmation,
    lockButton,
  );
  backdrop.appendChild(sheet);

  // -- Keep this device unlocked: behaviour -------------------------------------------------

  /** The inline PIN pad is open (or its request is in flight): the box shows ticked without
   * anything having been stored yet. */
  let enrolling = false;
  let enrolmentSeq = 0;

  function syncKeepRow(): void {
    const on = readDeviceGrant(win) !== null;
    if (!enrolling) keepInput.checked = on;
    keepNote.hidden = !on || enrolling;
    keepNote.textContent = on
      ? "On · Lock with the ✕ or a double-tap. Turning this off locks the chat — you'll need the PIN next time."
      : "";
    // With the device kept unlocked there is no idle period left to extend.
    idleInput.disabled = on;
    idleLabel.classList.toggle("wx-srv-sheet-row-disabled", on);
    idleNote.hidden = !on;
  }

  function openEnrolment(): void {
    enrolling = true;
    keepPad.reset();
    keepPadHost.hidden = false;
    keepInput.checked = true;
    keepNote.hidden = true;
    keepPad.focus();
  }

  function closeEnrolment(): void {
    enrolmentSeq += 1;
    enrolling = false;
    keepPadHost.hidden = true;
    keepPad.reset();
    syncKeepRow();
  }

  function padErrorFor(result: Exclude<CreateGrantResult, { readonly ok: true }>): PinError {
    switch (result.kind) {
      case "wrongPin":
        return { kind: "wrong", attemptsLeft: result.attemptsLeft };
      case "lockedOut":
        return { kind: "lockedOut", retryAfterS: result.retryAfterS };
      case "pinChanged":
        return { kind: "pinChanged" };
      case "invalid":
        return { kind: "invalid" };
      case "unexpected":
        return { kind: "unexpected" };
      case "unavailable":
        return { kind: "unavailable" };
    }
  }

  async function submitEnrolment(pin: string): Promise<void> {
    const session = deps.getSession();
    if (session === null) {
      closeEnrolment();
      return;
    }
    const seq = ++enrolmentSeq;
    keepPad.setBusy(true);
    let result: CreateGrantResult;
    try {
      result = await createDeviceGrant(session, pin, deviceLabel(win));
    } catch (error) {
      if (seq !== enrolmentSeq) return;
      keepPad.setBusy(false);
      if (error instanceof ServerLockedError) {
        hooks.lockNow("unauthorized");
        return;
      }
      keepPad.setError({ kind: "unavailable" });
      return;
    }
    if (seq !== enrolmentSeq) {
      // Cancelled (or the sheet closed) while the request was out, and the server said yes
      // anyway: nothing was stored here, so do not leave a grant behind that no device holds.
      if (result.ok) void revokeDeviceGrant(session, result.grant.grantId).catch(() => {});
      return;
    }
    keepPad.setBusy(false);
    if (!result.ok) {
      keepPad.setError(padErrorFor(result));
      return;
    }
    if (!storeDeviceGrant(win, result.grant)) {
      // The browser would not keep it: say so, and do not leave a grant on the server that
      // this device cannot use.
      void revokeDeviceGrant(session, result.grant.grantId).catch(() => {});
      keepPad.setError({ kind: "unexpected" });
      return;
    }
    // §9 (audit F4 ruling): adopt the BOUND token this route itself returns, so the live
    // session actually becomes the one just bound — otherwise "Sign out other devices" called
    // moments later (with no reload in between) would still see the old, unbound caller and
    // spare nothing, the just-created grant included.
    hooks.adoptBoundSession({ token: result.token, expiresAt: result.expiresAt }, result.grant.grantId);
    closeEnrolment();
  }

  function turnKeepOff(): void {
    const grant = readDeviceGrant(win);
    const session = deps.getSession();
    // Local first: forgetting the grant is what makes the automatic locks resume, and it
    // must happen even if the server cannot be reached (its 30-day expiry mops up).
    clearDeviceGrant(win);
    syncKeepRow();
    // §9 (audit F4 ruling, spec §9 point 8): turning the setting off locks the chat AT ONCE,
    // on purpose — the row's own note says so. The server never re-mints a replacement token
    // on revoke, so there is nothing here that could undo this by minting a fresh one.
    hooks.lockNow("grantOff");
    if (grant === null || session === null) return;
    void revokeDeviceGrant(session, grant.grantId).catch((error: unknown) => {
      if (error instanceof ServerLockedError) hooks.lockNow("unauthorized");
    });
  }

  keepInput.addEventListener("change", () => {
    if (keepInput.checked) openEnrolment();
    else if (enrolling) closeEnrolment();
    else turnKeepOff();
  });

  signOutButton.addEventListener("click", () => {
    const session = deps.getSession();
    if (session === null) return;
    // §9.7 (audit F8 fix): capture what the server will actually use for its except_grant_id
    // decision — the binding AT SEND TIME, not whatever it happens to be when the response
    // lands. A tryBindStoredGrant exchange (or a panic/lock) racing the in-flight request must
    // not change which grant this handler decides was spared.
    const boundAtSend = hooks.getBoundGrantId();
    signOutButton.disabled = true;
    signOutStatus.hidden = false;
    signOutStatus.textContent = "Signing out…";
    void revokeAllDeviceGrants(session)
      .then(() => {
        // §9.7 (audit F7 fix): the server spares the caller's grant ONLY when the caller's own
        // token is bound to it — never merely because this device happens to have one stored.
        // If THIS device's live session was not actually bound (a still-pending or failed
        // exchange, or a stale second tab), the server just revoked this device's grant along
        // with everyone else's — keep the local keys only when they still match what the
        // server actually spared, and forget them otherwise.
        const stored = readDeviceGrant(win);
        const wasSpared = boundAtSend !== null && boundAtSend === stored?.grantId;
        if (!wasSpared) {
          clearDeviceGrant(win);
          syncKeepRow();
        }
        signOutStatus.textContent = "Done — the other devices are signed out.";
      })
      .catch((error: unknown) => {
        if (error instanceof ServerLockedError) {
          hooks.lockNow("unauthorized");
          return;
        }
        signOutStatus.textContent = "Couldn't sign the other devices out — try again.";
      })
      .finally(() => {
        signOutButton.disabled = false;
      });
  });

  // -- Lock when I change tab / lock my screen: behaviour ----------------------------------

  // The sheet has its own watcher only to read and request the permission; the panel owns the
  // one that actually listens, and starts it when this announces the settings changed.
  const screenWatcher = createScreenWatcher(win);
  let screenStatus: ScreenWatchStatus = screenWatcher.supported ? "prompt" : "unsupported";

  function syncLockRows(): void {
    const distinct = screenStatus === "granted";
    const shown = effectiveLockSettings(readStoredLockSettings(win), distinct);
    lockTabInput.checked = shown.lockOnTab;
    lockScreenInput.checked = shown.lockOnScreen;
    const canDistinguish = screenStatus === "granted" || screenStatus === "prompt";
    lockScreenInput.disabled = !canDistinguish;
    lockScreenLabel.classList.toggle("wx-srv-sheet-row-disabled", !canDistinguish);
    if (!canDistinguish) {
      lockNote.textContent =
        "This browser can't tell a screen lock from a tab switch, so both follow 'Lock when I change tab'.";
      lockNote.hidden = false;
    } else if (distinct && !shown.lockOnTab && shown.lockOnScreen && !isScreenLockProven(win)) {
      lockNote.textContent =
        "Lock your screen once so this phone can learn to tell a screen lock from a tab switch — until then, switching away also locks.";
      lockNote.hidden = false;
    } else {
      lockNote.textContent = "";
      lockNote.hidden = true;
    }
  }

  function refreshScreenStatus(): void {
    void screenWatcher.status().then((status) => {
      screenStatus = status;
      syncLockRows();
    });
  }

  function onLockBoxChanged(changed: "tab" | "screen"): void {
    const before = effectiveLockSettings(readStoredLockSettings(win), screenStatus === "granted");
    const next = {
      lockOnTab: changed === "tab" ? lockTabInput.checked : before.lockOnTab,
      lockOnScreen: changed === "screen" ? lockScreenInput.checked : before.lockOnScreen,
    };
    if (screenStatus === "granted" || next.lockOnTab === next.lockOnScreen) {
      // Either the browser can tell the two apart, or the boxes agree and nothing needs to.
      setLockSettings(win, next);
      syncLockRows();
      return;
    }
    if (screenStatus === "prompt") {
      // The owner just made the two differ: only now is the permission worth asking for.
      // Called straight from the tap (no await before it), which the browser requires.
      void screenWatcher.requestPermission().then((status) => {
        screenStatus = status;
        if (status === "granted") setLockSettings(win, next);
        else {
          // Denied: the two follow the tab box, as they do in a browser without the API.
          const follow = changed === "tab" ? next.lockOnTab : before.lockOnTab;
          setLockSettings(win, { lockOnTab: follow, lockOnScreen: follow });
        }
        syncLockRows();
      });
      return;
    }
    // Unsupported or denied: the screen box is disabled, so only the tab box moves both.
    setLockSettings(win, { lockOnTab: next.lockOnTab, lockOnScreen: next.lockOnTab });
    syncLockRows();
  }
  lockTabInput.addEventListener("change", () => onLockBoxChanged("tab"));
  lockScreenInput.addEventListener("change", () => onLockBoxChanged("screen"));

  const detachGrantStateListener = onGrantStateChanged(win, syncKeepRow);
  const detachLockSettingsListener = onLockSettingsChanged(win, syncLockRows);

  function close(): void {
    closeEnrolment();
    backdrop.hidden = true;
    wipeConfirmation.hidden = true;
    wipeStatus.hidden = !wipeOutcomeUnknown;
    stopScrubPolling();
    unmountPushToggle();
    deps.onClose();
  }

  function saveName(): void {
    const trimmed = nameInput.value.trim();
    if (trimmed === "") return;
    identity.setName(trimmed);
    nameInput.value = identity.getName() ?? "";
    deps.onNameChanged();
  }

  closeButton.addEventListener("click", close);
  backdrop.addEventListener("click", (evt) => {
    if (evt.target === backdrop) close();
  });
  saveNameButton.addEventListener("click", saveName);
  idleInput.addEventListener("change", () => setIdleLockExtended(win, idleInput.checked));
  // The box always shows what is actually stored: this also re-syncs it after a
  // refused write (it snaps back), and follows a change made in another tab of
  // this device while the sheet is open — a stale UNTICKED box over an active 60s
  // lock is the one direction that would mislead the owner.
  const detachIdlePreferenceListener = onIdleLockPreferenceChanged(win, () => {
    idleInput.checked = isIdleLockExtended(win);
  });
  nameInput.addEventListener("keydown", (evt) => {
    if (evt.key === "Enter") saveName();
  });
  lockButton.addEventListener("click", () => {
    close();
    hooks.lockNow("panic");
  });
  wipeButton.addEventListener("click", () => {
    wipeError.hidden = true;
    wipeConfirmation.hidden = false;
    wipeConfirmButton.focus();
  });
  wipeCancelButton.addEventListener("click", () => {
    wipeConfirmation.hidden = true;
  });
  wipeConfirmButton.addEventListener("click", () => {
    if (wipeOutcomeUnknown) return;
    wipeConfirmButton.disabled = true;
    wipeInFlight = true;
    void deps.onWipe(announceWipeOutcomeUnknown)
      .then((erasurePending) => {
        wipeOutcomeUnknown = false;
        wipeButton.disabled = false;
        if (erasurePending) {
          wipeConfirmation.hidden = true;
          const session = deps.getSession();
          if (session !== null) startScrubPolling(session);
          return;
        }
        wipeStatus.hidden = true;
        close();
      })
      .catch((error: unknown) => {
        if (error instanceof ServerLockedError) {
          // Same reset as an abandoned reconciliation: the next unlock finds a normal
          // sheet, not a wipe control stuck on "checking" (L4).
          wipeOutcomeUnknown = false;
          wipeButton.disabled = false;
          wipeStatus.hidden = true;
          hooks.lockNow("unauthorized");
          return;
        }
        if (error instanceof ServerErasureOutcomeUnknownError) {
          announceWipeOutcomeUnknown();
          const session = deps.getSession();
          if (session !== null) startScrubPolling(session, true);
          return;
        }
        wipeOutcomeUnknown = false;
        wipeButton.disabled = false;
        wipeStatus.hidden = true;
        if (error instanceof ServerWipeAbandonedError) {
          // The chat locked before the outcome was confirmed. Nothing failed: the next
          // unlock reloads the real history, so the control just goes back to normal.
          return;
        }
        wipeConfirmation.hidden = false;
        wipeError.textContent = "Couldn't delete everything — try again";
        wipeError.hidden = false;
      })
      .finally(() => {
        wipeInFlight = false;
        wipeConfirmButton.disabled = false;
      });
  });
  function onKeydown(evt: KeyboardEvent): void {
    if (evt.key === "Escape" && !backdrop.hidden) close();
  }
  win.document.addEventListener("keydown", onKeydown);

  return {
    element: backdrop,
    pushSlot,
    open(): void {
      stopScrubPolling();
      backdrop.hidden = false;
      wipeConfirmation.hidden = true;
      wipeError.hidden = true;
      wipeStatus.hidden = !wipeOutcomeUnknown;
      nameInput.value = identity.getName() ?? "";
      idleInput.checked = isIdleLockExtended(win);
      signOutStatus.hidden = true;
      syncKeepRow();
      syncLockRows();
      refreshScreenStatus();
      usageRow.textContent = "Storage: loading…";
      const session = deps.getSession();
      mountPushToggleIfCapable(session);
      if (session !== null) {
        getUsage(session)
          .then((usage) => {
            usageRow.textContent = usage.mediaAvailable
              ? `Storage: ${formatBytes(usage.usedBytes)} of ${formatBytes(usage.quotaBytes)} used`
              : "Storage: media isn't available on this server.";
            // An unconfirmed wipe with nothing reconciling it must be re-checked on every
            // open, or closing the sheet mid-check would strand the wipe control (F16).
            if (usage.erasurePending || unknownWipeNeedsCheck()) {
              const session = deps.getSession();
              if (session !== null) startScrubPolling(session, wipeOutcomeUnknown);
            }
          })
          .catch(() => {
            usageRow.textContent = "Storage: couldn't load.";
            if (unknownWipeNeedsCheck()) startScrubPolling(session, true);
          });
      }
      sheet.focus();
    },
    close,
    teardown(): void {
      detachIdlePreferenceListener();
      detachGrantStateListener();
      detachLockSettingsListener();
      keepPad.teardown();
      stopScrubPolling();
      unmountPushToggle();
      win.document.removeEventListener("keydown", onKeydown);
    },
  };
}
