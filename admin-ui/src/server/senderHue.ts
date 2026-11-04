/**
 * A gentle, stable hue per chat member, keyed on the display name, so a thread with three or more
 * people can be told apart at a glance. Pure: the same name always gives the same hue, on every
 * device and across reloads, with nothing stored. The hues are spread around the wheel and only
 * ever applied at low saturation by chat.css, so they stay muted and sit inside either theme.
 */
const SENDER_HUES: readonly number[] = [8, 38, 95, 160, 190, 262, 300, 335];

/** FNV-1a over the trimmed, case-folded name (so "Sam" and "sam " share a colour). */
function hashName(name: string): number {
  let hash = 0x811c9dc5;
  const folded = name.trim().toLowerCase();
  for (let i = 0; i < folded.length; i += 1) {
    hash ^= folded.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** The hue (0-359) for a member name. */
export function senderHue(name: string): number {
  return SENDER_HUES[hashName(name) % SENDER_HUES.length] ?? 0;
}
