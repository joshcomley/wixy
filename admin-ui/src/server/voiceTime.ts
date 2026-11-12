/** Clock-style duration for voice notes: `m:ss`, and `h:mm:ss` from one hour up (a note can run
 * for four hours — spec/server-chat/06 §2.3). Negative and non-finite input reads as 0:00. */
export function formatVoiceTime(milliseconds: number): string {
  const seconds = Number.isFinite(milliseconds) ? Math.floor(Math.max(0, milliseconds) / 1000) : 0;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${rest}`;
  return `${minutes}:${rest}`;
}
