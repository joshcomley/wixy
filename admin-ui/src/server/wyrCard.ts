// The would-you-rather preview card (workspace 00045): what a round looks like in the MAIN chat —
// the question, both pictures side by side, one line of status, and a button that opens the
// game tab. Scrolling up the thread shows each round's context here; the playing itself
// (vote, answer, reveal, the game chat) happens in the game tab (`wyrGame.ts`). Everything
// user-visible is set via `textContent`; the only URLs used are the signed attachment URLs the
// server minted.

import type { Attachment, Message } from "./api/messages";
import type { WyrChoice, WyrView } from "./api/wyr";
import type { WyrModel } from "./wyrModel";
import { wyrStatusLine } from "./wyrControls";
import { createWyrCountdown } from "./wyrCountdown";

export interface WyrCardDeps {
  readonly model: WyrModel;
  readonly document: Document;
  /** Opens (or focuses) the game tab for this round. */
  openGame(seq: number): void;
  openLightbox?(source: string, alt: string): void;
}

export interface WyrCards {
  /** Builds the card's container for a round-anchor message. */
  create(message: Message): HTMLElement;
  /** Re-draws the card inside `container` from the model's current state. */
  render(container: HTMLElement, message: Message): void;
}

/** The two pictures of a round (ordinal 0 = option A, 1 = B): the best rendition ready now. */
export function wyrPictureUrls(message: Message, size: "thumb" | "full"): (string | null)[] {
  return [0, 1].map((i) => {
    const attachment: Attachment | undefined = message.attachments[i];
    if (attachment === undefined || attachment.kind !== "photo" || attachment.status !== "ready") return null;
    const urls = attachment.urls;
    return (size === "thumb" ? (urls.thumb ?? urls.full) : (urls.full ?? urls.thumb)) ?? null;
  });
}

export function createWyrCards(deps: WyrCardDeps): WyrCards {
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

  function tile(
    view: WyrView,
    which: WyrChoice,
    url: string | null,
    waiting: boolean,
    mark: "none" | "mine" | "theirs" | "both",
  ): HTMLElement {
    const label = which === "a" ? view.question.a : view.question.b;
    const figure = el("div", `wx-srv-wyr-tile${mark === "none" ? "" : ` wx-srv-wyr-tile-${mark}`}`);
    if (url === null && !waiting) {
      // Text-only round (no pictures are painted here, or this one never arrived).
      figure.appendChild(el("div", "wx-srv-wyr-label", label));
      return figure;
    }
    const frame = el("div", "wx-srv-wyr-frame");
    if (url !== null) {
      const img = doc.createElement("img");
      img.className = "wx-srv-wyr-img";
      img.src = url;
      img.alt = label;
      img.loading = "lazy";
      frame.appendChild(img);
    } else {
      frame.classList.add("wx-srv-wyr-frame-loading");
      frame.appendChild(el("span", "wx-srv-wyr-frame-note", "Painting…"));
    }
    figure.append(frame, el("div", "wx-srv-wyr-label", label));
    return figure;
  }

  function render(container: HTMLElement, message: Message): void {
    const seq = message.seq;
    const view = deps.model.view(seq);
    container.replaceChildren();
    container.dataset["wyrSeq"] = String(seq);

    const summary = message.wyr ?? null;
    if (view === undefined) {
      container.appendChild(
        el("p", "wx-srv-wyr-status", summary?.state === "skipped" ? "Skipped." : "Would you rather… loading"),
      );
      return;
    }
    container.dataset["wyrState"] = view.state;
    const [urlA = null, urlB = null] = wyrPictureUrls(message, "thumb");
    // Wait for pictures only while the server says they are being painted.
    const waiting = view.images === "pending" && view.state !== "skipped";

    container.appendChild(el("div", "wx-srv-wyr-title", "Would you rather…?"));
    const results = view.result?.players;
    const pair = el("div", `wx-srv-wyr-pair${view.state === "skipped" ? " wx-srv-wyr-pair-muted" : ""}`);
    for (const which of ["a", "b"] as const) {
      let mark: "none" | "mine" | "theirs" | "both" = "none";
      if (view.result !== null && results !== undefined && view.you !== null) {
        const mineIdx = view.you.slot - 1;
        const mine = results[mineIdx]?.choice === which;
        const theirs = results[1 - mineIdx]?.choice === which;
        mark = mine && theirs ? "both" : mine ? "mine" : theirs ? "theirs" : "none";
      }
      const url = which === "a" ? urlA : urlB;
      const t = tile(view, which, url, waiting, mark);
      if (url !== null && deps.openLightbox !== undefined) {
        const open = deps.openLightbox;
        const label = which === "a" ? view.question.a : view.question.b;
        t.querySelector("img")?.addEventListener("click", () => {
          const full = wyrPictureUrls(message, "full")[which === "a" ? 0 : 1];
          if (full !== null && full !== undefined) open(full, label);
        });
      }
      pair.appendChild(t);
    }
    container.appendChild(pair);
    const revealActive =
      view.state === "revealing" &&
      view.revealDeadline !== null &&
      view.revealDeadline > Date.now() / 1000;
    const status =
      view.state === "revealing" && view.revealDeadline !== null && !revealActive
        ? "The reveal countdown expired. Tap to start again."
        : wyrStatusLine(view);
    container.appendChild(el("p", "wx-srv-wyr-status", status));
    if (revealActive && view.revealDeadline !== null) {
      const label = view.you?.revealed ? "Waiting for your partner" : "Reveal together";
      container.appendChild(
        createWyrCountdown(doc, view.revealDeadline, label, () => deps.openGame(seq), () => render(container, message)),
      );
    } else if (view.state !== "skipped") {
      const open = el("button", "wx-srv-wyr-primary wx-srv-wyr-open", view.state === "revealed" ? "Open" : "Play");
      open.type = "button";
      open.setAttribute("data-srv-gesture-boundary", "");
      open.addEventListener("click", () => deps.openGame(seq));
      container.appendChild(open);
    }
  }

  return {
    create(message) {
      const container = el("div", "wx-srv-wyr-card");
      render(container, message);
      return container;
    },
    render,
  };
}
