// The `CreateServerChatView` factory (spec/server-chat/00-brief.md §6/§10
// P5b) — `panel.ts` (P4) calls this exactly once, the first time the lock
// state machine reaches "chat", and keeps the returned view alive across
// every later lock/unlock cycle within the same panel mount. This module is
// a thin gate: the first-unlock name prompt, then the message thread
// (thread.ts) and its live stream (stream.ts), plus the settings sheet.

import { ServerLockedError } from "./api/http";
import { createServerIdentity } from "./identity";
import { mountServerSettingsSheet } from "./settingsSheet";
import { openServerStream, type ServerStreamHandle } from "./stream";
import { mountServerThread } from "./thread";
import type { CreateServerChatView, ServerSession } from "./types";

export const createServerChatView: CreateServerChatView = (deps) => {
  const { hooks, win } = deps;
  const identity = createServerIdentity(win);

  const element = document.createElement("div");
  element.className = "wx-srv-chat";

  // -- First-unlock name prompt (types.ts: "a name sub-step inside 'chat'") --

  const namePrompt = document.createElement("div");
  namePrompt.className = "wx-srv-name-prompt";
  namePrompt.hidden = true;
  const namePromptTitle = document.createElement("h3");
  namePromptTitle.textContent = "What should we call you?";
  const namePromptInput = document.createElement("input");
  namePromptInput.type = "text";
  namePromptInput.className = "wx-srv-name-prompt-input";
  namePromptInput.maxLength = 32;
  namePromptInput.placeholder = "Your name";
  namePromptInput.setAttribute("aria-label", "Your name");
  const namePromptButton = document.createElement("button");
  namePromptButton.type = "button";
  namePromptButton.className = "wx-srv-name-prompt-button";
  namePromptButton.textContent = "Continue";
  namePrompt.append(namePromptTitle, namePromptInput, namePromptButton);
  element.appendChild(namePrompt);

  let pendingSessionForNamePrompt: ServerSession | null = null;

  function commitName(): void {
    const value = namePromptInput.value.trim();
    if (value === "") return;
    identity.setName(value);
    thread.refreshNameChip();
    namePrompt.hidden = true;
    const session = pendingSessionForNamePrompt;
    pendingSessionForNamePrompt = null;
    if (session !== null) showThreadAndConnect(session);
  }
  namePromptButton.addEventListener("click", commitName);
  namePromptInput.addEventListener("keydown", (evt) => {
    if (evt.key === "Enter") commitName();
  });

  // -- Thread + settings sheet -------------------------------------------------

  const thread = mountServerThread({
    identity,
    hooks,
    win,
    onSettings: () => settingsSheet.open(),
  });
  thread.element.hidden = true; // shown once a name exists and attach() runs
  element.appendChild(thread.element);

  let currentSession: ServerSession | null = null;

  const settingsSheet = mountServerSettingsSheet({
    identity,
    hooks,
    win,
    getSession: () => currentSession,
    onWipe: () => thread.wipe(),
    onNameChanged: () => thread.refreshNameChip(),
    onClose: () => {},
  });
  element.appendChild(settingsSheet.element);

  // -- Stream lifecycle ----------------------------------------------------

  let streamHandle: ServerStreamHandle | null = null;
  let resumeCursor = 0;

  function openStream(session: ServerSession): void {
    streamHandle = openServerStream(
      session,
      resumeCursor,
      (event) => {
        if (event.type === "locked") {
          hooks.lockNow("unauthorized");
          return;
        }
        thread.handleStreamEvent(event);
      },
      { win },
    );
  }

  function closeStream(): void {
    if (streamHandle === null) return;
    resumeCursor = streamHandle.getCursor();
    streamHandle.close();
    streamHandle = null;
  }

  function showThreadAndConnect(session: ServerSession): void {
    thread.element.hidden = false;
    thread
      .attach(session)
      .then((freshCursor) => {
        if (freshCursor !== null) resumeCursor = freshCursor;
        openStream(session);
      })
      .catch((error: unknown) => {
        if (error instanceof ServerLockedError) hooks.lockNow("unauthorized");
      });
  }

  return {
    element,
    attach(session: ServerSession): void {
      currentSession = session;
      if (identity.getName() === null) {
        pendingSessionForNamePrompt = session;
        thread.element.hidden = true;
        namePrompt.hidden = false;
        namePromptInput.value = "";
        namePromptInput.focus();
        return;
      }
      namePrompt.hidden = true;
      showThreadAndConnect(session);
    },
    detach(): void {
      currentSession = null;
      pendingSessionForNamePrompt = null;
      closeStream();
      thread.detach();
      settingsSheet.close();
    },
    dispose(): void {
      closeStream();
      thread.teardown();
      settingsSheet.teardown();
    },
  };
};
