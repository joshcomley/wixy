/** DOM renderers for server-chat photo, video and voice attachments. */

import { isAudioConfirmEnabled } from "./audioConfirmPreference";
import { HEARD_THRESHOLD } from "./heardStore";
import type { LiveVoiceHub } from "./liveVoice/hub";
import { disposeLiveVoice, renderLiveVoice } from "./liveVoice/bubble";
import { isTranscribableVoice, renderTranscriptBlock, type TranscriptionContext } from "./transcript";

export type AttachmentKind = "photo" | "video" | "voice";
/** `live`: a voice note still being recorded (spec/server-chat/07-live-voice-notes.md §6.1). */
export type AttachmentStatus = "live" | "processing" | "ready" | "failed";
/** Whether the sender of a `live` note is recording or has paused. */
export type LiveState = "recording" | "paused";
export type SuspendReason = "recording" | "micPermission" | "filePicker" | "mediaPlaying";

/** A voice note's opt-in transcript (spec/server-chat/05-voice-transcription.md): absent/`null`
 * until someone asks; `text` only once `done`. `live` (spec 07 §6.3): the finalised text so far
 * and the provisional `tail`, rewritten on every pass until the final `done` object replaces it. */
export type AttachmentTranscript =
  | { readonly status: "pending"; readonly text?: string | null }
  | { readonly status: "failed"; readonly text?: string | null }
  | { readonly status: "done"; readonly text: string }
  | { readonly status: "live"; readonly text: string; readonly tail: string };

export interface Attachment {
  readonly id: string;
  readonly kind: AttachmentKind;
  readonly status: AttachmentStatus;
  /** Only while `status` is `live`. */
  readonly liveState?: LiveState;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationS: number | null;
  readonly peaks: readonly number[] | null;
  readonly urls: {
    readonly full?: string;
    readonly thumb?: string;
    readonly poster?: string;
    readonly play?: string;
  };
  readonly transcript?: AttachmentTranscript | null;
  /** True for a ready animated GIF: the bubble shows the moving `full` rendition, not the
   * still `thumb`. Absent on a server that predates the flag. */
  readonly animated?: boolean;
  /** True when the attachment is `failed` and its original is still kept, so it can be tried
   * again. Absent on a server that predates the flag. */
  readonly retryable?: boolean;
}

/** What asking the server to process a failed attachment again came back as. */
export type RetryResult =
  /** 202: the attachment is processing again; a `message_updated` event follows. */
  | { readonly kind: "started" }
  /** 410: the original is no longer kept, so it can never be tried again. */
  | { readonly kind: "gone" }
  /** 409: it is no longer failed (already processing or ready). */
  | { readonly kind: "in_progress" }
  /** Anything else, including a dropped connection. */
  | { readonly kind: "failed" };

export interface MediaRenderHooks {
  suspend(reason: SuspendReason): () => void;
}

export interface MediaRenderContext {
  readonly hooks: MediaRenderHooks;
  /** P5a supplies the shared lightbox opener; this module never owns a second one. */
  readonly openLightbox?: (source: string, alt: string) => void;
  /** When present, every ready voice note gets the opt-in Transcribe control beneath it. */
  readonly transcription?: TranscriptionContext;
  /** Called once per voice note when playback reaches `HEARD_THRESHOLD` of its length (or it
   * ends) — the "listened to" signal behind the unheard-voice-notes list. */
  readonly onVoiceListened?: (attachmentId: string) => void;
  /** When present, a failed attachment whose original is still kept gets a "Try again" button. */
  readonly retryAttachment?: (attachmentId: string) => Promise<RetryResult>;
  /** The page's live-voice listener hub (spec/server-chat/07): without it a `live` voice note is
   * drawn as a static "Live voice note" line. It also supplies the position a finished note is
   * handed over at when a live bubble is replaced by the file. */
  readonly liveVoice?: LiveVoiceHub;
  /** The message was sent from this device: its live bubble has no Play / Jump to live. */
  readonly ownMessage?: boolean;
  readonly document?: Document;
  readonly win?: Window;
}

