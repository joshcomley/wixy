import type { Message } from "./api/messages";
import {
  REACTION_EMOJIS,
  reactionLabel,
  hasVariants,
  getVariants,
  getDefaultHeartEmoji,
  setDefaultHeartEmoji,
  isMainListReaction,
  getRecentReactions,
  addRecentReaction,
  HEART_VARIANTS,
} from "./reactions";
import { EMOJI_CATEGORIES, searchEmojis } from "./emojiData";

const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_PX = 10;
const VARIANT_LONG_PRESS_MS = 350;

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
  /** Round 2 ruling item 10 §(4): "Reply" is the FIRST item, above "Copy
   * text", on every confirmed message — text or media, mine or theirs. */
  readonly onReply: (message: Message) => void;
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

  // The reaction container. Holds the static row, the recents row underneath, and variant popups.
  const picker = documentRef.createElement("div");
  picker.className = "wx-srv-message-reactions-picker";
  picker.setAttribute("role", "group");
  picker.setAttribute("aria-label", "React to this message");

  const staticRow = documentRef.createElement("div");
  staticRow.className = "wx-srv-message-reactions-static";

  const recentsRow = documentRef.createElement("div");
  recentsRow.className = "wx-srv-message-reactions-recents";
  recentsRow.setAttribute("role", "group");
  recentsRow.setAttribute("aria-label", "Recently used reactions");
  recentsRow.hidden = true;

  picker.append(staticRow, recentsRow);

  const pickerButtons: HTMLButtonElement[] = [];
  const recentsButtons: HTMLButtonElement[] = [];
  let heartButton: HTMLButtonElement | null = null;
  let activeVariantsBar: HTMLElement | null = null;

  function closeVariantsBar(): void {
    if (activeVariantsBar !== null) {
      activeVariantsBar.remove();
      activeVariantsBar = null;
    }
  }

  function syncHeartButton(): void {
    if (heartButton === null) return;
    const currentHeart = getDefaultHeartEmoji();
    heartButton.dataset["reaction"] = currentHeart;
    heartButton.textContent = currentHeart;
    heartButton.setAttribute("aria-label", reactionLabel(currentHeart));
  }

  function openVariantsBar(anchorButton: HTMLButtonElement, baseEmoji: string): void {
    closeVariantsBar();
    const variants = getVariants(baseEmoji);
    if (variants.length === 0) return;

    const bar = documentRef.createElement("div");
    bar.className = "wx-srv-reaction-variants-bar";
    bar.setAttribute("role", "menu");
    bar.setAttribute("aria-label", "Emoji variants");
    bar.dataset["srvGestureBoundary"] = "";

    for (const variant of variants) {
      const vBtn = documentRef.createElement("button");
      vBtn.type = "button";
      vBtn.className = "wx-srv-reaction-variant-item";
      vBtn.setAttribute("role", "menuitem");
      vBtn.setAttribute("aria-label", reactionLabel(variant));
      vBtn.dataset["reaction"] = variant;
      vBtn.dataset["srvGestureBoundary"] = "";
      vBtn.textContent = variant;

      vBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        closeVariantsBar();
        if ((HEART_VARIANTS as readonly string[]).includes(variant)) {
          setDefaultHeartEmoji(variant);
          syncHeartButton();
        } else if (!isMainListReaction(variant)) {
          addRecentReaction(variant);
          refreshRecents();
        }
        deps.onReact(message, variant);
        close();
      });

      bar.appendChild(vBtn);
    }

    anchorButton.appendChild(bar);
    activeVariantsBar = bar;

    try {
      const rect = bar.getBoundingClientRect();
      const viewportWidth = win.innerWidth || documentRef.documentElement?.clientWidth || 360;
      let shiftX = 0;
      if (rect.left < 8) {
        shiftX = 8 - rect.left;
      } else if (rect.right > viewportWidth - 8) {
        shiftX = (viewportWidth - 8) - rect.right;
      }
      if (shiftX !== 0) {
        bar.style.transform = `translateX(calc(-50% + ${shiftX}px))`;
      }
      if (rect.top < 8) {
        bar.style.bottom = "auto";
        bar.style.top = "calc(100% + 4px)";
      }
    } catch {
      // In non-DOM / test environments
    }
  }

  for (const emoji of REACTION_EMOJIS) {
    const button = documentRef.createElement("button");
    button.type = "button";
    button.className = "wx-srv-message-react";
    const initialGlyph = emoji === "❤️" ? getDefaultHeartEmoji() : emoji;
    if (emoji === "❤️") heartButton = button;

    button.dataset["reaction"] = initialGlyph;
    button.textContent = initialGlyph;
    button.setAttribute("role", "menuitemcheckbox");
    button.setAttribute("aria-label", reactionLabel(initialGlyph));
    button.dataset["srvGestureBoundary"] = "";

    if (hasVariants(emoji)) {
      button.dataset["hasVariants"] = "true";
      let vTimer: number | null = null;
      let vStart: { x: number; y: number } | null = null;
      let vLongPressed = false;

      const clearVTimer = (): void => {
        if (vTimer !== null) win.clearTimeout(vTimer);
        vTimer = null;
        vStart = null;
      };

      button.addEventListener("pointerdown", (event: PointerEvent) => {
        clearVTimer();
        vLongPressed = false;
        vStart = { x: event.clientX, y: event.clientY };
        vTimer = win.setTimeout(() => {
          vLongPressed = true;
          clearVTimer();
          openVariantsBar(button, emoji);
        }, VARIANT_LONG_PRESS_MS);
      });

      button.addEventListener("pointermove", (event: PointerEvent) => {
        if (vStart === null) return;
        if (Math.hypot(event.clientX - vStart.x, event.clientY - vStart.y) > LONG_PRESS_MOVE_PX) {
          clearVTimer();
        }
      });

      button.addEventListener("pointerup", clearVTimer);
      button.addEventListener("pointercancel", clearVTimer);

      button.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openVariantsBar(button, emoji);
      });

      button.addEventListener("click", (event) => {
        if (vLongPressed) {
          vLongPressed = false;
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        const activeReaction = button.dataset["reaction"] ?? emoji;
        deps.onReact(message, activeReaction);
        close();
      });
    } else {
      button.addEventListener("click", () => {
        deps.onReact(message, emoji);
        close();
      });
    }

    pickerButtons.push(button);
    staticRow.appendChild(button);
  }

  // Trailing ellipsis button to open full emoji selection
  const moreButton = documentRef.createElement("button");
  moreButton.type = "button";
  moreButton.className = "wx-srv-message-react-more";
  moreButton.textContent = "⋯";
  moreButton.setAttribute("role", "button");
  moreButton.setAttribute("aria-label", "Choose from full selection of emojis");
  moreButton.setAttribute("title", "All emojis");
  moreButton.dataset["srvGestureBoundary"] = "";
  moreButton.addEventListener("click", () => {
    openFullPicker();
  });
  staticRow.appendChild(moreButton);

  function refreshRecents(): void {
    recentsRow.innerHTML = "";
    recentsButtons.length = 0;
    const currentHeart = getDefaultHeartEmoji();
    const recents = getRecentReactions().filter((e) => !isMainListReaction(e, currentHeart));
    if (recents.length === 0) {
      recentsRow.hidden = true;
      return;
    }
    recentsRow.hidden = false;
    for (const emoji of recents) {
      const button = documentRef.createElement("button");
      button.type = "button";
      button.className = "wx-srv-message-react wx-srv-message-react-recent";
      button.dataset["reaction"] = emoji;
      button.textContent = emoji;
      button.setAttribute("role", "menuitemcheckbox");
      button.setAttribute("aria-label", reactionLabel(emoji));
      button.dataset["srvGestureBoundary"] = "";
      button.addEventListener("click", () => {
        deps.onReact(message, emoji);
        addRecentReaction(emoji);
        close();
      });
      recentsButtons.push(button);
      recentsRow.appendChild(button);
    }
    syncPicker();
  }

  function syncPicker(): void {
    for (const button of [...pickerButtons, ...recentsButtons]) {
      const reacted = deps.isReacted(message, button.dataset["reaction"] ?? "");
      button.setAttribute("aria-checked", String(reacted));
      button.classList.toggle("wx-srv-message-react-on", reacted);
    }
  }
  syncPicker();
  refreshRecents();

  // Full emoji picker backdrop and view (centered popup on the chat view)
  const backdrop = documentRef.createElement("div");
  backdrop.className = "wx-srv-emoji-picker-backdrop";
  backdrop.hidden = true;
  backdrop.dataset["srvGestureBoundary"] = "";

  const fullPicker = documentRef.createElement("div");
  fullPicker.className = "wx-srv-emoji-picker";
  fullPicker.setAttribute("role", "dialog");
  fullPicker.setAttribute("aria-label", "Emoji picker");
  fullPicker.hidden = true;
  fullPicker.dataset["srvGestureBoundary"] = "";

  const pickerHeader = documentRef.createElement("div");
  pickerHeader.className = "wx-srv-emoji-picker-header";

  const backBtn = documentRef.createElement("button");
  backBtn.type = "button";
  backBtn.className = "wx-srv-emoji-picker-back";
  backBtn.textContent = "←";
  backBtn.setAttribute("aria-label", "Back to actions");
  backBtn.dataset["srvGestureBoundary"] = "";
  backBtn.addEventListener("click", () => {
    closeFullPicker();
  });

  const searchInput = documentRef.createElement("input");
  searchInput.type = "search";
  searchInput.className = "wx-srv-emoji-search";
  searchInput.placeholder = "Search emojis…";
  searchInput.setAttribute("aria-label", "Search emojis");
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  });

  const closeBtn = documentRef.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "wx-srv-emoji-picker-close";
  closeBtn.textContent = "✕";
  closeBtn.setAttribute("aria-label", "Close emoji picker");
  closeBtn.setAttribute("title", "Close");
  closeBtn.dataset["srvGestureBoundary"] = "";
  closeBtn.addEventListener("click", close);

  pickerHeader.append(backBtn, searchInput, closeBtn);

  const categoryTabs = documentRef.createElement("div");
  categoryTabs.className = "wx-srv-emoji-categories";

  const emojiGrid = documentRef.createElement("div");
  emojiGrid.className = "wx-srv-emoji-grid";
  emojiGrid.setAttribute("role", "grid");

  function renderGrid(items: readonly { readonly emoji: string; readonly name: string }[]): void {
    emojiGrid.innerHTML = "";
    for (const item of items) {
      const itemBtn = documentRef.createElement("button");
      itemBtn.type = "button";
      itemBtn.className = "wx-srv-emoji-item";
      itemBtn.textContent = item.emoji;
      itemBtn.setAttribute("role", "gridcell");
      itemBtn.setAttribute("aria-label", item.name);
      itemBtn.setAttribute("title", item.name);
      itemBtn.dataset["reaction"] = item.emoji;
      itemBtn.dataset["srvGestureBoundary"] = "";
      itemBtn.addEventListener("click", () => {
        deps.onReact(message, item.emoji);
        if (!isMainListReaction(item.emoji, getDefaultHeartEmoji())) {
          addRecentReaction(item.emoji);
          refreshRecents();
        }
        close();
      });
      emojiGrid.appendChild(itemBtn);
    }
  }

  let activeCatId = EMOJI_CATEGORIES[0]?.id ?? "";
  for (const cat of EMOJI_CATEGORIES) {
    const tabBtn = documentRef.createElement("button");
    tabBtn.type = "button";
    tabBtn.className = "wx-srv-emoji-category-tab";
    tabBtn.textContent = cat.icon;
    tabBtn.setAttribute("aria-label", cat.name);
    tabBtn.setAttribute("title", cat.name);
    tabBtn.dataset["srvGestureBoundary"] = "";
    tabBtn.addEventListener("click", () => {
      activeCatId = cat.id;
      searchInput.value = "";
      renderGrid(cat.emojis);
    });
    categoryTabs.appendChild(tabBtn);
  }

  searchInput.addEventListener("input", () => {
    const query = searchInput.value.trim();
    if (query) {
      renderGrid(searchEmojis(query));
    } else {
      const cat = EMOJI_CATEGORIES.find((c) => c.id === activeCatId) ?? EMOJI_CATEGORIES[0]!;
      renderGrid(cat.emojis);
    }
  });

  backdrop.addEventListener("pointerdown", (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });

  fullPicker.append(pickerHeader, categoryTabs, emojiGrid);
  backdrop.appendChild(fullPicker);
  menu.appendChild(backdrop);

  function openFullPicker(): void {
    menu.classList.add("wx-srv-message-actions-picker-open");
    actions.hidden = true;
    backdrop.hidden = false;
    fullPicker.hidden = false;
    searchInput.value = "";
    activeCatId = EMOJI_CATEGORIES[0]?.id ?? "";
    renderGrid(EMOJI_CATEGORIES[0]?.emojis ?? []);
    win.setTimeout(() => searchInput.focus(), 50);
  }

  function closeFullPicker(): void {
    menu.classList.remove("wx-srv-message-actions-picker-open");
    fullPicker.hidden = true;
    backdrop.hidden = true;
    actions.hidden = false;
  }

  function close(): void {
    menu.classList.remove("wx-srv-message-actions-picker-open");
    menu.hidden = true;
    confirmation.hidden = true;
    actions.hidden = false;
    fullPicker.hidden = true;
    backdrop.hidden = true;
    closeVariantsBar();
    detachOutsideListener();
    trigger.setAttribute("aria-expanded", "false");
    bubble.classList.remove("wx-srv-message-actions-open");
  }

  function open(): void {
    syncHeartButton();
    refreshRecents();
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    bubble.classList.add("wx-srv-message-actions-open");
    attachOutsideListener();
  }

  // Round 2 ruling item 10 §(4): Reply is the FIRST item in the menu.
  const reply = documentRef.createElement("button");
  reply.type = "button";
  reply.className = "wx-srv-message-action-reply";
  reply.textContent = "Reply";
  reply.setAttribute("role", "menuitem");
  reply.addEventListener("click", () => {
    close();
    deps.onReply(message);
  });
  actions.appendChild(reply);
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

  let outsideListenerActive = false;
  let justOpenedTime = 0;

  function onOutsideEvent(event: Event): void {
    if (menu.hidden && fullPicker.hidden && backdrop.hidden) return;
    if (Date.now() - justOpenedTime < 200) return;

    const target = event.target;
    if (!(target instanceof Node)) return;

    if (!backdrop.hidden && !fullPicker.hidden) {
      if (fullPicker.contains(target)) {
        return;
      }
      close();
      return;
    }

    if (activeVariantsBar !== null) {
      if (activeVariantsBar.contains(target)) {
        return;
      }
      closeVariantsBar();
      if (menu.contains(target) || trigger.contains(target)) {
        return;
      }
    }

    if (menu.contains(target) || trigger.contains(target)) {
      return;
    }

    close();
  }

  function attachOutsideListener(): void {
    if (outsideListenerActive) return;
    outsideListenerActive = true;
    justOpenedTime = Date.now();
    documentRef.addEventListener("pointerdown", onOutsideEvent, true);
    documentRef.addEventListener("click", onOutsideEvent, true);
  }

  function detachOutsideListener(): void {
    if (!outsideListenerActive) return;
    outsideListenerActive = false;
    documentRef.removeEventListener("pointerdown", onOutsideEvent, true);
    documentRef.removeEventListener("click", onOutsideEvent, true);
  }

  const onContextMenu = (event: Event): void => {
    event.preventDefault();
    open();
  };
  bubble.addEventListener("contextmenu", onContextMenu);

  let pressTimer: number | null = null;
  let pressStart: { readonly x: number; readonly y: number } | null = null;
  let bubbleLongPressed = false;

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
      bubbleLongPressed = true;
      open();
    }, LONG_PRESS_MS);
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (pressStart === null) return;
    if (Math.hypot(event.clientX - pressStart.x, event.clientY - pressStart.y) > LONG_PRESS_MOVE_PX) {
      clearPress();
    }
  };
  const onPointerUp = (): void => {
    clearPress();
    if (bubbleLongPressed) {
      win.setTimeout(() => {
        bubbleLongPressed = false;
      }, 100);
    }
  };

  bubble.addEventListener("pointerdown", onPointerDown);
  bubble.addEventListener("pointermove", onPointerMove);
  bubble.addEventListener("pointerup", onPointerUp);
  bubble.addEventListener("pointercancel", clearPress);

  const onBubbleClick = (event: MouseEvent): void => {
    if (bubbleLongPressed) {
      bubbleLongPressed = false;
      if (event.target instanceof Element && event.target.closest(".wx-srv-message-actions")) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    }
  };
  bubble.addEventListener("click", onBubbleClick, true);

  trigger.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (activeVariantsBar !== null) {
        closeVariantsBar();
        return;
      }
      if (!fullPicker.hidden) {
        closeFullPicker();
        return;
      }
      close();
    }
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
      detachOutsideListener();
      closeVariantsBar();
      bubble.removeEventListener("contextmenu", onContextMenu);
      bubble.removeEventListener("pointerdown", onPointerDown);
      bubble.removeEventListener("pointermove", onPointerMove);
      bubble.removeEventListener("pointerup", onPointerUp);
      bubble.removeEventListener("pointercancel", clearPress);
      bubble.removeEventListener("click", onBubbleClick, true);
    },
  };
}
