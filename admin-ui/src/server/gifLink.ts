// GIFs in the server chat (decisions/00180). A phone keyboard's GIF picker (Samsung's KLIPY,
// Gboard/SwiftKey's Tenor, Giphy) puts a LINK into a web text box, not the image. The composer
// spots such a link, lifts it out of the text and attaches the GIF itself, so it is sent as a
// real animated GIF. The More menu's "Fry" item reuses the same fetch for its bundled GIF.
//
// Only links on these GIF hosts are taken: they are the providers keyboards use, and each
// serves its media with `Access-Control-Allow-Origin: *` (measured 2026-10-13), so the
// browser fetches the bytes itself — the server never fetches a URL on anyone's behalf.

/** Host suffixes whose `.gif` links become attachments. A host matches when it IS one of
 * these or ends with `.` + one of these (`media1.tenor.com`, `i.giphy.com`, …). */
export const GIF_LINK_HOSTS: readonly string[] = ["klipy.com", "tenor.com", "giphy.com"];

/** The photo upload cap (`MAX_UPLOAD_BYTES["photo"]` in `wixy_server/livechat/uploads.py`). */
export const MAX_GIF_BYTES = 30 * 1024 * 1024;

/** The bundled Fry ("not sure if…") squint GIF behind the More menu's Fry item. */
export const FRY_GIF_URL = "/admin/static/server-chat/fry-squint.gif";

export interface GifLinkMatch {
  readonly url: string;
  /** Index of the link's first character in the text. */
  readonly start: number;
  /** Index just past the link's last character. */
  readonly end: number;
}

function isGifHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return GIF_LINK_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** True when `candidate` is an https link to a `.gif` on one of `GIF_LINK_HOSTS`. */
export function isGifLink(candidate: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    parsed.username === "" &&
    parsed.password === "" &&
    isGifHost(parsed.hostname) &&
    parsed.pathname.toLowerCase().endsWith(".gif")
  );
}

/** Every whitespace-separated token in `text` that is a GIF link, in order. */
export function findGifLinks(text: string): GifLinkMatch[] {
  const matches: GifLinkMatch[] = [];
  const token = /\S+/g;
  for (let found = token.exec(text); found !== null; found = token.exec(text)) {
    if (isGifLink(found[0])) {
      matches.push({ url: found[0], start: found.index, end: found.index + found[0].length });
    }
  }
  return matches;
}

/** `text` with every match removed, each together with ONE whitespace character beside it
 * (the space a keyboard adds after an inserted link), and where the caret should go: where
 * the first link was. Text left holding only whitespace becomes empty. */
export function removeGifLinks(
  text: string,
  matches: readonly GifLinkMatch[],
): { readonly text: string; readonly caret: number } {
  let result = text;
  let caret = 0;
  for (const match of [...matches].sort((a, b) => b.start - a.start)) {
    let start = match.start;
    let end = match.end;
    if (end < result.length && /\s/.test(result[end]!)) end += 1;
    else if (start > 0 && /\s/.test(result[start - 1]!)) start -= 1;
    result = result.slice(0, start) + result.slice(end);
    caret = start;
  }
  // Removals run last-to-first, so `caret` ends on the earliest link's place, which no later
  // removal can have shifted.
  if (result.trim() === "") return { text: "", caret: 0 };
  return { text: result, caret: Math.min(caret, result.length) };
}

export class GifFetchError extends Error {}

function fileNameFor(url: string): string {
  try {
    const last = new URL(url, "https://x.invalid/").pathname.split("/").pop() ?? "";
    const base = last.replace(/[^A-Za-z0-9._-]/g, "");
    if (base.toLowerCase().endsWith(".gif") && base.length > 4) return base;
  } catch {
    // Fall through to the generic name.
  }
  return "animated.gif";
}

/** Fetches `url` (cookies and referrer withheld) and returns it as an `image/gif` File, after
 * checking it is no bigger than `MAX_GIF_BYTES` and really starts with a GIF signature. */
export async function fetchGifFile(
  url: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<File> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      signal,
      credentials: url.startsWith("/") ? "same-origin" : "omit",
      referrerPolicy: "no-referrer",
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new GifFetchError("Couldn't download that GIF.");
  }
  if (!response.ok) throw new GifFetchError("Couldn't download that GIF.");
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_GIF_BYTES) {
    throw new GifFetchError("That GIF is too big to attach.");
  }
  const blob = await response.blob();
  if (blob.size > MAX_GIF_BYTES) throw new GifFetchError("That GIF is too big to attach.");
  const head = new Uint8Array(await blob.slice(0, 6).arrayBuffer());
  const signature = String.fromCharCode(...head);
  if (signature !== "GIF87a" && signature !== "GIF89a") {
    throw new GifFetchError("That link isn't a GIF.");
  }
  return new File([blob], fileNameFor(url), { type: "image/gif" });
}
