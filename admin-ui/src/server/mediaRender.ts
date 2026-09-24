/** DOM renderers for server-chat photo, video and voice attachments. */

export type AttachmentKind = "photo" | "video" | "voice";
export type AttachmentStatus = "processing" | "ready" | "failed";
export type SuspendReason = "recording" | "micPermission" | "filePicker" | "mediaPlaying";

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
}

export interface MediaRenderHooks {
  suspend(reason: SuspendReason): () => void;
}

export interface MediaRenderContext {
  readonly hooks: MediaRenderHooks;
  /** P5a supplies the shared lightbox opener; this module never owns a second one. */
  readonly openLightbox?: (source: string, alt: string) => void;
  readonly document?: Document;
}

const releasePlaybackByElement = new WeakMap<HTMLMediaElement, () => void>();

export function renderAttachments(
  attachments: readonly Attachment[],
  context: MediaRenderContext,
): HTMLElement {
  const documentRef = context.document ?? document;
  const container = documentRef.createElement("div");
  container.className = "wx-srv-attachments";
  let photoGrid: HTMLElement | null = null;
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
    elapsed.textContent = `${formatDuration(audio.currentTime)} / ${formatDuration(
      Number.isFinite(audio.duration) ? audio.duration : attachment.durationS ?? 0,
    )}`;
  });
  audio.addEventListener("loadedmetadata", () => {
    elapsed.textContent = `0:00 / ${formatDuration(
      Number.isFinite(audio.duration) ? audio.duration : attachment.durationS ?? 0,
    )}`;
  });
  playButton.addEventListener("click", () => {
    if (audio.paused) {
      const playResult = audio.play();
      void playResult?.catch(() => stopped());
    } else {
      audio.pause();
    }
  });
  root.append(playButton, waveform, elapsed, audio);
  return root;
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

function formatDuration(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const minutes = Math.floor(safeSeconds / 60);
  return `${minutes}:${String(safeSeconds % 60).padStart(2, "0")}`;
}
