// Cookout GAME MODES on the client (workspace 00058; spec/server-chat/09c-cookout-modes.md §6): the small,
// pure word rules every Cookout screen shares once a round is not Classic — the mode's numbers in words,
// the anchor pick (a toasted sandwich's bread), the kind labels, and the start-sheet tile pictures.
//
// A mode is data (`CookoutModeInfo` from the view, `ModeOption` from `GET /cookout/options`). Nothing here
// names a particular mode except the tile pictures, which are build-time assets; every Classic caller keeps
// its own existing words, so a Classic round reads exactly as before.

import { isClassic, type CookoutModeInfo, type CookoutView, type ModeKind, type PickSnap } from "./api";

declare const WIXY_COOKOUT_MODE_TILES: Readonly<Record<string, string>> | undefined;

/** The start sheet's tile picture for a mode (09c §6.1), or null (the tile shows the mode's emoji). */
export function modeTileUrl(modeId: string): string | null {
  const tiles = typeof WIXY_COOKOUT_MODE_TILES === "undefined" ? undefined : WIXY_COOKOUT_MODE_TILES;
  const url = tiles?.[modeId];
  return typeof url === "string" && url !== "" ? url : null;
}

const NUMBER_WORDS: readonly string[] = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

/** 8 → "eight" (digits beyond twelve). */
export function numberWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

/** 9 → "9th", 11 → "11th", 22 → "22nd". */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** The mode's dish in lower case, singular ("toasted sandwich"). */
export function dishNoun(mode: { readonly label: string }): string {
  return mode.label.trim().toLowerCase();
}

/** "toasted sandwich" → "toasted sandwiches". */
export function plural(noun: string): string {
  if (/(?:s|x|z|ch|sh)$/i.test(noun)) return `${noun}es`;
  if (/[^aeiou]y$/i.test(noun)) return `${noun.slice(0, -1)}ies`;
  return `${noun}s`;
}

export function capitalise(text: string): string {
  return text === "" ? "" : text.charAt(0).toUpperCase() + text.slice(1);
}

/** A kind's label without its article: "the bread" → "bread", "a finishing touch" → "finishing touch". */
export function kindNoun(kind: ModeKind): string {
  return kind.label.replace(/^(?:the|an?)\s+/i, "").trim();
}

export function kindOf(mode: CookoutModeInfo, id: string | null): ModeKind | null {
  if (id === null) return null;
  return mode.kinds.find((k) => k.id === id) ?? null;
}

/** The anchor kind ("bread") of a single-dish mode, or null (Classic and any mode without one). */
export function anchorKind(mode: CookoutModeInfo): ModeKind | null {
  return isClassic(mode) ? null : kindOf(mode, mode.anchorKind);
}

/** The anchor's small corner mark on the progress slot and the reveal ("🍞" for the bread). */
export function anchorMark(mode: CookoutModeInfo): string {
  return mode.anchorKind === "bread" ? "🍞" : mode.emoji;
}

/** Whether a basket item is the round's anchor: its kind says so, or (an older snapshot without a kind)
 * it was turn 1, which a mode with an anchor always gives to the anchor (09c §2.1). */
export function isAnchorPick(mode: CookoutModeInfo, snap: PickSnap): boolean {
  if (mode.anchorKind === null || isClassic(mode)) return false;
  if (snap.kind !== null) return snap.kind === mode.anchorKind;
  return snap.turn === 1;
}

/** The anchor ingredient of a basket, when this viewer can see it. */
export function anchorPick(mode: CookoutModeInfo, picks: readonly PickSnap[]): PickSnap | null {
  return picks.find((p) => isAnchorPick(mode, p)) ?? null;
}

/** The anchor first, then the rest in their order (the chef's carousel, 09c §6.4). */
export function anchorFirst(mode: CookoutModeInfo, picks: readonly PickSnap[]): PickSnap[] {
  const anchor = anchorPick(mode, picks);
  return anchor === null ? [...picks] : [anchor, ...picks.filter((p) => p !== anchor)];
}

/** How many of a full basket's turns are fillings (every turn after the anchor's one). */
export function fillingTurns(mode: CookoutModeInfo): number {
  return mode.anchorKind === null ? mode.turns : mode.turns - 1;
}

/** The round's mode is not Classic (the mode-specific words apply). */
export function isModeRound(view: CookoutView): boolean {
  return !isClassic(view.mode);
}

/** A mode intro line with its `{starter}` filled in (09c §5.4): the starter's name, or — for the starter
 * themselves — "You" with the verb agreeing ("{starter} picks the bread" → "You pick the bread"). */
export function fillStarter(line: string, starter: string | null, viewerIsStarter: boolean): string {
  if (!line.includes("{starter}")) return line;
  if (viewerIsStarter) {
    const agreed = line.replace(/\{starter\}(\s+)([a-z]+?)(e?)s\b/g, (_m, space: string, stem: string, e: string) => {
      // "picks" → "pick", "goes" → "go", "makes" → "make".
      return `{you}${space}${stem}${e === "e" && /(?:sh|ch|ss|x|o|z)$/.test(stem) ? "" : e}`;
    });
    return capitaliseStarts(agreed.replace(/\{(?:starter|you)\}/g, "you"));
  }
  return capitaliseStarts(line.replace(/\{starter\}/g, starter ?? "Player 1"));
}

/** Capitalises the first letter of a line (a filled-in "you" at its start). */
function capitaliseStarts(line: string): string {
  return line.replace(/^\s*[a-z]/, (c) => c.toUpperCase());
}
