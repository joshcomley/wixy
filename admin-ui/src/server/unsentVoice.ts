/**
 * "Unsent voice note" cards (spec/server-chat/06-long-voice-notes.md §2.3).
 *
 * A recording that was uploaded live but never sent (a crash, a killed tab, a dead phone, a lock)
 * is offered back to the SAME device next to the composer, one card each, with Send and Discard.
 * It is never sent automatically: sending is the person's choice. Both buttons answer at once
 * (disabled, "Sending…" / "Discarding…"), the card goes away on success, and a failure re-enables
 * them with a short error line. The component only draws; what Send and Discard do is the
 * caller's (thread.ts), so a failure there is just a rejected promise.
 */

import type { UnsentUpload } from "./api/uploads";
import { formatVoiceTime } from "./voiceTime";

export interface UnsentVoiceCardsOptions {
  readonly document: Document;
  /** Resolve when the note was sent; reject with an Error whose message is a short, plain reason. */
  readonly send: (entry: UnsentUpload) => Promise<void>;
  /** Resolve when the note was discarded (or was already gone). */
  readonly discard: (entry: UnsentUpload) => Promise<void>;
}

export interface UnsentVoiceCards {
  /** Hidden while there is nothing to offer. */
  readonly element: HTMLElement;
  /** Show exactly these entries (newest first). A card in the middle of Sending/Discarding is
   * kept, and an entry that is already shown keeps its state, so a refresh never resets it. */
  setEntries(entries: readonly UnsentUpload[]): void;
  clear(): void;
}

interface Card {
  readonly element: HTMLElement;
  readonly send: HTMLButtonElement;
  readonly discard: HTMLButtonElement;
  readonly error: HTMLElement;
  busy: boolean;
}

export function createUnsentVoiceCards(options: UnsentVoiceCardsOptions): UnsentVoiceCards {
  const doc = options.document;
  const element = doc.createElement("div");
  element.className = "wx-srv-unsent-list";
  element.hidden = true;
  element.setAttribute("role", "group");
  element.setAttribute("aria-label", "Unsent voice notes");
  const cards = new Map<string, Card>();

  function build(entry: UnsentUpload): Card {
    const time = formatVoiceTime(entry.durationMs);
    const card = doc.createElement("div");
    card.className = "wx-srv-unsent-card";
    card.dataset.uploadId = entry.uploadId;
    const label = doc.createElement("span");
    label.className = "wx-srv-unsent-label";
    label.textContent = `Unsent voice note · ${time}`;
    const send = doc.createElement("button");
    send.type = "button";
    send.className = "wx-srv-unsent-send";
    send.textContent = "Send";
    send.setAttribute("aria-label", `Send unsent voice note, ${time}`);
    const discard = doc.createElement("button");
    discard.type = "button";
    discard.className = "wx-srv-unsent-discard";
    discard.textContent = "Discard";
    discard.setAttribute("aria-label", `Discard unsent voice note, ${time}`);
    const error = doc.createElement("p");
    error.className = "wx-srv-unsent-error";
    error.setAttribute("role", "alert");
    error.hidden = true;
    card.append(label, send, discard, error);
    const state: Card = { element: card, send, discard, error, busy: false };

    const run = async (action: "send" | "discard"): Promise<void> => {
      if (state.busy) return;
      state.busy = true;
      state.send.disabled = true;
      state.discard.disabled = true;
      state.error.hidden = true;
      state.error.textContent = "";
      state[action].textContent = action === "send" ? "Sending…" : "Discarding…";
      try {
        await (action === "send" ? options.send(entry) : options.discard(entry));
        cards.delete(entry.uploadId);
        card.remove();
        refreshVisibility();
      } catch (failure) {
        state.busy = false;
        state.send.disabled = false;
        state.discard.disabled = false;
        state.send.textContent = "Send";
        state.discard.textContent = "Discard";
        state.error.textContent = failure instanceof Error && failure.message !== ""
          ? failure.message
          : action === "send" ? "Couldn't send. Try again." : "Couldn't discard. Try again.";
        state.error.hidden = false;
      }
    };
    send.addEventListener("click", () => void run("send"));
    discard.addEventListener("click", () => void run("discard"));
    return state;
  }

  function refreshVisibility(): void {
    element.hidden = cards.size === 0;
  }

  return {
    element,
    setEntries(entries): void {
      const wanted = new Set(entries.map((entry) => entry.uploadId));
      for (const [id, card] of cards) {
        if (!wanted.has(id) && !card.busy) {
          cards.delete(id);
          card.element.remove();
        }
      }
      const ordered: HTMLElement[] = [];
      for (const entry of entries) {
        let card = cards.get(entry.uploadId);
        if (card === undefined) {
          card = build(entry);
          cards.set(entry.uploadId, card);
        }
        ordered.push(card.element);
      }
      for (const [id, card] of cards) {
        if (!wanted.has(id)) ordered.push(card.element);
      }
      element.replaceChildren(...ordered);
      refreshVisibility();
    },
    clear(): void {
      cards.clear();
      element.replaceChildren();
      refreshVisibility();
    },
  };
}