const releasePlaybackByElement = new WeakMap<HTMLMediaElement, () => void>();

export function renderAttachments(
  attachments: readonly Attachment[],
  context: MediaRenderContext,
  timeElement?: HTMLElement
): HTMLElement {
  const documentRef = context.document ?? document;
  const container = documentRef.createElement("div");
  container.className = "wx-srv-attachments";
  let photoGrid: HTMLElement | null = null;
  const lastTranscribable = timeElement ? [...attachments].reverse().find(a => isTranscribableVoice(a) && context.transcription) : undefined;
  for (const attachment of attachments) {
    if (attachment.kind === "photo" && attachment.status === "ready") {
      if (!photoGrid) {
        photoGrid = documentRef.createElement("div");
        photoGrid.className = "wx-srv-photo-grid";
        container.appendChild(photoGrid);
      }
      photoGrid.appendChild(renderPhotoButton(attachment, context, documentRef));
    } else {
      container.appendChild(renderAttachment(attachment, context, documentRef));
      if (isTranscribableVoice(attachment) && context.transcription) {
        container.appendChild(renderTranscriptBlock(attachment, context.transcription, documentRef, attachment === lastTranscribable ? timeElement : undefined));
      }
    }
  }
  return container;
}

/** Stop rendered media and release its idle-lock suspension before its DOM
 * node is removed during a thread redraw or lock detach. Pause events are
 * asynchronous in browsers, so release the tracked suspension synchronously. */
export function disposeAttachmentMedia(root: ParentNode): void {
  // Live voice bubbles hold a socket registration and maybe a stream, not an element.
  disposeLiveVoice(root);
  for (const media of root.querySelectorAll<HTMLMediaElement>("audio, video")) {
    try {
      media.pause();
    } catch {
      // A detached or unsupported media element is already unusable.
    }
    releasePlaybackByElement.get(media)?.();
    media.removeAttribute("src");
    if (media.tagName === "VIDEO") media.removeAttribute("poster");
    try {
      media.load();
    } catch {
      // Older engines may not implement load() for an already detached node.
    }
  }
}

export function renderAttachment(
  attachment: Attachment,
  context: MediaRenderContext,
  documentRef: Document = context.document ?? document,
): HTMLElement {
  if (attachment.status === "live") {
    if (attachment.kind === "voice" && context.liveVoice) {
      return renderLiveVoice(attachment, context, context.liveVoice, documentRef);
    }
    return stateElement("Live voice note…", "processing", documentRef);
  }
  if (attachment.status === "processing") return stateElement("Processing…", "processing", documentRef);
  if (attachment.status === "failed") {
    const failed = stateElement(FAILED_TEXT, "failed", documentRef);
    if (attachment.retryable === true && context.retryAttachment) {
      return renderRetryableFailure(attachment.id, failed, context.retryAttachment, documentRef);
    }
    return failed;
  }

  if (attachment.kind === "photo") return renderPhoto(attachment, context, documentRef);
  if (attachment.kind === "video") return renderVideo(attachment, context, documentRef);
  return renderVoice(attachment, context, documentRef);
}

function renderPhoto(
  attachment: Attachment,
  context: MediaRenderContext,
  documentRef: Document,
): HTMLElement {
  const grid = documentRef.createElement("div");
  grid.className = "wx-srv-photo-grid";
  grid.appendChild(renderPhotoButton(attachment, context, documentRef));
  return grid;
}

