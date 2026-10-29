// The Cookout card (workspace 00058; spec/server-chat/09-cookout.md §5.4, the `adventureCard.ts`
// precedent): what a round looks like in the MAIN chat — the mode badge (Open / Blind), one line of
// status and an Open button for the game tab. Once the dishes have pictures, up to three small dish
// photos sit beside the words. Scrolling up the thread shows each Cookout's context here; the playing
// itself happens in the game tab (`cookoutGame.ts`).
//
// The status line comes from the message's own `cookout` summary, which carries counts and states only
// (never an ingredient, an option or a recipe), so the card can be drawn before — or without — the
// round's view. Everything user-visible is set via `textContent`.

import type { Message } from "../api/messages";
import { CONCEPT_IDS, parseCookoutSummary, type CookoutSummary, type Picture } from "./api";
import type { CookoutModel } from "./model";

export interface CookoutCardDeps {
  readonly model: CookoutModel;
  readonly document: Document;
  /** Opens (or focuses) the game tab for this round. */
  openGame(seq: number): void;
}

export interface CookoutCards {
  /** Builds the card's container for a round-anchor message. */
  create(message: Message): HTMLElement;
  /** Re-draws the card inside `container` from the summary and the model's view. */
  render(container: HTMLElement, message: Message): void;
}

/** One line of status for the card (spec §5.4; the twists' lines 09a §9). The summary carries counts and
 * flags only, so none of these lines can name an ingredient, a star, a vote or a dish. */
export function cookoutStatusLine(summary: CookoutSummary | null): string {
  if (summary === null) return "Cookout";
  switch (summary.state) {
    case "abandoned":
      return "Ended";
    case "picking":
      return `Picking ingredients (${summary.pickedCount}/10)…`;
    case "finished": {
      // The chef gate first: the round is waiting on a player.
      if (summary.concepts === "none" && summary.waiting.includes("wildcard")) return "All 10 picked — Lift the cloche?";
      if (summary.concepts === "none" && summary.waiting.includes("stars")) return "All 10 picked — Waiting for secret stars";
      if (summary.swap === "proposed") return "Swapping an ingredient…";
      const extras: string[] = [];
      if (summary.dinnerDecided) extras.push("🎯 Dinner decided");
      if (summary.cookedCount > 0) extras.push("✓ Cooked");
      const tail = extras.length === 0 ? "" : ` · ${extras.join(" · ")}`;
      if (summary.bankedCount > 0) {
        return `${summary.bankedCount === 1 ? "1 recipe banked ✓" : `${summary.bankedCount} recipes banked ✓`}${tail}`;
      }
      const fresh = summary.generation > 1 ? "3 new dish ideas" : "3 dish ideas";
      switch (summary.concepts) {
        case "ready":
          return `${fresh} ready${tail}`;
        case "failed":
          return "All 10 picked — the chef didn't finish";
        case "unavailable":
          return "All 10 picked";
        default:
          return summary.generation > 1 ? "Ingredient swapped — chef is thinking…" : "All 10 picked — chef is thinking…";
      }
    }
  }
}

export function createCookoutCards(deps: CookoutCardDeps): CookoutCards {
  const doc = deps.document;

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
    const node = doc.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function render(container: HTMLElement, message: Message): void {
    const seq = message.seq;
    const summary = parseCookoutSummary(message.cookout);
    const view = deps.model.view(seq);
    // The dish photos are kept when their URLs have not changed: a redraw (every poll and stream frame)
    // must not flicker them or ask the server for the same signed thumbnails again.
    const oldMedia = container.querySelector<HTMLElement>(":scope > .wx-srv-ck-mcard-media");
    container.replaceChildren();
    container.dataset["ckSeq"] = String(seq);
    container.dataset["ckState"] = summary?.state ?? "";

    const text = el("div", "wx-srv-ck-mcard-text");
    const head = el("div", "wx-srv-ck-mcard-head");
    const icon = el("span", "wx-srv-ck-mcard-icon", "🍳");
    icon.setAttribute("aria-hidden", "true");
    head.append(icon, el("span", "wx-srv-ck-mcard-title", "Cookout"));
    const blind = view?.blind ?? summary?.blind ?? false;
    if (summary !== null || view !== undefined) {
      const badge = el("span", "wx-srv-ck-badge", blind ? "Blind" : "Open");
      badge.dataset["mode"] = blind ? "blind" : "open";
      head.append(badge);
    }
    text.append(head);
    text.append(el("p", "wx-srv-ck-mcard-status", cookoutStatusLine(summary)));
    const open = el("button", "wx-srv-ck-mcard-open", "Open");
    open.type = "button";
    open.setAttribute("data-srv-gesture-boundary", "");
    open.addEventListener("click", () => deps.openGame(seq));
    text.append(open);

    // The dish photos, once there are any (only in the view: the summary never carries pictures).
    const pictures: Picture[] = [];
    if (view !== undefined && view.state === "finished") {
      for (const id of CONCEPT_IDS) {
        const picture = view.images.pictures[id];
        if (picture !== null) pictures.push(picture);
      }
    }
    const mediaKey = pictures.map((p) => p.thumbUrl).join(" ");
    if (pictures.length > 0 && oldMedia !== null && oldMedia.dataset["ckMedia"] === mediaKey) {
      container.append(text, oldMedia);
    } else if (pictures.length > 0) {
      const media = el("div", "wx-srv-ck-mcard-media");
      media.dataset["ckMedia"] = mediaKey;
      for (const picture of pictures) {
        const img = doc.createElement("img");
        img.className = "wx-srv-ck-mcard-dish";
        img.src = picture.thumbUrl;
        img.alt = "A dish idea";
        img.loading = "lazy";
        img.decoding = "async";
        img.draggable = false;
        // A photo that will not load just leaves the card's words.
        img.addEventListener("error", () => img.remove());
        media.append(img);
      }
      container.append(text, media);
    } else {
      container.append(text);
    }
  }

  return {
    create(message) {
      const container = el("div", "wx-srv-ck-mcard");
      render(container, message);
      return container;
    },
    render,
  };
}
