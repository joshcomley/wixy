// The state behind a game's chat FAB, floating message and quick reply (gameFloat.ts; decisions/00194).
// No DOM here: only "which messages has this device not seen yet", which is what the FAB's dot, the
// floating bubble and the quick reply's target are all read from.
//
// A message is UNSEEN from the moment the OTHER person's message arrives while a game tab shows, until
// it has been shown to this person: the pop-up chat was open on its chat, the floating bubble was
// dismissed (it had been on screen), or the quick reply was opened on it (and answered). Showing the
// Chat tab clears everything: the main chat shows every message, game ones included.
//
// A message belongs to one SOURCE: the item (its anchor seq) whose game chat it was sent in, or `null`
// for the main chat. Only the open item's messages and the main chat's are tracked; a message for any
// other item is ignored (no pane shows it, and the main chat will).

import type { Message } from "./api/messages";

/** The chat a message came from: an item's anchor seq, or null for the main chat. */
export type FloatSource = number | null;

export interface UnseenMessage {
  readonly seq: number;
  readonly source: FloatSource;
  readonly sender: string;
  readonly text: string | null;
  readonly attachments: Message["attachments"];
}

export interface FloatingView {
  /** The newest unseen message: what the bubble shows. */
  readonly message: UnseenMessage;
  /** How many OTHER unseen messages there are (the bubble's "+N"). */
  readonly more: number;
}

export interface FloatModelDeps {
  /** The item the active game tab shows, or null while the Chat tab (or no game) is showing. */
  activeItem(): number | null;
}

export interface FloatModel {
  /**
   * The other person's message arrived. `true` if it is now unseen (it is tracked only while a game
   * tab shows and the message is for that tab's item or for the main chat).
   */
  note(message: Message): boolean;
  /** The newest unseen message, or null. */
  floating(): FloatingView | null;
  /** Whether the item has a message this device has not seen (the FAB's dot). */
  unreadFor(item: number): boolean;
  /** `source`'s messages were shown: forget them. */
  markSeen(source: FloatSource): void;
  /** Everything on screen was shown (the floating bubble dismissed): forget all of it. */
  markAllSeen(): void;
  /** Lock / wipe / game closed / Chat tab: forget everything. */
  clear(): void;
  /** A message was deleted: it can no longer be shown. */
  forget(seq: number): void;
  /** The tab or its item changed: drop what belongs to an item that is no longer the open one. */
  prune(): void;
  /** Total unseen. */
  count(): number;
  /** The seqs of the unseen messages. */
  seqs(): number[];
}

export function createFloatModel(deps: FloatModelDeps): FloatModel {
  let unseen: UnseenMessage[] = [];

  return {
    note(message) {
      const active = deps.activeItem();
      if (active === null) return false;
      const ref = message.wyrRef ?? null;
      if (ref !== null && ref !== active) return false;
      if (unseen.some((m) => m.seq === message.seq)) return false;
      unseen.push({
        seq: message.seq,
        source: ref,
        sender: message.sender,
        text: message.text,
        attachments: message.attachments,
      });
      return true;
    },
    floating() {
      const newest = unseen.reduce<UnseenMessage | null>((best, m) => (best === null || m.seq > best.seq ? m : best), null);
      return newest === null ? null : { message: newest, more: unseen.length - 1 };
    },
    unreadFor: (item) => unseen.some((m) => m.source === item),
    markSeen(source) {
      unseen = unseen.filter((m) => m.source !== source);
    },
    markAllSeen() {
      unseen = [];
    },
    clear() {
      unseen = [];
    },
    forget(seq) {
      unseen = unseen.filter((m) => m.seq !== seq);
    },
    prune() {
      const active = deps.activeItem();
      unseen = active === null ? [] : unseen.filter((m) => m.source === null || m.source === active);
    },
    count: () => unseen.length,
    seqs: () => unseen.map((m) => m.seq),
  };
}

/** The bubble's one-line summary of a message's attachments ("Photo", "Voice note", …), or null. */
export function attachmentLabel(attachments: Message["attachments"]): string | null {
  const first = attachments[0];
  if (first === undefined) return null;
  const base = first.kind === "voice" ? "Voice note" : first.kind === "video" ? "Video" : "Photo";
  return attachments.length > 1 ? `${base} +${attachments.length - 1}` : base;
}
