// The would-you-rather GAME PANE (workspace 00045): when a round is opened its tab shows the round
// full-height:
//
//   [ title                  Maximize  Topics  Next ▸  × ]
//   [ the picture — tap it to flip between option A and option B ]
//   [ the controls: Play/Skip, pick + guess, Reveal, results ]
//   [ mini chat: this card's last two messages ]      <- tap a message (or a thumbnail) to open
//   [ the chat composer — the ordinary one, now sending into this card ]
//
// The card's chat is kept WITH the card (messages carry `wyrRef`, `wyrSeq` on send) and also lives
// in the main chat. Closing the game closes the tab; with one tab left the bar disappears.
//
// This module is only the WYR-specific part — the header, the picture stage, the controls host and
// the maximize-pictures dialog. The FRAME is shared with every game (spec/server-chat/
// 08-adventure-time.md §5.1): the tab bar, which pane shows, dots, dismissal and where a message
// goes live in `gameTabs.ts`; the mini chat strip and the pop-up item chat (with the ONE composer
// re-parented into it) live in `itemChat.ts`. The thread supplies the data and the composer through
// those two modules (so nothing here knows how messages are stored or sent), and this pane
// registers itself with `gameTabs` under the key "wyr".

import type { Message } from "./api/messages";
import type { WyrView } from "./api/wyr";
import type { GameTabs } from "./gameTabs";
import type { ItemChat } from "./itemChat";
import type { WyrControls } from "./wyrControls";
import { wyrPictureUrls } from "./wyrCard";
import type { WyrModel } from "./wyrModel";

export interface WyrGameDeps {
  readonly document: Document;
  readonly model: WyrModel;
  readonly controls: WyrControls;
  /** The shared tab bar: this pane registers itself as the game "wyr". */
  readonly tabs: GameTabs;
  /** The shared item chat: this pane embeds one mini chat strip. */
  readonly itemChat: ItemChat;
  /** The round's anchor message, or undefined once it is gone (deleted, wiped). */
  roundMessage(seq: number): Message | undefined;
  /** Starts the next round (the ⋯ menu's action). */
  startNextRound(): void;
  /** Opens the topics screen (which topics the questions come from). */
  openTopics(): void;
  /** Call after any change that may have altered the layout's height. */
  afterChange(): void;
  openLightbox?(source: string, alt: string): void;
}

export interface WyrGame {
  /** The game tab's content — sits in the thread view where the message thread is. */
  readonly pane: HTMLElement;
  /** Opens the game tab for `seq` and shows it. */
  open(seq: number): void;
  /** A round started elsewhere: the tab appears (with a dot) without taking over the screen. */
  offer(seq: number): void;
  /** Closes the game: the tab goes, the chat is shown. */
  close(): void;
  /** The open game's round, or null. */
  gameSeq(): number | null;
}

