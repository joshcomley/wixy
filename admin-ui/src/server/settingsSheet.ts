// The Server chat's settings sheet (spec/server-chat/00-brief.md §10 P5b):
// name, storage used (`/usage`), a push-notification slot P3b mounts its
// toggle into, and a Lock button.

import { getUsage } from "./api/messages";
import { ServerErasureOutcomeUnknownError, ServerLockedError } from "./api/http";
import type { ServerIdentity } from "./identity";
import { isAndroidPushCapable, mountPushToggle, type PushToggle } from "./pushToggle";
import type { LockHooks, ServerSession } from "./types";

export interface ServerSettingsSheetDeps {
  identity: ServerIdentity;
  hooks: LockHooks;
  win: Window;
  getSession: () => ServerSession | null;
  onWipe: () => Promise<boolean>;
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

  function unmountPushToggle(): void {
    pushToggle?.teardown();
    pushToggle = null;
  }

  function mountPushToggleIfCapable(session: ServerSession | null): void {
    unmountPushToggle();
    if (session === null || !isAndroidPushCapable(win)) return;
    const sender = identity.getName();
    if (sender === null) return;
    pushToggle = mountPushToggle(pushSlot, {
      deviceId: identity.getDeviceId(),
      sender,
      win,
      getToken: () => deps.getSession()?.token ?? null,
    });
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
      ? "Still working — check again."
      : "Deleted. Erasing leftover traces…";
    wipeStatus.hidden = false;

    const poll = (): void => {
      if (generation !== scrubPollGeneration || Date.now() >= stopAt) return;
      scrubPollTimer = win.setTimeout(() => {
        scrubPollTimer = null;
        void getUsage(session)
          .then((usage) => {
            if (generation !== scrubPollGeneration) return;
            if (!usage.erasurePending) {
              wipeStatus.textContent = outcomeUnknown
                ? "Status unclear. Check the messages to confirm."
                : "Done";
              return;
            }
            poll();
          })
          .catch(() => poll());
      }, 1000);
    };
    poll();
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

  sheet.append(header, nameRow, usageRow, wipeStatus, pushSlot, wipeButton, wipeConfirmation, lockButton);
  backdrop.appendChild(sheet);

  function close(): void {
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
    void deps.onWipe()
      .then((erasurePending) => {
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
          hooks.lockNow("unauthorized");
          return;
        }
        if (error instanceof ServerErasureOutcomeUnknownError) {
          wipeOutcomeUnknown = true;
          wipeConfirmation.hidden = true;
          wipeButton.disabled = true;
          const session = deps.getSession();
          if (session !== null) startScrubPolling(session, true);
          else {
            wipeStatus.textContent = "Still working — check again.";
            wipeStatus.hidden = false;
          }
          return;
        }
        wipeError.textContent = "Couldn't delete messages. Try again.";
        wipeError.hidden = false;
      })
      .finally(() => {
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
      usageRow.textContent = "Storage: loading…";
      const session = deps.getSession();
      mountPushToggleIfCapable(session);
      if (session !== null) {
        getUsage(session)
          .then((usage) => {
            usageRow.textContent = usage.mediaAvailable
              ? `Storage: ${formatBytes(usage.usedBytes)} of ${formatBytes(usage.quotaBytes)} used`
              : "Storage: media isn't available on this server.";
            if (usage.erasurePending) {
              const session = deps.getSession();
              if (session !== null) startScrubPolling(session, wipeOutcomeUnknown);
            }
          })
          .catch(() => {
            usageRow.textContent = "Storage: couldn't load.";
          });
      }
      nameInput.focus();
    },
    close,
    teardown(): void {
      stopScrubPolling();
      unmountPushToggle();
      win.document.removeEventListener("keydown", onKeydown);
    },
  };
}
