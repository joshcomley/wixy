// The public page's two URLs (spec/adventure-public section 1, 2.4): `/` is a fresh game and
// `/d/<code>` is one place, shown at once. The code is the short code the server computes (6 lowercase
// characters, 8 where two places collided); anything that is not shaped like one is just the home page.

export type Route = { readonly kind: "home" } | { readonly kind: "place"; readonly code: string };

const PLACE_PATH = /^\/d\/([a-z0-9]{6,12})\/?$/;

export function parseRoute(pathname: string): Route {
  const match = PLACE_PATH.exec(pathname);
  const code = match?.[1];
  return code === undefined ? { kind: "home" } : { kind: "place", code };
}

export function placePath(code: string): string {
  return `/d/${code}`;
}

/** The absolute short link of a place: `https://adventure.cinnamons.uk/d/<code>`. */
export function placeUrl(origin: string, code: string): string {
  return `${origin}${placePath(code)}`;
}