function renderPhotoButton(
  attachment: Attachment,
  context: MediaRenderContext,
  documentRef: Document,
): HTMLButtonElement {
  const button = documentRef.createElement("button");
  button.type = "button";
  button.className = "wx-srv-photo-thumb";
  button.dataset["srvGestureBoundary"] = "";
  button.setAttribute("aria-label", "Open attached photo");
  const image = documentRef.createElement("img");
  // An animated GIF's still `thumb` is only its first frame, so the bubble shows `full` (the
  // original GIF bytes) and it plays in the thread like any chat app's GIF.
  const animated = attachment.animated === true && attachment.urls.full !== undefined;
  image.src = animated ? attachment.urls.full! : (attachment.urls.thumb ?? attachment.urls.full ?? "");
  image.alt = animated ? "Attached GIF" : "Attached photo";
  image.loading = "lazy";
  if (attachment.width !== null) image.width = attachment.width;
  if (attachment.height !== null) image.height = attachment.height;
  button.appendChild(image);
  if (animated) {
    button.classList.add("wx-srv-photo-animated");
    button.setAttribute("aria-label", "Open attached GIF");
    const badge = documentRef.createElement("span");
    badge.className = "wx-srv-gif-badge";
    badge.textContent = "GIF";
    badge.setAttribute("aria-hidden", "true");
    button.appendChild(badge);
  }
  if (attachment.urls.full && context.openLightbox) {
    button.addEventListener("click", () => context.openLightbox?.(attachment.urls.full!, image.alt));
  } else {
    button.disabled = true;
  }
  return button;
}

function renderVideo(
  attachment: Attachment,
  context: MediaRenderContext,
  documentRef: Document,
): HTMLElement {
  const video = documentRef.createElement("video");
  video.className = "wx-srv-video";
  video.preload = "none";
  video.playsInline = true;
  video.controls = true;
  if (attachment.urls.poster) video.poster = attachment.urls.poster;
  if (attachment.urls.play) video.src = attachment.urls.play;
  wireMediaSuspension(video, context.hooks);
  return video;
}

