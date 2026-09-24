import { describe, expect, it, vi } from "vitest";
import type { ChatAttachment } from "../src/api";
import {
  mountChatComposer,
  type ChatComposerOptions,
  type ChatComposerUploadContext,
} from "../src/chatComposer";

function fakeWindow(overrides: Record<string, unknown> = {}): Window {
  return {
    crypto: { randomUUID: () => "test-uuid" },
    ...overrides,
  } as unknown as Window;
}

function makeOptions(overrides: Partial<ChatComposerOptions> = {}): ChatComposerOptions {
  return {
    mode: "composer",
    placeholder: "Message…",
    submitLabel: "Send",
    upload: vi.fn(async (): Promise<ChatAttachment> => ({ attachmentId: "att-1", width: 10, height: 10 })),
    onSubmit: vi.fn(),
    win: fakeWindow(),
    ...overrides,
  };
}

function pngFile(name = "photo.png"): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
}

function voiceFile(name = "voice-note.webm"): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "audio/webm" });
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("mountChatComposer", () => {
  it("submit fires with Enter (not Shift+Enter) and the submit button", () => {
    const onSubmit = vi.fn();
    const composer = mountChatComposer(makeOptions({ onSubmit }));
    const textarea = composer.element.querySelector("textarea")!;
    textarea.value = "hello";

    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }),
    );
    expect(onSubmit).not.toHaveBeenCalled();

    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", shiftKey: false, bubbles: true, cancelable: true }),
    );
    expect(onSubmit).toHaveBeenCalledTimes(1);

    composer.element.querySelector<HTMLButtonElement>(".wx-chat-send-button")?.click();
    expect(onSubmit).toHaveBeenCalledTimes(2);
    composer.teardown();
  });

  it("an empty submit is a no-op by default but allowed with allowEmptySubmit", () => {
    const gated = mountChatComposer(makeOptions({ onSubmit: vi.fn() }));
    gated.element.querySelector<HTMLButtonElement>(".wx-chat-send-button")?.click();
    expect(gated.text()).toBe("");

    const onSubmit = vi.fn();
    const allowed = mountChatComposer(makeOptions({ mode: "compose", allowEmptySubmit: true, onSubmit }));
    allowed.element.querySelector<HTMLButtonElement>(".wx-chat-send-button")?.click();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    gated.teardown();
    allowed.teardown();
  });

  it("compose mode keeps the legacy actions row with Start first, Cancel second", () => {
    const onCancel = vi.fn();
    const composer = mountChatComposer(makeOptions({ mode: "compose", submitLabel: "Start", onCancel }));
    const buttons = composer.element.querySelectorAll<HTMLButtonElement>(".wx-chat-compose-actions button");
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.textContent).toBe("Start");
    expect(buttons[1]?.textContent).toBe("Cancel");
    buttons[1]?.click();
    expect(onCancel).toHaveBeenCalledTimes(1);
    composer.teardown();
  });

  it("the attach button stays hidden until support is confirmed, then reveals", () => {
    const composer = mountChatComposer(makeOptions());
    const button = composer.element.querySelector<HTMLElement>(".wx-chat-attach-button");
    expect(button?.hidden).toBe(true);
    composer.setAttachmentsSupported(true);
    expect(button?.hidden).toBe(false);
    composer.teardown();
  });

  it("picking a file uploads it, renders a chip, and resolves its id", async () => {
    const upload = vi.fn(async () => ({ attachmentId: "att-9", width: 10, height: 10 }));
    const composer = mountChatComposer(makeOptions({ upload }));
    composer.setAttachmentsSupported(true);

    const fileInput = composer.element.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = pngFile();
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
    fileInput.dispatchEvent(new Event("change"));
    await flush();

    // sec.10 P5a widened `upload` to `(file, ctx)` so a caller can report
    // progress/observe an abort signal (spec/server-chat/00-brief.md §10) —
    // the file argument itself, and the resulting upload, is unchanged.
    expect(upload).toHaveBeenCalledWith(file, expect.anything());
    expect(composer.element.querySelectorAll(".wx-chat-attachment-chip")).toHaveLength(1);
    expect(composer.attachmentIds()).toEqual(["att-9"]);
    expect(composer.element.querySelector<HTMLElement>(".wx-chat-attachment-row")?.hidden).toBe(false);
    composer.teardown();
  });

  it("releases the picker suspension on both selection and cancellation", () => {
    const release = vi.fn();
    const composer = mountChatComposer(makeOptions({ onFilePickerOpen: () => release }));
    composer.setAttachmentsSupported(true);
    composer.element.querySelector<HTMLButtonElement>(".wx-chat-attach-button")?.click();

    expect(release).not.toHaveBeenCalled();
    composer.element.querySelector<HTMLInputElement>('input[type="file"]')?.dispatchEvent(new Event("cancel"));
    expect(release).toHaveBeenCalledTimes(1);

    composer.element.querySelector<HTMLButtonElement>(".wx-chat-attach-button")?.click();
    composer.element.querySelector<HTMLInputElement>('input[type="file"]')?.dispatchEvent(new Event("change"));
    expect(release).toHaveBeenCalledTimes(2);
    composer.teardown();
  });

  it("stages a recorder file through addFile even when the picker type filter excludes audio", async () => {
    const upload = vi.fn(async () => ({ attachmentId: "voice-1", width: null, height: null }));
    const composer = mountChatComposer(
      makeOptions({ acceptFile: (file) => file.type.startsWith("image/") || file.type.startsWith("video/"), upload }),
    );
    const file = voiceFile();
    composer.addFile(file);
    await flush();

    expect(upload).toHaveBeenCalledWith(file, expect.anything());
    expect(composer.attachmentIds()).toEqual(["voice-1"]);
    composer.teardown();
  });

  it("submit is disabled while an upload is in flight, and re-enabled when it resolves", async () => {
    let resolveUpload!: (value: ChatAttachment) => void;
    const upload = vi.fn(
      () => new Promise<ChatAttachment>((resolve) => {
        resolveUpload = resolve;
      }),
    );
    const composer = mountChatComposer(makeOptions({ upload }));

    const fileInput = composer.element.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(fileInput, "files", { value: [pngFile()], configurable: true });
    fileInput.dispatchEvent(new Event("change"));
    await flush();

    const submit = composer.element.querySelector<HTMLButtonElement>(".wx-chat-send-button")!;
    expect(submit.disabled).toBe(true);
    expect(composer.hasUploadsInFlight()).toBe(true);

    resolveUpload({ attachmentId: "att-4", width: 10, height: 10 });
    await flush();
    expect(submit.disabled).toBe(false);
    expect(composer.hasUploadsInFlight()).toBe(false);
    composer.teardown();
  });

  it("a failed upload drops the chip and surfaces the error without blocking submit", async () => {
    const upload = vi.fn(async (): Promise<ChatAttachment> => {
      throw new Error("image exceeds the 5MB limit");
    });
    const composer = mountChatComposer(makeOptions({ upload }));

    const fileInput = composer.element.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(fileInput, "files", { value: [pngFile()], configurable: true });
    fileInput.dispatchEvent(new Event("change"));
    await flush();

    expect(composer.element.querySelectorAll(".wx-chat-attachment-chip")).toHaveLength(0);
    const error = composer.element.querySelector<HTMLElement>(".wx-chat-composer-error");
    expect(error?.hidden).toBe(false);
    expect(error?.textContent).toBe("image exceeds the 5MB limit");
    expect(composer.element.querySelector<HTMLButtonElement>(".wx-chat-send-button")?.disabled).toBe(false);
    composer.teardown();
  });

  it("removing a chip drops the attachment before submit", async () => {
    const composer = mountChatComposer(makeOptions());
    const fileInput = composer.element.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(fileInput, "files", { value: [pngFile()], configurable: true });
    fileInput.dispatchEvent(new Event("change"));
    await flush();
    expect(composer.element.querySelectorAll(".wx-chat-attachment-chip")).toHaveLength(1);

    composer.element.querySelector<HTMLButtonElement>(".wx-chat-attachment-remove")?.click();
    expect(composer.element.querySelectorAll(".wx-chat-attachment-chip")).toHaveLength(0);
    expect(composer.attachmentIds()).toEqual([]);
    composer.teardown();
  });

  it("reset clears text, chips, and the error", async () => {
    const composer = mountChatComposer(makeOptions());
    const textarea = composer.element.querySelector("textarea")!;
    textarea.value = "some text";
    composer.setError("boom");

    const fileInput = composer.element.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(fileInput, "files", { value: [pngFile()], configurable: true });
    fileInput.dispatchEvent(new Event("change"));
    await flush();

    composer.reset();
    expect(composer.text()).toBe("");
    expect(composer.attachmentIds()).toEqual([]);
    expect(composer.element.querySelectorAll(".wx-chat-attachment-chip")).toHaveLength(0);
    expect(composer.element.querySelector<HTMLElement>(".wx-chat-composer-error")?.hidden).toBe(true);
    composer.teardown();
  });

  it("setBusy disables the textarea and submit", () => {
    const composer = mountChatComposer(makeOptions());
    composer.setBusy(true);
    expect(composer.element.querySelector("textarea")?.disabled).toBe(true);
    expect(composer.element.querySelector<HTMLButtonElement>(".wx-chat-send-button")?.disabled).toBe(true);
    composer.setBusy(false);
    expect(composer.element.querySelector("textarea")?.disabled).toBe(false);
    composer.teardown();
  });

  it("the empty state is pinned to one line via the max-height class, in both paths", () => {
    // decisions/00113: the empty composer is a SINGLE line — pinned by the
    // `.wx-chat-input-empty` max-height class (field-sizing: content
    // overrides an inline height but honors a max-height clamp). jsdom has
    // no field-sizing support, so the fallback path is exercised here; the
    // class toggle itself is path-independent.
    const composer = mountChatComposer(makeOptions());
    const textarea = composer.element.querySelector("textarea")!;
    expect(textarea.classList.contains("wx-chat-input-empty")).toBe(true);
    expect(textarea.rows).toBe(1);

    textarea.value = "line one\nline two\nline three";
    textarea.dispatchEvent(new Event("input"));
    expect(textarea.classList.contains("wx-chat-input-empty")).toBe(false);
    expect(textarea.rows).toBe(2);
    const height = parseInt(textarea.style.height || "0", 10);
    expect(height).toBeGreaterThanOrEqual(36);
    expect(height).toBeLessThanOrEqual(180);

    // Empty again → back to the pinned one-line floor.
    textarea.value = "";
    textarea.dispatchEvent(new Event("input"));
    expect(textarea.classList.contains("wx-chat-input-empty")).toBe(true);
    expect(textarea.rows).toBe(1);
    composer.teardown();
  });

  // workspace #29 sec.10 P5a: chatComposer generalised for the server chat
  // (spec/server-chat/00-brief.md §10) — accept/acceptFile/renderChipPreview/
  // extraButtons/upload(file, ctx). Every option above this point exercises
  // the DEFAULTS (i.e. what the AI composer still gets); these exercise the
  // new overrides themselves.
  describe("sec.10 P5a generalisation", () => {
    it("accept defaults to image/*, and is overridable", () => {
      const defaultComposer = mountChatComposer(makeOptions());
      expect(defaultComposer.element.querySelector("input[type=file]")?.getAttribute("accept")).toBe(
        "image/*",
      );
      defaultComposer.teardown();

      const custom = mountChatComposer(makeOptions({ accept: "audio/*,video/*" }));
      expect(custom.element.querySelector("input[type=file]")?.getAttribute("accept")).toBe(
        "audio/*,video/*",
      );
      custom.teardown();
    });

    it("acceptFile overrides which picked files are staged", async () => {
      const upload = vi.fn(async (): Promise<ChatAttachment> => ({ attachmentId: "a", width: 1, height: 1 }));
      const composer = mountChatComposer(
        makeOptions({ upload, acceptFile: (file) => file.type.startsWith("audio/") }),
      );

      const fileInput = composer.element.querySelector<HTMLInputElement>('input[type="file"]')!;
      const imageFile = pngFile();
      const audioFile = new File([new Uint8Array([1])], "note.webm", { type: "audio/webm" });
      Object.defineProperty(fileInput, "files", { value: [imageFile, audioFile], configurable: true });
      fileInput.dispatchEvent(new Event("change"));
      await flush();

      expect(upload).toHaveBeenCalledTimes(1);
      expect(upload).toHaveBeenCalledWith(audioFile, expect.anything());
      composer.teardown();
    });

    it("acceptFile also gates paste", async () => {
      const upload = vi.fn(async (): Promise<ChatAttachment> => ({ attachmentId: "a", width: 1, height: 1 }));
      const composer = mountChatComposer(
        makeOptions({ upload, acceptFile: (file) => file.type.startsWith("audio/") }),
      );
      const textarea = composer.element.querySelector("textarea")!;
      const imageFile = pngFile();
      const pasteEvent = Object.assign(new Event("paste", { cancelable: true }), {
        clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => imageFile }] },
      });
      textarea.dispatchEvent(pasteEvent);
      await flush();

      expect(upload).not.toHaveBeenCalled();
      composer.teardown();
    });

    it("renderChipPreview overrides the default <img> chip preview", async () => {
      const renderChipPreview = vi.fn((file: File) => {
        const el = document.createElement("span");
        el.className = "fake-audio-chip";
        el.textContent = file.name;
        return el;
      });
      const composer = mountChatComposer(makeOptions({ renderChipPreview }));
      const fileInput = composer.element.querySelector<HTMLInputElement>('input[type="file"]')!;
      const file = pngFile("clip.png");
      Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
      fileInput.dispatchEvent(new Event("change"));
      await flush();

      expect(renderChipPreview).toHaveBeenCalledWith(file, expect.any(String));
      const chip = composer.element.querySelector(".wx-chat-attachment-chip");
      expect(chip?.querySelector(".fake-audio-chip")?.textContent).toBe("clip.png");
      expect(chip?.querySelector("img.wx-chat-attachment-thumb")).toBeNull();
      composer.teardown();
    });

    it("without renderChipPreview, the default <img> thumb is used (byte-identical default)", async () => {
      const composer = mountChatComposer(makeOptions());
      const fileInput = composer.element.querySelector<HTMLInputElement>('input[type="file"]')!;
      const file = pngFile();
      Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
      fileInput.dispatchEvent(new Event("change"));
      await flush();

      const thumb = composer.element.querySelector<HTMLImageElement>(
        ".wx-chat-attachment-chip img.wx-chat-attachment-thumb",
      );
      expect(thumb).not.toBeNull();
      composer.teardown();
    });

    it("extraButtons mounts after the attach button, before the textarea; omitted by default", () => {
      const withoutExtra = mountChatComposer(makeOptions());
      const rowWithout = Array.from(withoutExtra.element.querySelector(".wx-chatc-input-row")!.children).map(
        (el) => el.tagName,
      );
      expect(rowWithout).toEqual(["BUTTON", "INPUT", "TEXTAREA", "BUTTON"]);
      withoutExtra.teardown();

      const mic = document.createElement("button");
      mic.className = "fake-mic-button";
      const withExtra = mountChatComposer(makeOptions({ extraButtons: [mic] }));
      const row = withExtra.element.querySelector(".wx-chatc-input-row")!;
      expect(Array.from(row.children).indexOf(mic)).toBeGreaterThan(
        Array.from(row.children).indexOf(
          withExtra.element.querySelector(".wx-chat-attach-button")!,
        ),
      );
      expect(row.querySelector("textarea")?.previousElementSibling).toBe(mic);
      withExtra.teardown();
    });

    it("extraButtons survive compose mode's submit-button relocation into the actions row", () => {
      const mic = document.createElement("button");
      mic.className = "fake-mic-button";
      const composer = mountChatComposer(
        makeOptions({ mode: "compose", submitLabel: "Start", extraButtons: [mic] }),
      );
      const row = composer.element.querySelector(".wx-chatc-input-row")!;
      expect(Array.from(row.children)).toContain(mic);
      expect(row.querySelector("textarea")?.previousElementSibling).toBe(mic);
      // Compose mode still relocates the submit button into its own legacy
      // actions row (Start/Cancel) — extraButtons must not end up caught in
      // that move.
      const actionsButtons = composer.element.querySelectorAll(".wx-chat-compose-actions button");
      expect(Array.from(actionsButtons)).not.toContain(mic);
      composer.teardown();
    });

    it("upload receives (file, {onProgress, signal}); onProgress updates stagedAttachments()", async () => {
      let capturedOnProgress: ((loaded: number, total: number) => void) | undefined;
      let capturedSignal: AbortSignal | undefined;
      const upload = vi.fn((file: File, ctx: { onProgress: (l: number, t: number) => void; signal: AbortSignal }) => {
        capturedOnProgress = ctx.onProgress;
        capturedSignal = ctx.signal;
        return new Promise<ChatAttachment>(() => {
          // never resolves in this test -- we only inspect progress/signal
        });
      });
      const composer = mountChatComposer(makeOptions({ upload }));
      const fileInput = composer.element.querySelector<HTMLInputElement>('input[type="file"]')!;
      const file = pngFile();
      Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
      fileInput.dispatchEvent(new Event("change"));
      await flush();

      expect(capturedSignal?.aborted).toBe(false);
      capturedOnProgress?.(50, 100);
      expect(composer.stagedAttachments()[0]?.progress).toEqual({ loaded: 50, total: 100 });
      expect(composer.element.querySelector<HTMLProgressElement>(".wx-chat-attachment-progress")?.value).toBe(50);
      composer.teardown();
    });

    it("removing a chip mid-upload aborts its signal", async () => {
      let capturedSignal: AbortSignal | undefined;
      const upload = vi.fn((_file: File, ctx: ChatComposerUploadContext) => {
        capturedSignal = ctx.signal;
        return new Promise<ChatAttachment>((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      });
      const composer = mountChatComposer(makeOptions({ upload }));
      const fileInput = composer.element.querySelector<HTMLInputElement>('input[type="file"]')!;
      const file = pngFile();
      Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
      fileInput.dispatchEvent(new Event("change"));
      await flush();

      expect(capturedSignal?.aborted).toBe(false);
      composer.element.querySelector<HTMLButtonElement>(".wx-chat-attachment-remove")?.click();
      expect(capturedSignal?.aborted).toBe(true);
      await flush();
      expect(composer.element.querySelector<HTMLElement>(".wx-chat-composer-error")?.hidden).toBe(true);
      composer.teardown();
    });

    it("teardown aborts any still-in-flight upload", async () => {
      let capturedSignal: AbortSignal | undefined;
      const upload = vi.fn((_file: File, ctx: ChatComposerUploadContext) => {
        capturedSignal = ctx.signal;
        return new Promise<ChatAttachment>(() => {});
      });
      const composer = mountChatComposer(makeOptions({ upload }));
      const fileInput = composer.element.querySelector<HTMLInputElement>('input[type="file"]')!;
      const file = pngFile();
      Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
      fileInput.dispatchEvent(new Event("change"));
      await flush();

      composer.teardown();
      expect(capturedSignal?.aborted).toBe(true);
    });
  });
});
