// The public page's two URLs (spec/adventure-public section 1, 2.4): `/` is a fresh game and
// `/d/<code>` is one place, shown at once. The code is the short code the server computes: the
// lower-case 32-character alphabet below, 6 characters (8 where two places collided, longer in the
// unlikely event of more). `isCode` mirrors the server's `codes.is_code` EXACTLY, so the page and the
// server never disagree about what a code looks like.
//
// An address under `/d/` that is not exactly a code (upper case, a trailing slash, too short, anything
// else) is the same "that place isn't on the map" page the server renders for it - never a fresh game
// started at an address that names no place.

export type Route =
  | { readonly kind: "home" }
  | { readonly kind: "place"; readonly code: string }
  | { readonly kind: "missing" };

export const CODE_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
export const CODE_MIN_LENGTH = 6;
export const CODE_MAX_LENGTH = 40;

/** Whether `value` is shaped like a short code: the alphabet only, 6 to 40 characters (shape only). */
export function isCode(value: string): boolean {
  if (value.length < CODE_MIN_LENGTH || value.length > CODE_MAX_LENGTH) return false;
  for (const char of value) if (!CODE_ALPHABET.includes(char)) return false;
  return true;
}

const PLACE_PREFIX = "/d/";

export function parseRoute(pathname: string): Route {
  if (!pathname.startsWith(PLACE_PREFIX)) return { kind: "home" };
  const code = pathname.slice(PLACE_PREFIX.length);
  return isCode(code) ? { kind: "place", code } : { kind: "missing" };
}

export function placePath(code: string): string {
  return `/d/${code}`;
}

/** The absolute short link of a place: `https://adventure.cinnamons.uk/d/<code>`. */
export function placeUrl(origin: string, code: string): string {
  return `${origin}${placePath(code)}`;
}