function renderVoice(
  attachment: Attachment,
  context: MediaRenderContext,
  documentRef: Document,
): HTMLElement {
  const root = documentRef.createElement("div");
  root.className = "wx-srv-voice";
  const audio = documentRef.createElement("audio");
  // A live note this device was listening to has just become this finished file: its position is
  // carried over below (spec/server-chat/07 §1). That needs the file's metadata, so load it.
  const handover = context.liveVoice?.takeHandover(attachment.id) ?? null;
  audio.preload = handover !== null && attachment.urls.play ? "metadata" : "none";
  if (attachment.urls.play) audio.src = attachment.urls.play;
  audio.setAttribute("aria-hidden", "true");
  const playButton = documentRef.createElement("button");
  playButton.type = "button";
  playButton.className = "wx-srv-voice-play";
  playButton.setAttribute("aria-label", "Play voice note");
  playButton.innerHTML = PLAY_ICON;
  const waveform = renderWaveform(attachment.peaks ?? [], documentRef);
  const backButton = renderSkipButton(documentRef, "back");
  const forwardButton = renderSkipButton(documentRef, "forward");
  const scrub = documentRef.createElement("div");
  scrub.className = "wx-srv-voice-scrub";
  const playhead = documentRef.createElement("div");
  playhead.className = "wx-srv-voice-playhead";
  const seekTab = documentRef.createElement("div");
  seekTab.className = "wx-srv-voice-seek-tab";
  seekTab.tabIndex = 0;
  seekTab.setAttribute("role", "slider");
  seekTab.setAttribute("aria-label", "Voice note position");
  seekTab.setAttribute("aria-valuemin", "0");
  scrub.append(waveform, playhead, seekTab);
  const knownDuration = () =>
    Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : attachment.durationS ?? 0;
  const syncSeekBar = () => {
    const total = knownDuration();
    seekTab.setAttribute("aria-valuemax", String(Math.round(total)));
    seekTab.setAttribute("aria-valuenow", String(Math.round(audio.currentTime)));
    scrub.style.setProperty("--wx-srv-seek", total > 0 ? String(Math.min(1, audio.currentTime / total)) : "0");
  };
  syncSeekBar();
  const elapsed = documentRef.createElement("span");
  elapsed.className = "wx-srv-voice-time";
  elapsed.textContent = `0:00 / ${formatDuration(attachment.durationS ?? 0)}`;
  let release: (() => void) | null = null;

  const releaseMedia = () => {
    release?.();
    release = null;
  };
  releasePlaybackByElement.set(audio, releaseMedia);
  audio.addEventListener("play", () => {
    releaseMedia();
    release = context.hooks.suspend("mediaPlaying");
    playButton.innerHTML = PAUSE_ICON;
    playButton.setAttribute("aria-label", "Pause voice note");
  });
  const stopped = () => {
    releaseMedia();
    playButton.innerHTML = PLAY_ICON;
    playButton.setAttribute("aria-label", "Play voice note");
  };
  audio.addEventListener("pause", stopped);
  audio.addEventListener("ended", stopped);
  audio.addEventListener("emptied", stopped);
  let reportedListened = false;
  const reportListened = (force: boolean) => {
    if (reportedListened || !context.onVoiceListened) return;
    const total = knownDuration();
    if (!force && !(total > 0 && audio.currentTime >= total * HEARD_THRESHOLD)) return;
    reportedListened = true;
    context.onVoiceListened(attachment.id);
  };
  audio.addEventListener("ended", () => reportListened(true));
  audio.addEventListener("timeupdate", () => {
    // Only natural playback counts: dragging the tab to the end of a note is not listening to it.
    if (!audio.paused) reportListened(false);
    syncSeekBar();
    elapsed.textContent = `${formatDuration(audio.currentTime)} / ${formatDuration(
      Number.isFinite(audio.duration) ? audio.duration : attachment.durationS ?? 0,
    )}`;
  });
  audio.addEventListener("loadedmetadata", () => {
    syncSeekBar();
    elapsed.textContent = `0:00 / ${formatDuration(
      Number.isFinite(audio.duration) ? audio.duration : attachment.durationS ?? 0,
    )}`;
  });
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

  const startPlayback = () => {
    const playResult = audio.play();
    void playResult?.catch(() => stopped());
  };

  confirmPlay.addEventListener("click", () => {
    confirmBox.hidden = true;
    startPlayback();
  });

  confirmCancel.addEventListener("click", () => {
    confirmBox.hidden = true;
  });

  playButton.addEventListener("click", () => {
    if (audio.paused) {
      const askConfirm = context.win ? isAudioConfirmEnabled(context.win) : false;
      if (askConfirm) {
        confirmBox.hidden = false;
        confirmPlay.focus();
      } else {
        confirmBox.hidden = true;
        startPlayback();
      }
    } else {
      confirmBox.hidden = true;
      audio.pause();
    }
  });
  const seekTo = (seconds: number) => {
    const total = knownDuration();
    audio.currentTime = Math.max(0, total > 0 ? Math.min(seconds, total) : seconds);
    syncSeekBar();
  };
  let dragging = false;
  const seekFromPointer = (clientX: number) => {
    const rect = scrub.getBoundingClientRect();
    if (rect.width <= 0) return;
    seekTo(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * knownDuration());
  };
  seekTab.addEventListener("pointerdown", (event) => {
    dragging = true;
    seekTab.setPointerCapture?.(event.pointerId);
    seekTab.classList.add("wx-srv-voice-seek-tab-active");
    event.preventDefault();
  });
  seekTab.addEventListener("pointermove", (event) => {
    if (dragging) seekFromPointer(event.clientX);
  });
  const endDrag = () => {
    dragging = false;
    seekTab.classList.remove("wx-srv-voice-seek-tab-active");
  };
  seekTab.addEventListener("pointerup", endDrag);
  seekTab.addEventListener("pointercancel", endDrag);
  seekTab.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    seekTo(audio.currentTime + (event.key === "ArrowRight" ? 5 : -5));
  });
  wireSkipButton(backButton, -1, audio, seekTo, documentRef);
  wireSkipButton(forwardButton, 1, audio, seekTo, documentRef);
  const controls = documentRef.createElement("div");
  controls.className = "wx-srv-voice-controls";
  controls.append(backButton, playButton, forwardButton, elapsed);
  root.append(scrub, controls, audio, confirmBox);

  // Carry on at the position the live bubble had reached, playing again if it was playing.
  if (handover !== null && attachment.urls.play) {
    const apply = () => {
      const total = knownDuration();
      audio.currentTime = total > 0 ? Math.min(handover.positionS, total) : handover.positionS;
      syncSeekBar();
      if (handover.playing) startPlayback();
    };
    if (audio.readyState >= 1) apply();
    else audio.addEventListener("loadedmetadata", apply, { once: true });
  }
  return root;
}

