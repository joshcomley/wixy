/**
 * The voice-note bubble of a note that is still being recorded (spec/server-chat/07 §1).
 *
 * It looks like a voice note with a LIVE badge and a waveform that grows as the sender speaks
 * (one bar per second, fed by the hub's `state` messages). **Play** joins at the start, **Jump to
 * live** at the newest audio; pause/resume is ordinary. While the sender is paused the bubble says
 * "Paused". When the sender stops, the badge goes ("Finishing…") until the finished file arrives
 * and the thread replaces this bubble with the ordinary player: a listener who is mid-note is
 * handed over to the file at the same position (`rememberHandover` / `takeHandover`).
 *
 * `message_updated` for a live note (a status or `liveState` change, a transcript pass) is applied
 * to the existing bubble in place through `patchLiveVoiceBlocks` (never a rebuild), so audio that
 * is playing is not cut off. The sender's own bubble shows the same growing waveform without
 * Play and Jump to live: a phone must not play the microphone it is recording into.
 */

import { isAudioConfirmEnabled } from "../audioConfirmPreference";
import { HEARD_THRESHOLD } from "../heardStore";
import type { Attachment, MediaRenderContext } from "../mediaRender";
import { formatVoiceTime } from "../voiceTime";
import type { LiveAudioStatus, LiveVoiceHub, LiveVoiceModel } from "./hub";
import { FRAME_SAMPLES, SAMPLE_RATE, type LiveVoiceErrorCode, type PlayFrom } from "./protocol";

/** The waveform shows the newest 64 seconds; a longer note scrolls. */
export const LIVE_WAVEFORM_BARS = 64;

interface Controller {
  update(attachment: Attachment): void;
  dispose(): void;
}

const controllers = new WeakMap<HTMLElement, Controller>();

const ICON_OPEN =
  '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
const PLAY_ICON = `${ICON_OPEN}<polygon points="7 4 20 12 7 20 7 4" fill="currentColor"/></svg>`;
const PAUSE_ICON = `${ICON_OPEN}<rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor"/></svg>`;

const ERROR_TEXT: Readonly<Record<LiveVoiceErrorCode | "audio_failed", string>> = {
  too_many_listeners: "Too many people are listening live. Try again in a moment.",
  not_live: "This note is no longer live.",
  not_found: "This note is no longer live.",
  forbidden: "Couldn't play this live note.",
  bad_request: "Couldn't play this live note.",
  audio_failed: "Couldn't play audio. Tap play to try again.",
};

/** Peaks arrive as 0..255 integers over the socket; a stored note's are 0..1. Both become 0..1. */
export function normalizePeaks(peaks: readonly number[] | null | undefined): number[] {
  if (peaks === null || peaks === undefined || peaks.length === 0) return [];
  const scale = peaks.some((value) => value > 1) ? 255 : 1;
  return peaks.map((value) => (Number.isFinite(value) ? Math.max(0, Math.min(1, value / scale)) : 0));
}

