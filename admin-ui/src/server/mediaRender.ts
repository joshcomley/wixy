/** DOM renderers for server-chat photo, video and voice attachments. */

import { isAudioConfirmEnabled } from "./audioConfirmPreference";
import { renderTranscriptBlock, type TranscriptionContext } from "./transcript";

export type AttachmentKind = "photo" | "video" | "voice";
export type AttachmentStatus = "processing" | "ready" | "failed";
export type SuspendReason = "recording" | "micPermission" | "filePicker" | "mediaPlaying";

/** A voice note's opt-in transcript (spec/server-chat/05-voice-transcription.md): absent/`null`
 * until someone asks; `text` only once `done`. */
export type AttachmentTranscript =
  | { readonly status: "pending"; readonly text?: string | null }
  | { readonly status: "failed"; readonly text?: string | null }
  | { readonly status: "done"; readonly text: string };

export interface Attachment {
  readonly id: string;
  readonly kind: AttachmentKind;
  readonly status: AttachmentStatus;
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
}

export interface MediaRenderHooks {
  suspend(reason: SuspendReason): () => void;
}

export interface MediaRenderContext {
  readonly hooks: MediaRenderHooks;
  /** P5a supplies the shared lightbox opener; this module never owns a second one. */
  readonly openLightbox?: (source: string, alt: string) => void;
  /** When present, every ready voice note gets the opt-in Transcribe control beneath it. */
  readonly transcription?: TranscriptionContext;
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
  const lastTranscribable = timeElement ? [...attachments].reverse().find(a => a.kind === "voice" && a.status === "ready" && context.transcription) : undefined;
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
      if (attachment.kind === "voice" && attachment.status === "ready" && context.transcription) {
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
  if (attachment.status === "processing") return stateElement("Processing…", "processing", documentRef);
  if (attachment.status === "failed") {
    return stateElement("Couldn't process this file", "failed", documentRef);
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
  image.src = attachment.urls.thumb ?? attachment.urls.full ?? "";
  image.alt = "Attached photo";
  image.loading = "lazy";
  if (attachment.width !== null) image.width = attachment.width;
  if (attachment.height !== null) image.height = attachment.height;
  button.appendChild(image);
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
  audio.preload = "none";
  if (attachment.urls.play) audio.src = attachment.urls.play;
  audio.setAttribute("aria-hidden", "true");
  const playButton = documentRef.createElement("button");
  playButton.type = "button";
  playButton.className = "wx-srv-voice-play";
  playButton.setAttribute("aria-label", "Play voice note");
  playButton.textContent = "Play";
  const waveform = renderWaveform(attachment.peaks ?? [], documentRef);
  const backButton = renderSkipButton(documentRef, "back");
  const forwardButton = renderSkipButton(documentRef, "forward");
  const seekBar = documentRef.createElement("input");
  seekBar.type = "range";
  seekBar.className = "wx-srv-voice-seek";
  seekBar.min = "0";
  seekBar.step = "0.1";
  seekBar.value = "0";
  seekBar.setAttribute("aria-label", "Voice note position");
  const knownDuration = () =>
    Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : attachment.durationS ?? 0;
  const syncSeekBar = () => {
    const total = knownDuration();
    seekBar.max = String(total);
    seekBar.value = String(Math.min(audio.currentTime, total));
    seekBar.style.setProperty("--wx-srv-seek", total > 0 ? String(Math.min(1, audio.currentTime / total)) : "0");
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
    playButton.textContent = "Pause";
    playButton.setAttribute("aria-label", "Pause voice note");
  });
  const stopped = () => {
    releaseMedia();
    playButton.textContent = "Play";
    playButton.setAttribute("aria-label", "Play voice note");
  };
  audio.addEventListener("pause", stopped);
  audio.addEventListener("ended", stopped);
  audio.addEventListener("emptied", stopped);
  audio.addEventListener("timeupdate", () => {
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
  seekBar.addEventListener("input", () => seekTo(Number(seekBar.value)));
  wireSkipButton(backButton, -1, audio, seekTo, documentRef);
  wireSkipButton(forwardButton, 1, audio, seekTo, documentRef);
  root.append(playButton, backButton, forwardButton, waveform, elapsed, seekBar, audio, confirmBox);
  return root;
}

/** A tap skips this far; holding scrubs at HOLD_SEEK_RATE times normal speed. */
export const VOICE_SKIP_S = 10;
export const VOICE_HOLD_SEEK_RATE = 2.5;
export const VOICE_HOLD_DELAY_MS = 350;
const HOLD_TICK_MS = 100;

function renderSkipButton(documentRef: Document, direction: "back" | "forward"): HTMLButtonElement {
  const button = documentRef.createElement("button");
  button.type = "button";
  button.className = `wx-srv-voice-skip wx-srv-voice-skip-${direction}`;
  button.textContent = direction === "back" ? "−10" : "+10";
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

function wireMediaSuspension(element: HTMLMediaElement, hooks: MediaRenderHooks): void {
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