const ICON_OPEN =
  '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
const PLAY_ICON = `${ICON_OPEN}<polygon points="7 4 20 12 7 20 7 4" fill="currentColor"/></svg>`;
const PAUSE_ICON = `${ICON_OPEN}<rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor"/></svg>`;
const SKIP_LABEL =
  '<text x="12" y="15.4" font-size="8" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none">10</text>';
const BACK_ICON = `${ICON_OPEN}<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><polyline points="3.5 3.8 3.5 8.8 8.5 8.8"/>${SKIP_LABEL}</svg>`;
const FORWARD_ICON = `${ICON_OPEN}<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><polyline points="20.5 3.8 20.5 8.8 15.5 8.8"/>${SKIP_LABEL}</svg>`;

/** A tap skips this far; holding scrubs at HOLD_SEEK_RATE times normal speed. */
export const VOICE_SKIP_S = 10;
export const VOICE_HOLD_SEEK_RATE = 2.5;
export const VOICE_HOLD_DELAY_MS = 350;
const HOLD_TICK_MS = 100;

function renderSkipButton(documentRef: Document, direction: "back" | "forward"): HTMLButtonElement {
  const button = documentRef.createElement("button");
  button.type = "button";
  button.className = `wx-srv-voice-skip wx-srv-voice-skip-${direction}`;
  button.innerHTML = direction === "back" ? BACK_ICON : FORWARD_ICON;
  button.setAttribute(
    "aria-label",
    direction === "back" ? "Back 10 seconds (hold to rewind)" : "Forward 10 seconds (hold to fast-forward)",
  );
  return button;
}

/** Tap = jump 10s. Hold past the delay = continuous rewind / fast-forward at 2.5x (net of normal
 * playback, so it is 2.5x whether or not the note is playing). Keyboard activation (a click with
 * detail 0; a pointer click is already handled on release) also skips 10s. */
function wireSkipButton(
  button: HTMLButtonElement,
  direction: 1 | -1,
  audio: HTMLAudioElement,
  seekTo: (seconds: number) => void,
  documentRef: Document,
): void {
  const win: Window = documentRef.defaultView ?? window;
  let holdTimer: number | null = null;
  let tickTimer: number | null = null;
  let holding = false;
  let pointerActive = false;

  const stop = () => {
    if (holdTimer !== null) win.clearTimeout(holdTimer);
    if (tickTimer !== null) win.clearInterval(tickTimer);
    holdTimer = null;
    tickTimer = null;
  };
  const startHold = () => {
    holdTimer = null;
    holding = true;
    let last = win.performance.now();
    tickTimer = win.setInterval(() => {
      const now = win.performance.now();
      const dt = (now - last) / 1000;
      last = now;
      const natural = audio.paused ? 0 : 1;
      const rate = direction === 1 ? VOICE_HOLD_SEEK_RATE - natural : -(VOICE_HOLD_SEEK_RATE + natural);
      seekTo(audio.currentTime + rate * dt);
    }, HOLD_TICK_MS);
  };

  button.addEventListener("pointerdown", () => {
    pointerActive = true;
    holding = false;
    stop();
    holdTimer = win.setTimeout(startHold, VOICE_HOLD_DELAY_MS);
  });
  const release = () => {
    if (!pointerActive) return;
    pointerActive = false;
    const wasHolding = holding;
    stop();
    if (!wasHolding) seekTo(audio.currentTime + direction * VOICE_SKIP_S);
    holding = false;
  };
  button.addEventListener("pointerup", release);
  button.addEventListener("pointercancel", () => {
    pointerActive = false;
    stop();
  });
  button.addEventListener("contextmenu", (event) => event.preventDefault());
  button.addEventListener("click", (event) => {
    if (event.detail === 0) seekTo(audio.currentTime + direction * VOICE_SKIP_S);
  });
}

