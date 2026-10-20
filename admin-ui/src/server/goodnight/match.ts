// Does a message say good night? (spec/server-chat/goodnight-scene.md, "Trigger")
//
// Case-insensitive and whole-word. Punctuation, emoji and apostrophes are tolerated (the text
// is reduced to lowercase letters and single spaces first), and stretched letters are tolerated
// ("niiight", "goooodnight"). `gn` alone, "tonight", "last night" and "night out" never match.

const NIGHT = "n+i+g+h+t+";
const NITE = "n+i+t+e+";
// "good" needs at least two o's so a bare "god night" never fires.
const GOOD_NIGHT = `g+o{2,}d+ ?(?:${NIGHT}|${NITE})`;
const G_NIGHT = `g+(?:${NIGHT}|${NITE})`;
const NIGHT_NIGHT = `(?:${NIGHT}y*|${NITE}) ?(?:${NIGHT}|${NITE})`;
const PATTERN = new RegExp(`(?:^| )(?:${GOOD_NIGHT}|${G_NIGHT}|${NIGHT_NIGHT})(?= |$)`);

function letters(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’‘`]/g, "")
    .replace(/[^a-z]+/g, " ")
    .trim();
}

export function isGoodNight(text: string | null | undefined): boolean {
  if (typeof text !== "string" || text === "") return false;
  return PATTERN.test(letters(text));
}
