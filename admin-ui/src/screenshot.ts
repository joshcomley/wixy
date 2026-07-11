// Screenshot capture for the admin shell's own chrome (Uxer's screenshot-
// button mandate). A desktop app captures its own window pixels directly;
// a browser tab has no equivalent privilege, so this uses the Web
// Platform's mechanism for "capture what's on screen with the user's
// explicit, per-call consent" — getDisplayMedia. It's true pixel capture
// (not DOM serialization), so it correctly includes the live-preview
// iframe in editView.ts/themePanel.ts, unlike a canvas/foreignObject-based
// approach. Chromium's `preferCurrentTab` hint pre-selects this tab in the
// picker so the flow stays a single confirm rather than a full
// screen/window/tab hunt.

export type ScreenshotOutcome =
  | { ok: true; blob: Blob }
  | { ok: false; reason: "unsupported" | "denied" | "capture-failed"; message: string };

interface DisplayMediaOptionsWithTabHint extends DisplayMediaStreamOptions {
  /** Chromium-only hint (harmless no-op elsewhere) that pre-selects the
   * calling tab in the source picker. */
  preferCurrentTab?: boolean;
}

async function grabFrame(stream: MediaStream, doc: Document): Promise<Blob> {
  const video = doc.createElement("video");
  video.srcObject = stream;
  video.muted = true;
  await video.play();
  if (video.readyState < 2) {
    await new Promise<void>((resolve) => video.addEventListener("loadeddata", () => resolve(), { once: true }));
  }

  const canvas = doc.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("Couldn't create a canvas context.");
  ctx.drawImage(video, 0, 0);
  video.pause();
  video.srcObject = null;

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (blob === null) throw new Error("Couldn't encode the screenshot.");
  return blob;
}

export async function captureScreenshot(win: Window = window): Promise<ScreenshotOutcome> {
  const mediaDevices = win.navigator.mediaDevices as MediaDevices | undefined;
  if (mediaDevices?.getDisplayMedia === undefined) {
    return { ok: false, reason: "unsupported", message: "Screenshot capture isn't supported in this browser." };
  }

  let stream: MediaStream;
  try {
    const options: DisplayMediaOptionsWithTabHint = {
      video: { displaySurface: "browser" },
      preferCurrentTab: true,
      audio: false,
    };
    stream = await mediaDevices.getDisplayMedia(options);
  } catch {
    return { ok: false, reason: "denied", message: "Screenshot permission was denied or cancelled." };
  }

  try {
    if (stream.getVideoTracks().length === 0) {
      return { ok: false, reason: "capture-failed", message: "No video was captured." };
    }
    const blob = await grabFrame(stream, win.document);
    return { ok: true, blob };
  } catch (error) {
    return { ok: false, reason: "capture-failed", message: error instanceof Error ? error.message : "Screenshot capture failed." };
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

export function downloadBlob(blob: Blob, filename: string, doc: Document = document): void {
  const url = URL.createObjectURL(blob);
  const link = doc.createElement("a");
  link.href = url;
  link.download = filename;
  doc.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export async function copyBlobToClipboard(blob: Blob, win: Window = window): Promise<boolean> {
  try {
    const clipboard = win.navigator.clipboard as Clipboard | undefined;
    if (clipboard?.write === undefined) return false;
    await clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    return true;
  } catch {
    return false;
  }
}

export function screenshotFilename(date: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `wixy-admin-${stamp}.png`;
}

/** ~150ms white flash overlay — Uxer's screenshot-button mandate's "flash
 * the screen briefly" feedback, adapted to a full-viewport fixed div since
 * a web page has no privileged way to flash the OS window chrome itself. */
export function flashScreen(doc: Document = document): void {
  const flash = doc.createElement("div");
  flash.className = "wx-screenshot-flash";
  doc.body.appendChild(flash);
  doc.defaultView?.requestAnimationFrame(() => {
    flash.classList.add("wx-screenshot-flash-fade");
  });
  setTimeout(() => flash.remove(), 200);
}
