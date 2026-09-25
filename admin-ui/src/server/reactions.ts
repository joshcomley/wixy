// The reaction emoji a Server chat message can carry — spec/server-chat/04-reactions.md.
// Each entry is an EXACT code-point sequence, compared as a plain string with no
// normalisation: the heart carries its variation selector (U+2764 U+FE0F), so a bare
// U+2764 is not a reaction. The server's list is `REACTION_EMOJIS` in
// `wixy_server/livechat/reactions.py`; `test_livechat_reactions.py` parses THIS file and
// fails if the two ever differ.

export const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏"] as const;

export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];

const REACTION_LABELS: Readonly<Record<ReactionEmoji, string>> = {
  "👍": "Thumbs up",
  "❤️": "Red heart",
  "😂": "Laughing with tears",
  "😮": "Surprised",
  "😢": "Crying",
  "🙏": "Folded hands",
};

export function isReactionEmoji(value: string): value is ReactionEmoji {
  return (REACTION_EMOJIS as readonly string[]).includes(value);
}

/** The spoken name of a reaction, for screen readers (the glyph alone reads poorly). */
export function reactionLabel(emoji: string): string {
  return isReactionEmoji(emoji) ? REACTION_LABELS[emoji] : emoji;
}

/** Position on the list; anything unknown sorts after every known emoji. */
export function reactionOrder(emoji: string): number {
  const index = (REACTION_EMOJIS as readonly string[]).indexOf(emoji);
  return index === -1 ? REACTION_EMOJIS.length : index;
}