function renderWaveform(peaks: readonly number[], documentRef: Document): HTMLElement {
  const waveform = documentRef.createElement("div");
  waveform.className = "wx-srv-voice-waveform";
  waveform.setAttribute("aria-label", "Voice note waveform");
  waveform.setAttribute("role", "img");
  for (const peak of peaks) {
    const bar = documentRef.createElement("span");
    bar.className = "wx-srv-voice-waveform-bar";
    const height = Math.max(0.08, Math.min(1, Number.isFinite(peak) ? Math.abs(peak) : 0.08));
    bar.style.setProperty("--wx-srv-wave-height", String(height));
    waveform.appendChild(bar);
  }
  return waveform;
}

export function wireMediaSuspension(element: HTMLMediaElement, hooks: MediaRenderHooks): void {
  let release: (() => void) | null = null;
  const releaseMedia = () => {
    release?.();
    release = null;
  };
  releasePlaybackByElement.set(element, releaseMedia);
  element.addEventListener("play", () => {
    releaseMedia();
    release = hooks.suspend("mediaPlaying");
  });
  element.addEventListener("pause", releaseMedia);
  element.addEventListener("ended", releaseMedia);
  element.addEventListener("emptied", releaseMedia);
}

const FAILED_TEXT = "Couldn't process this file";
const RETRY_LABEL = "Try again";
const RETRYING_LABEL = "Trying again…";
const GONE_TEXT = "This file is no longer kept, so it can't be tried again.";
const RETRY_ERROR_TEXT = "Couldn't try again — please try once more.";

/** The failed-state text plus a "Try again" button. The button gives instant feedback, then
 * asks the server to reprocess; the `message_updated` event that follows a 202 re-renders the
 * whole bubble, so success needs no work here. */
function renderRetryableFailure(
  attachmentId: string,
  failed: HTMLElement,
  retry: (attachmentId: string) => Promise<RetryResult>,
  documentRef: Document,
): HTMLElement {
  const wrap = documentRef.createElement("div");
  wrap.className = "wx-srv-attachment-retry";
  const button = documentRef.createElement("button");
  button.type = "button";
  button.className = "wx-srv-attachment-retry-btn";
  button.dataset["srvGestureBoundary"] = "";
  button.textContent = RETRY_LABEL;
  const note = documentRef.createElement("span");
  note.className = "wx-srv-attachment-retry-note";
  note.setAttribute("role", "status");
  note.hidden = true;
  const restore = (): void => {
    button.disabled = false;
    button.textContent = RETRY_LABEL;
    note.textContent = RETRY_ERROR_TEXT;
    note.hidden = false;
  };
  button.addEventListener("pointerdown", (event) => event.stopPropagation());
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = RETRYING_LABEL;
    note.hidden = true;
    retry(attachmentId).then(
      (result) => {
        if (result.kind === "gone") {
          failed.textContent = GONE_TEXT;
          button.remove();
          note.remove();
        } else if (result.kind === "failed") {
          restore();
        }
        // "started" / "in_progress": stay in "Trying again…"; the live update re-renders.
      },
      restore,
    );
  });
  wrap.append(failed, button, note);
  return wrap;
}

function stateElement(text: string, state: "processing" | "failed", documentRef: Document): HTMLElement {
  const element = documentRef.createElement("span");
  element.className = `wx-srv-attachment-${state}`;
  element.textContent = text;
  element.setAttribute("role", "status");
  return element;
}

export function formatDuration(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const minutes = Math.floor(safeSeconds / 60);
  return `${minutes}:${String(safeSeconds % 60).padStart(2, "0")}`;
}
