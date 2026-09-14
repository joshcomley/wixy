// The Server chat's settings sheet (spec/server-chat/00-brief.md §10 P5b):
// name, storage used (`/usage`), a push-notification slot P3b mounts its
// toggle into, and a Lock button.

import { getUsage } from "./api/messages";
import type { ServerIdentity } from "./identity";
import type { LockHooks, ServerSession } from "./types";

export interface ServerSettingsSheetDeps {
  identity: ServerIdentity;
  hooks: LockHooks;
  win: Window;
  getSession: () => ServerSession | null;
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

  const pushSlot = documentRef.createElement("div");
  pushSlot.className = "wx-srv-sheet-push-slot";

  const lockButton = documentRef.createElement("button");
  lockButton.type = "button";
  lockButton.className = "wx-srv-sheet-lock";
  lockButton.textContent = "Lock";

  sheet.append(header, nameRow, usageRow, pushSlot, lockButton);
  backdrop.appendChild(sheet);

  function close(): void {
    backdrop.hidden = true;
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
  function onKeydown(evt: KeyboardEvent): void {
    if (evt.key === "Escape" && !backdrop.hidden) close();
  }
  win.document.addEventListener("keydown", onKeydown);

  return {
    element: backdrop,
    pushSlot,
    open(): void {
      backdrop.hidden = false;
      nameInput.value = identity.getName() ?? "";
      usageRow.textContent = "Storage: loading…";
      const session = deps.getSession();
      if (session !== null) {
        getUsage(session)
          .then((usage) => {
            usageRow.textContent = usage.mediaAvailable
              ? `Storage: ${formatBytes(usage.usedBytes)} of ${formatBytes(usage.quotaBytes)} used`
              : "Storage: media isn't available on this server.";
          })
          .catch(() => {
            usageRow.textContent = "Storage: couldn't load.";
          });
      }
      nameInput.focus();
    },
    close,
    teardown(): void {
      win.document.removeEventListener("keydown", onKeydown);
    },
  };
}