export function renderLiveVoice(
  attachment: Attachment,
  context: MediaRenderContext,
  hub: LiveVoiceHub,
  documentRef: Document,
): HTMLElement {
  const own = context.ownMessage === true;
  let current = attachment;
  let model: LiveVoiceModel | null = null;
  let audio: LiveAudioStatus = { phase: "idle", positionSamples: null, error: null };
  let resumeSamples: number | null = null;
  let lastPositionSamples = 0;
  let online = hub.isOnline();
  let everOnline = online;
  let reportedListened = false;
  let release: (() => void) | null = null;
  let disposed = false;
  let error: string | null = null;
  /** The server said the note is no longer live (`not_live`) before any `ended` state arrived. */
  let forcedEnded = false;
  let pendingFrom: PlayFrom = "start";

  const root = documentRef.createElement("div");
  root.className = "wx-srv-voice wx-srv-voice-live";
  root.dataset["liveAttachmentId"] = attachment.id;

  const head = documentRef.createElement("div");
  head.className = "wx-srv-voice-live-head";
  const badge = documentRef.createElement("span");
  badge.className = "wx-srv-live-badge";
  const dot = documentRef.createElement("span");
  dot.className = "wx-srv-live-dot";
  dot.setAttribute("aria-hidden", "true");
  const badgeText = documentRef.createElement("span");
  badgeText.textContent = "LIVE";
  badge.append(dot, badgeText);
  badge.setAttribute("aria-label", "Live voice note");
  const status = documentRef.createElement("span");
  status.className = "wx-srv-live-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  head.append(badge, status);

  const scrub = documentRef.createElement("div");
  scrub.className = "wx-srv-voice-live-scrub";
  const waveform = documentRef.createElement("div");
  waveform.className = "wx-srv-voice-waveform wx-srv-voice-live-waveform";
  waveform.setAttribute("role", "img");
  waveform.setAttribute("aria-label", "Live voice note waveform");
  const playhead = documentRef.createElement("div");
  playhead.className = "wx-srv-voice-live-playhead";
  playhead.hidden = true;
  scrub.append(waveform, playhead);
  const bars: HTMLElement[] = [];

  const controls = documentRef.createElement("div");
  controls.className = "wx-srv-voice-controls wx-srv-voice-live-controls";
  const playButton = documentRef.createElement("button");
  playButton.type = "button";
  playButton.className = "wx-srv-voice-play";
  const jumpButton = documentRef.createElement("button");
  jumpButton.type = "button";
  jumpButton.className = "wx-srv-voice-live-jump";
  jumpButton.setAttribute("aria-label", "Jump to live");
  const jumpDot = documentRef.createElement("span");
  jumpDot.className = "wx-srv-live-dot";
  jumpDot.setAttribute("aria-hidden", "true");
  const jumpText = documentRef.createElement("span");
  jumpText.textContent = "Jump to live";
  jumpButton.append(jumpDot, jumpText);
  const time = documentRef.createElement("span");
  time.className = "wx-srv-voice-time";
  controls.append(playButton, jumpButton, time);

  const confirmBox = documentRef.createElement("div");
  confirmBox.className = "wx-srv-voice-confirm";
  confirmBox.hidden = true;
  const confirmText = documentRef.createElement("span");
  confirmText.className = "wx-srv-voice-confirm-prompt";
  confirmText.textContent = "Play audio message?";
  const confirmPlay = documentRef.createElement("button");
  confirmPlay.type = "button";
  confirmPlay.className = "wx-srv-voice-confirm-play";
  confirmPlay.textContent = "Play";
  const confirmCancel = documentRef.createElement("button");
  confirmCancel.type = "button";
  confirmCancel.className = "wx-srv-voice-confirm-cancel";
  confirmCancel.textContent = "Cancel";
  confirmBox.append(confirmText, confirmPlay, confirmCancel);

  root.append(head, scrub, controls, confirmBox);

  // -- derived state ----------------------------------------------------------------------

  const ended = (): boolean => forcedEnded || current.status !== "live" || model?.state === "ended";
  const paused = (): boolean => !ended() && (model?.state ?? current.liveState ?? "recording") === "paused";
  const durationMs = (): number => model?.durationMs ?? Math.max(0, (current.durationS ?? 0) * 1000);
  const streaming = (): boolean => audio.phase === "connecting" || audio.phase === "playing";
  const positionSamples = (): number => audio.positionSamples ?? resumeSamples ?? lastPositionSamples;

  function currentPeaks(): number[] {
    return model !== null ? normalizePeaks(model.peaks) : normalizePeaks(current.peaks);
  }

  function paintWaveform(): void {
    const peaks = currentPeaks();
    const shown = peaks.slice(-LIVE_WAVEFORM_BARS);
    while (bars.length < shown.length) {
      const bar = documentRef.createElement("span");
      bar.className = "wx-srv-voice-waveform-bar";
      waveform.appendChild(bar);
      bars.push(bar);
    }
    shown.forEach((peak, index) => {
      bars[index]?.style.setProperty("--wx-srv-wave-height", String(Math.max(0.08, peak)));
    });
    const live = !ended() && !paused();
    bars.forEach((bar, index) => bar.classList.toggle("wx-srv-voice-waveform-bar--edge", live && index === shown.length - 1));
    // The playhead sits on the bar for the second being played, when that bar is on screen.
    const total = peaks.length;
    const bucket = Math.floor(positionSamples() / SAMPLE_RATE);
    const first = Math.max(0, total - LIVE_WAVEFORM_BARS);
    const visible = (streaming() || resumeSamples !== null) && bucket >= first && bucket < total;
    playhead.hidden = !visible;
    if (visible) playhead.style.setProperty("--wx-srv-live-playhead", String((bucket - first + 0.5) / LIVE_WAVEFORM_BARS));
  }

  function statusText(): string {
    if (error !== null) return error;
    if (ended()) return "Finishing…";
    if (paused()) return "Paused";
    if (!online && everOnline) return "Reconnecting…";
    return "";
  }

  function paint(): void {
    const isEnded = ended();
    root.dataset["state"] = isEnded ? "ended" : paused() ? "paused" : "recording";
    badge.hidden = isEnded;
    const text = statusText();
    status.textContent = text;
    status.hidden = text === "";
    paintWaveform();

    playButton.hidden = own;
    jumpButton.hidden = own || isEnded;
    if (streaming()) {
      playButton.innerHTML = PAUSE_ICON;
      playButton.setAttribute("aria-label", "Pause live voice note");
    } else {
      playButton.innerHTML = PLAY_ICON;
      playButton.setAttribute(
        "aria-label",
        resumeSamples !== null ? "Resume live voice note" : "Play live voice note from the start",
      );
    }
    const total = formatVoiceTime(durationMs());
    time.textContent = own || (!streaming() && resumeSamples === null)
      ? total
      : `${formatVoiceTime((positionSamples() / SAMPLE_RATE) * 1000)} / ${total}`;
    time.hidden = false;
  }

  // -- audio ------------------------------------------------------------------------------

  function setHold(on: boolean): void {
    if (on && release === null) release = context.hooks.suspend("mediaPlaying");
    else if (!on && release !== null) {
      release();
      release = null;
    }
  }

  function maybeReportListened(force: boolean): void {
    if (reportedListened || !context.onVoiceListened) return;
    const total = durationMs();
    if (!force && !(ended() && total > 0 && (positionSamples() / SAMPLE_RATE) * 1000 >= total * HEARD_THRESHOLD)) return;
    reportedListened = true;
    context.onVoiceListened(current.id);
  }

  function start(from: PlayFrom): void {
    confirmBox.hidden = true;
    error = null;
    setHold(true);
    hub.play(current.id, from);
    paint();
  }

  function requestStart(from: PlayFrom): void {
    const askConfirm = context.win ? isAudioConfirmEnabled(context.win) : false;
    if (askConfirm) {
      pendingFrom = from;
      confirmBox.hidden = false;
      confirmPlay.focus();
    } else {
      start(from);
    }
  }

  playButton.addEventListener("click", () => {
    if (streaming()) {
      confirmBox.hidden = true;
      hub.stop(current.id);
      return;
    }
    requestStart(resumeSamples !== null ? Math.floor(resumeSamples / FRAME_SAMPLES) * FRAME_SAMPLES : "start");
  });
  jumpButton.addEventListener("click", () => requestStart("live"));
  confirmPlay.addEventListener("click", () => start(pendingFrom));
  confirmCancel.addEventListener("click", () => {
    confirmBox.hidden = true;
  });

  const unwatch = hub.watch(attachment.id, {
    onModel(next): void {
      if (disposed) return;
      model = next;
      maybeReportListened(false);
      paint();
    },
    onAudio(next): void {
      if (disposed) return;
      audio = next;
      if (next.positionSamples !== null) lastPositionSamples = next.positionSamples;
      if (next.error !== null) {
        error = ERROR_TEXT[next.error];
      }
      if (next.phase === "idle") {
        resumeSamples = next.error === null && next.positionSamples !== null ? next.positionSamples : null;
        setHold(false);
      } else if (next.phase === "finished") {
        resumeSamples = null;
        setHold(false);
        maybeReportListened(true);
      } else {
        resumeSamples = null;
        setHold(true);
        maybeReportListened(false);
      }
      paint();
    },
    onConnection(next): void {
      if (disposed) return;
      online = next;
      if (next) everOnline = true;
      paint();
    },
    onError(code): void {
      if (disposed) return;
      // A watch the server cannot follow any more: the note is over, and the finished file (or
      // its removal) follows through the ordinary message updates.
      if (code === "not_live" || code === "not_found") forcedEnded = true;
      paint();
    },
  });

  controllers.set(root, {
    update(next: Attachment): void {
      if (disposed) return;
      current = next;
      paint();
    },
    dispose(): void {
      if (disposed) return;
      const wasPlaying = streaming();
      const position = wasPlaying ? hub.stop(current.id) : null;
      const at = position ?? (resumeSamples ?? (lastPositionSamples > 0 ? lastPositionSamples : null));
      disposed = true;
      unwatch();
      setHold(false);
      if (wasPlaying || at !== null) {
        hub.rememberHandover(current.id, { positionS: (at ?? 0) / SAMPLE_RATE, playing: wasPlaying });
      }
    },
  });
  paint();
  return root;
}