export function createWyrGame(deps: WyrGameDeps): WyrGame {
  const doc = deps.document;

  function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string,
    text?: string,
  ): HTMLElementTagNameMap[K] {
    const node = doc.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(className: string, label: string, text: string, onClick: () => void): HTMLButtonElement {
    const b = el("button", className, text);
    b.type = "button";
    b.setAttribute("aria-label", label);
    b.setAttribute("data-srv-gesture-boundary", "");
    b.addEventListener("click", onClick);
    return b;
  }

  let shown: "a" | "b" = "a";
  /** The round the pane was last drawn for: a different one starts again at option A. */
  let drawnSeq: number | null = null;

  // -- Game pane ----------------------------------------------------------------------------

  const pane = el("div", "wx-srv-game");
  pane.setAttribute("data-game", "wyr");
  pane.hidden = true;
  const head = el("div", "wx-srv-game-head");
  const title = el("span", "wx-srv-game-title", "Would you rather…?");
  const maximizePicturesButton = button(
    "wx-srv-game-maximize",
    "Maximize pictures",
    "Maximize pictures",
    () => openPictures(),
  );
  maximizePicturesButton.hidden = true;
  const nextButton = button("wx-srv-game-next", "Start the next round", "Next ▸", () => deps.startNextRound());
  nextButton.hidden = true;
  const topicsButton = button("wx-srv-game-topics", "Choose the game topics", "Topics", () => deps.openTopics());
  const closeButton = button("wx-srv-game-close", "Close the game", "✕", () => close());
  head.append(title, maximizePicturesButton, topicsButton, nextButton, closeButton);

  const stage = el("button", "wx-srv-game-stage");
  stage.type = "button";
  stage.setAttribute("data-srv-gesture-boundary", "");
  const imgA = doc.createElement("img");
  imgA.className = "wx-srv-game-img";
  const imgB = doc.createElement("img");
  imgB.className = "wx-srv-game-img";
  const placeholder = el("div", "wx-srv-game-placeholder");
  const chips = el("div", "wx-srv-game-chips");
  const chipA = el("span", "wx-srv-game-chip", "A");
  const chipB = el("span", "wx-srv-game-chip", "B");
  chips.append(chipA, chipB);
  const caption = el("div", "wx-srv-game-caption");
  const captionText = el("span", "wx-srv-game-caption-text");
  const captionPicks = el("span", "wx-srv-game-caption-picks");
  caption.append(captionText, captionPicks);
  stage.append(imgA, imgB, placeholder, chips, caption);
  stage.addEventListener("click", () => {
    shown = shown === "a" ? "b" : "a";
    const seq = deps.tabs.seqOf("wyr");
    if (seq !== null) drawStage(seq);
  });

  const controlsHost = el("div", "wx-srv-game-controls");
  const strip = deps.itemChat.createStrip();
  const picturesOverlay = doc.createElement("dialog");
  picturesOverlay.className = "wx-srv-game-pictures";
  picturesOverlay.setAttribute("role", "dialog");
  picturesOverlay.setAttribute("aria-modal", "true");
  picturesOverlay.setAttribute("aria-label", "Compare the Would You Rather pictures");
  picturesOverlay.addEventListener("cancel", (event) => event.preventDefault());
  const picturesHead = el("div", "wx-srv-game-pictures-head");
  const picturesTitle = el("span", "wx-srv-game-pictures-title", "Compare both pictures");
  picturesTitle.id = "wx-srv-game-pictures-title";
  picturesOverlay.setAttribute("aria-labelledby", picturesTitle.id);
  picturesHead.appendChild(picturesTitle);
  const picturesClose = button(
    "wx-srv-game-pictures-close",
    "Return to the answer choices",
    "Back to choices",
    () => closePictures(),
  );
  picturesHead.appendChild(picturesClose);
  const picturesPair = el("div", "wx-srv-game-pictures-pair");
  const pictureOptions = (["a", "b"] as const).map((which) => {
    const option = el("figure", "wx-srv-game-pictures-option");
    const image = doc.createElement("img");
    image.className = "wx-srv-game-pictures-image";
    const fallback = el("div", "wx-srv-game-pictures-fallback", "Picture not available");
    const label = el("figcaption", "wx-srv-game-pictures-label");
    option.append(image, fallback, label);
    picturesPair.appendChild(option);
    return { which, image, fallback, label };
  });
  picturesOverlay.append(picturesHead, picturesPair);
  pane.append(head, stage, controlsHost, strip.element, picturesOverlay);
  let picturesOpen = false;

  // -- Drawing ------------------------------------------------------------------------------

  function optionText(view: WyrView, which: "a" | "b"): string {
    return which === "a" ? view.question.a : view.question.b;
  }

  function renderPictures(view: WyrView, message: Message): void {
    const [urlA, urlB] = wyrPictureUrls(message, "full");
    const urls = { a: urlA ?? null, b: urlB ?? null };
    const hasPicture = Object.values(urls).some((url) => url !== null);
    maximizePicturesButton.hidden = !hasPicture || view.state === "skipped";
    if (!picturesOpen) return;
    if (!hasPicture || view.state === "skipped") {
      closePictures(false);
      return;
    }
    for (const option of pictureOptions) {
      const url = urls[option.which];
      option.image.hidden = url === null;
      option.fallback.hidden = url !== null;
      option.label.textContent = `Option ${option.which.toUpperCase()}: ${optionText(view, option.which)}`;
      if (url !== null) {
        if (option.image.getAttribute("src") !== url) option.image.src = url;
        option.image.alt = optionText(view, option.which);
      } else if (option.image.hasAttribute("src")) {
        option.image.removeAttribute("src");
      }
    }
  }

  function openPictures(): void {
    const seq = deps.tabs.seqOf("wyr");
    if (seq === null) return;
    const view = deps.model.view(seq);
    const message = deps.roundMessage(seq);
    if (view === undefined || message === undefined) return;
    picturesOpen = true;
    picturesOverlay.showModal();
    renderPictures(view, message);
    picturesClose.focus();
    deps.afterChange();
  }

  function closePictures(restoreFocus = true): void {
    if (!picturesOpen) return;
    picturesOpen = false;
    if (picturesOverlay.open) picturesOverlay.close();
    if (restoreFocus && !maximizePicturesButton.hidden) maximizePicturesButton.focus();
    deps.afterChange();
  }

  function drawStage(seq: number): void {
    const view = deps.model.view(seq);
    const message = deps.roundMessage(seq);
    if (view === undefined || message === undefined) return;
    renderPictures(view, message);
    const [urlA, urlB] = wyrPictureUrls(message, "full");
    const url = shown === "a" ? urlA : urlB;
    for (const [img, src] of [[imgA, urlA], [imgB, urlB]] as const) {
      if (src !== null && src !== undefined) {
        if (img.getAttribute("src") !== src) img.src = src;
      } else if (img.hasAttribute("src")) {
        img.removeAttribute("src");
      }
    }
    imgA.classList.toggle("wx-srv-game-img-on", shown === "a" && urlA != null);
    imgB.classList.toggle("wx-srv-game-img-on", shown === "b" && urlB != null);
    const waiting = view.images === "pending" && view.state !== "skipped";
    placeholder.hidden = url != null;
    if (url == null) {
      placeholder.className = `wx-srv-game-placeholder${waiting ? " wx-srv-game-placeholder-loading" : ""}`;
      placeholder.textContent = waiting ? "Painting…" : optionText(view, shown);
    }
    chipA.classList.toggle("wx-srv-game-chip-on", shown === "a");
    chipB.classList.toggle("wx-srv-game-chip-on", shown === "b");
    captionText.textContent = optionText(view, shown);
    // A text-only round already shows the option as the big text: no second copy in the caption.
    captionText.hidden = url == null && !waiting;
    let picks = "";
    if (view.result !== null) {
      const names = view.result.players
        .filter((p) => p.choice === shown)
        .map((p) => (view.you !== null && p.name === view.players[view.you.slot - 1]?.name ? "You" : p.name));
      picks = names.length > 0 ? `Picked by ${names.join(" and ")}` : "";
    }
    captionPicks.textContent = picks;
    stage.setAttribute("aria-label", `Option ${shown.toUpperCase()}: ${optionText(view, shown)}. Tap to see the other one.`);
  }

  /** Redraws the pane for round `seq` (the frame calls this only while the WYR tab shows; the
   * mini chat strip and the pop-up are redrawn by the shared item chat right after). */
  function refreshPane(seq: number): void {
    if (drawnSeq !== seq) {
      // A different round starts again at option A, and its pictures are not the ones on screen.
      closePictures(false);
      shown = "a";
      drawnSeq = seq;
      strip.draw(seq);
    }
    const view = deps.model.view(seq);
    if (view !== undefined) {
      nextButton.hidden = !(view.state === "revealed" || view.state === "skipped");
      title.textContent = "Would you rather…?";
      deps.controls.render(controlsHost, seq, view);
      controlsHost.hidden = false;
    } else {
      controlsHost.replaceChildren(el("p", "wx-srv-wyr-status", "Loading…"));
    }
    drawStage(seq);
  }

  /** The game closed, or the chat locked / was wiped: forget the round on screen. */
  function forget(): void {
    closePictures(false);
    shown = "a";
    drawnSeq = null;
    strip.draw(null);
  }

  function close(): void {
    deps.tabs.close("wyr");
  }

  deps.tabs.register({
    key: "wyr",
    tabLabel: "WYR",
    tabAriaLabel: "Would you rather game",
    pane,
    exists: (seq) => deps.roundMessage(seq) !== undefined,
    refresh: refreshPane,
    // The comparison view is modal and covers the page: it never outlives the tab.
    onHide: () => closePictures(false),
    reset: forget,
  });

  return {
    pane,
    open: (seq) => deps.tabs.open("wyr", seq),
    offer: (seq) => deps.tabs.offer("wyr", seq),
    close,
    gameSeq: () => deps.tabs.seqOf("wyr"),
  };
}
