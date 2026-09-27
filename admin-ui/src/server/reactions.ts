// The reaction emoji a Server chat message can carry — spec/server-chat/04-reactions.md.
// Each entry is an EXACT code-point sequence, compared as a plain string with no
// normalisation: the heart carries its variation selector (U+2764 U+FE0F), so a bare
// U+2764 is not a reaction. The server's list is `REACTION_EMOJIS` in
// `wixy_server/livechat/reactions.py`; `test_livechat_reactions.py` parses THIS file and
// fails if the two ever differ.

export const REACTION_EMOJIS = [
  "👍",
  "❤️",
  "😂",
  "😮",
  "😢",
  "🙏",
  "🥰",
  "🎉",
] as const;

export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];

const REACTION_LABELS: Readonly<Record<ReactionEmoji, string>> = {
  "👍": "Thumbs up",
  "❤️": "Red heart",
  "😂": "Laughing with tears",
  "😮": "Surprised",
  "😢": "Crying",
  "🙏": "Folded hands",
  "🥰": "Care",
  "🎉": "Celebrate",
};

export const HEART_VARIANTS = [
  "❤️",
  "🧡",
  "💛",
  "💚",
  "💙",
  "💜",
  "🖤",
  "🤍",
  "🤎",
  "🩷",
  "🩵",
  "🩶",
  "💔",
] as const;

export const THUMBS_UP_VARIANTS = [
  "👍",
  "👍🏻",
  "👍🏼",
  "👍🏽",
  "👍🏾",
  "👍🏿",
] as const;

export const PRAY_VARIANTS = [
  "🙏",
  "🙏🏻",
  "🙏🏼",
  "🙏🏽",
  "🙏🏾",
  "🙏🏿",
] as const;

const EXTRA_LABELS = new Map<string, string>([
  ["🧡", "Orange heart"],
  ["💛", "Yellow heart"],
  ["💚", "Green heart"],
  ["💙", "Blue heart"],
  ["💜", "Purple heart"],
  ["🖤", "Black heart"],
  ["🤍", "White heart"],
  ["🤎", "Brown heart"],
  ["🩷", "Pink heart"],
  ["🩵", "Light blue heart"],
  ["🩶", "Grey heart"],
  ["💔", "Broken heart"],
  ["👍🏻", "Thumbs up (light skin tone)"],
  ["👍🏼", "Thumbs up (medium-light skin tone)"],
  ["👍🏽", "Thumbs up (medium skin tone)"],
  ["👍🏾", "Thumbs up (medium-dark skin tone)"],
  ["👍🏿", "Thumbs up (dark skin tone)"],
  ["🙏🏻", "Folded hands (light skin tone)"],
  ["🙏🏼", "Folded hands (medium-light skin tone)"],
  ["🙏🏽", "Folded hands (medium skin tone)"],
  ["🙏🏾", "Folded hands (medium-dark skin tone)"],
  ["🙏🏿", "Folded hands (dark skin tone)"],
]);

export function isReactionEmoji(value: string): value is ReactionEmoji {
  return (REACTION_EMOJIS as readonly string[]).includes(value);
}

export function hasVariants(emoji: string): boolean {
  return (
    (THUMBS_UP_VARIANTS as readonly string[]).includes(emoji) ||
    (HEART_VARIANTS as readonly string[]).includes(emoji) ||
    (PRAY_VARIANTS as readonly string[]).includes(emoji)
  );
}

export function getVariants(emoji: string): readonly string[] {
  if ((THUMBS_UP_VARIANTS as readonly string[]).includes(emoji)) return THUMBS_UP_VARIANTS;
  if ((HEART_VARIANTS as readonly string[]).includes(emoji)) return HEART_VARIANTS;
  if ((PRAY_VARIANTS as readonly string[]).includes(emoji)) return PRAY_VARIANTS;
  return [];
}

export const DEFAULT_HEART_STORAGE_KEY = "wx_srv_default_heart";
export const RECENT_REACTIONS_STORAGE_KEY = "wx_srv_recent_reactions";
export const MAX_RECENT_REACTIONS = 5;

export function getDefaultHeartEmoji(storage?: Storage): string {
  try {
    const store = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
    const saved = store?.getItem(DEFAULT_HEART_STORAGE_KEY);
    if (saved && (HEART_VARIANTS as readonly string[]).includes(saved)) {
      return saved;
    }
  } catch {
    // Ignore storage access errors
  }
  return "❤️";
}

export function setDefaultHeartEmoji(emoji: string, storage?: Storage): void {
  try {
    const store = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
    store?.setItem(DEFAULT_HEART_STORAGE_KEY, emoji);
  } catch {
    // Ignore storage access errors
  }
}

export function isStaticReaction(emoji: string): boolean {
  return (REACTION_EMOJIS as readonly string[]).includes(emoji);
}

export function isMainListReaction(emoji: string, currentHeartEmoji: string = getDefaultHeartEmoji()): boolean {
  if (emoji === currentHeartEmoji) return true;
  return isStaticReaction(emoji);
}

export function getRecentReactions(storage?: Storage): string[] {
  try {
    const store = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
    const raw = store?.getItem(RECENT_REACTIONS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((e): e is string => typeof e === "string").slice(0, MAX_RECENT_REACTIONS);
      }
    }
  } catch {
    // Ignore storage access errors
  }
  return [];
}

export function addRecentReaction(emoji: string, storage?: Storage): string[] {
  const current = getRecentReactions(storage).filter((e) => e !== emoji);
  const updated = [emoji, ...current].slice(0, MAX_RECENT_REACTIONS);
  try {
    const store = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
    store?.setItem(RECENT_REACTIONS_STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // Ignore storage access errors
  }
  return updated;
}

/** The spoken name of a reaction, for screen readers (the glyph alone reads poorly). */
export function reactionLabel(emoji: string): string {
  if (isReactionEmoji(emoji)) return REACTION_LABELS[emoji];
  const extra = EXTRA_LABELS.get(emoji);
  if (extra !== undefined) return extra;
  return emoji;
}

/** Position on the list; anything unknown sorts after every known emoji. */
export function reactionOrder(emoji: string): number {
  const index = (REACTION_EMOJIS as readonly string[]).indexOf(emoji);
  return index === -1 ? REACTION_EMOJIS.length : index;
}
