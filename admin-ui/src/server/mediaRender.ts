/** DOM renderers for server-chat photo, video and voice attachments. */

import { isAudioConfirmEnabled } from "./audioConfirmPreference";
import { HEARD_THRESHOLD } from "./heardStore";
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
  /** Called once per voice note when playback reaches `HEARD_THRESHOLD` of its length (or it
   * ends) — the "listened to" signal behind the unheard-voice-notes list. */
  readonly onVoiceListened?: (attachmentId: string) => void;
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
