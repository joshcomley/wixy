import type { Message } from "./api/messages";
import { REACTION_EMOJIS, reactionLabel } from "./reactions";

const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_PX = 10;

export interface MessageActionsDeps {
  readonly message: Message;
  readonly bubble: HTMLElement;
  readonly win: Window;
  readonly document?: Document;
  readonly onDelete: (message: Message) => Promise<void>;
  /** The reader tapped an emoji in the menu's reaction row (the thread decides whether
   * that adds or removes their reaction). */
  readonly onReact: (message: Message, emoji: string) => void;
  /** Whether the reader currently holds `emoji` on `message` — drives each emoji's checked state. */
  readonly isReacted: (message: Message, emoji: string) => boolean;
}

export interface MessageActionsController {
  close(): void;
  /** The message changed in place (a reaction landed): refresh the emoji row without
   * closing an open menu. */
  update(message: Message): void;
  teardown(): void;
}

/** Adds the desktop menu and touch long-press action sheet to one message bubble. */
export function mountMessageActions(deps: MessageActionsDeps): MessageActionsController {
  const { bubble, win } = deps;
  let message = deps.message;
  const documentRef = deps.document ?? document;
  const trigger = documentRef.createElement("button");
  trigger.type = "button";
  trigger.className = "wx-srv-message-actions-trigger";
  trigger.textContent = "⋯";
  trigger.setAttribute("aria-label", "Message actions");
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  trigger.dataset["srvGestureBoundary"] = "";

  const menu = documentRef.createElement("div");
  menu.className = "wx-srv-message-actions";
  menu.setAttribute("role", "menu");
  menu.hidden = true;

  const actions = documentRef.createElement("div");
  actions.className = "wx-srv-message-actions-list";
  const confirmation = documentRef.createElement("div");
  confirmation.className = "wx-srv-message-delete-confirm";
  confirmation.hidden = true;

  const copyError = documentRef.createElement("p");
  copyError.className = "wx-srv-message-action-error";
  copyError.hidden = true;
  let deleteButton: HTMLButtonElement | null = null;

  // The reaction row. Each emoji is opened by the tap that opened this menu, so it is a
  // causal flow and carries the gesture boundary (R3 v1.5.2) — unlike a reaction chip, which
  // is an independent control.
  const picker = documentRef.createElement("div");
  picker.className = "wx-srv-message-reactions-picker";
  picker.setAttribute("role", "group");
  picker.setAttribute("aria-label", "React to this message");
  const pickerButtons: HTMLButtonElement[] = [];
  for (const emoji of REACTION_EMOJIS) {
    const button = documentRef.createElement("button");
    button.type = "button";
    button.className = "wx-srv-message-react";
    button.dataset["reaction"] = emoji;
    button.textContent = emoji;
    button.setAttribute("role", "menuitemcheckbox");
    button.setAttribute("aria-label", reactionLabel(emoji));
    button.dataset["srvGestureBoundary"] = "";
    button.addEventListener("click", () => {
      deps.onReact(message, emoji);
      close();
    });
    pickerButtons.push(button);
    picker.appendChild(button);
  }
  function syncPicker(): void {
    for (const button of pickerButtons) {
      const reacted = deps.isReacted(message, button.dataset["reaction"] ?? "");
      button.setAttribute("aria-checked", String(reacted));
      button.classList.toggle("wx-srv-message-react-on", reacted);
    }
  }
  syncPicker();

  function close(): void {
    menu.hidden = true;
    confirmation.hidden = true;
    actions.hidden = false;
    trigger.setAttribute("aria-expanded", "false");
    bubble.classList.remove("wx-srv-message-actions-open");
  }

  function open(): void {
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    bubble.classList.add("wx-srv-message-actions-open");
  }

  actions.appendChild(picker);

  if (message.text !== null && message.text !== "") {
    const copy = documentRef.createElement("button");
    copy.type = "button";
    copy.className = "wx-srv-message-action-copy";
    copy.textContent = "Copy text";
    copy.setAttribute("role", "menuitem");
    copy.addEventListener("click", () => {
      const clipboard = win.navigator.clipboard;
      if (clipboard === undefined) {
        copyError.textContent = "Copying isn't available on this device.";
        copyError.hidden = false;
        return;
      }
      void clipboard.writeText(message.text ?? "").then(close).catch(() => {
        copyError.textContent = "Couldn't copy the message.";
        copyError.hidden = false;
      });
    });
    actions.appendChild(copy);
  }

  const remove = documentRef.createElement("button");
  remove.type = "button";
  remove.className = "wx-srv-message-action-delete";
  remove.textContent = "Delete for everyone";
  remove.setAttribute("role", "menuitem");
  remove.dataset["srvGestureBoundary"] = "";
  remove.addEventListener("click", () => {
    actions.hidden = true;
    confirmation.hidden = false;
    deleteButton?.focus();
  });
  actions.appendChild(remove);

  const cancel = documentRef.createElement("button");
  cancel.type = "button";
  cancel.className = "wx-srv-message-action-cancel";
  cancel.textContent = "Cancel";
  cancel.setAttribute("role", "menuitem");
  cancel.addEventListener("click", close);
  actions.appendChild(cancel);

  const question = documentRef.createElement("p");
  question.textContent = "Delete this message for everyone?";
  const confirmButtons = documentRef.createElement("div");
  confirmButtons.className = "wx-srv-message-delete-buttons";
  const confirmDeleteButton = documentRef.createElement("button");
  deleteButton = confirmDeleteButton;
  confirmDeleteButton.type = "button";
  confirmDeleteButton.className = "wx-srv-message-delete-confirm-button";
  confirmDeleteButton.textContent = "Delete";
  confirmDeleteButton.addEventListener("click", () => {
    confirmDeleteButton.disabled = true;
    void deps.onDelete(message).finally(() => {
      confirmDeleteButton.disabled = false;
    });
  });
  const cancelDelete = documentRef.createElement("button");
  cancelDelete.type = "button";
  cancelDelete.className = "wx-srv-message-delete-cancel";
  cancelDelete.textContent = "Cancel";
  cancelDelete.addEventListener("click", close);
  confirmButtons.append(confirmDeleteButton, cancelDelete);
  confirmation.append(question, confirmButtons);
  menu.append(actions, confirmation, copyError);

  trigger.addEventListener("click", () => {
    if (menu.hidden) open();
    else close();
  });

  const onContextMenu = (event: Event): void => {
    event.preventDefault();
    open();
  };
  bubble.addEventListener("contextmenu", onContextMenu);

  let pressTimer: number | null = null;
  let pressStart: { readonly x: number; readonly y: number } | null = null;
  function clearPress(): void {
    if (pressTimer !== null) win.clearTimeout(pressTimer);
    pressTimer = null;
    pressStart = null;
  }
  const onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType !== "touch") return;
    const target = event.target;
    if (target instanceof Element && target.closest("button, a, audio, video")) return;
    clearPress();
    pressStart = { x: event.clientX, y: event.clientY };
    pressTimer = win.setTimeout(() => {
      pressTimer = null;
      pressStart = null;
      open();
    }, LONG_PRESS_MS);
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (pressStart === null) return;
    if (Math.hypot(event.clientX - pressStart.x, event.clientY - pressStart.y) > LONG_PRESS_MOVE_PX) {
      clearPress();
    }
  };
  bubble.addEventListener("pointerdown", onPointerDown);
  bubble.addEventListener("pointermove", onPointerMove);
  bubble.addEventListener("pointerup", clearPress);
  bubble.addEventListener("pointercancel", clearPress);

  trigger.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
  bubble.append(trigger, menu);

  return {
    close,
    update(next: Message): void {
      message = next;
      syncPicker();
    },
    teardown(): void {
      close();
      clearPress();
      bubble.removeEventListener("contextmenu", onContextMenu);
      bubble.removeEventListener("pointerdown", onPointerDown);
      bubble.removeEventListener("pointermove", onPointerMove);
      bubble.removeEventListener("pointerup", clearPress);
      bubble.removeEventListener("pointercancel", clearPress);
    },
  };
}