function liveBubbles(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(".wx-srv-voice-live"));
}

/** Apply fresh attachment state (status, `liveState`, peaks, duration) to the live bubbles under `root`. */
export function patchLiveVoiceBlocks(root: ParentNode, attachments: readonly Attachment[]): void {
  const byId = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  for (const bubble of liveBubbles(root)) {
    const attachment = byId.get(bubble.dataset["liveAttachmentId"] ?? "");
    if (attachment !== undefined) controllers.get(bubble)?.update(attachment);
  }
}

/** Stop and unregister every live bubble under `root` (a rebuild, a delete, a lock). */
export function disposeLiveVoice(root: ParentNode): void {
  if (root instanceof Element && root.matches(".wx-srv-voice-live")) controllers.get(root as HTMLElement)?.dispose();
  for (const bubble of liveBubbles(root)) controllers.get(bubble)?.dispose();
}

interface ComparableMessage {
  readonly attachments: readonly Attachment[];
}

const isLiveish = (attachment: Attachment): boolean =>
  attachment.kind === "voice" && (attachment.status === "live" || attachment.status === "processing");

function withoutPatchable(prev: ComparableMessage, next: ComparableMessage): [string, string] | null {
  if (prev.attachments.length !== next.attachments.length) return null;
  const strip = (message: ComparableMessage, other: ComparableMessage): string =>
    JSON.stringify({
      ...message,
      attachments: message.attachments.map((attachment, index) => {
        const peer = other.attachments[index];
        const bothLive = peer !== undefined && isLiveish(attachment) && isLiveish(peer);
        const { liveState: _liveState, ...rest } = attachment;
        return bothLive
          ? { ...rest, status: "live", peaks: null, durationS: null, transcript: null }
          : { ...attachment, transcript: null };
      }),
    });
  return [strip(prev, next), strip(next, prev)];
}

/**
 * True when `next` differs from `prev` in nothing but what can be patched into a live bubble in
 * place: voice-note transcripts, and (for a note that is `live` or still `processing` after its
 * live phase) its status between those two, `liveState`, peaks and duration. A change to `ready`
 * or anything else still builds a fresh bubble, which is how the finished file replaces it.
 */
export function differOnlyInLiveOrTranscript(prev: ComparableMessage, next: ComparableMessage): boolean {
  const pair = withoutPatchable(prev, next);
  return pair !== null && pair[0] === pair[1];
}
