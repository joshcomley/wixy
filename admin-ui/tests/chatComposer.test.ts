import { describe, expect, it, vi } from "vitest";
import type { ChatAttachment } from "../src/api";
import { mountChatComposer, type ChatComposerOptions } from "../src/chatComposer";

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

    expect(upload).toHaveBeenCalledWith(file);
    expect(composer.element.querySelectorAll(".wx-chat-attachment-chip")).toHaveLength(1);
    expect(composer.attachmentIds()).toEqual(["att-9"]);
    expect(composer.element.querySelector<HTMLElement>(".wx-chat-attachment-row")?.hidden).toBe(false);
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

  it("the jsdom auto-grow fallback pins the textarea to its floor height", () => {
    // jsdom has no `field-sizing: content` support and scrollHeight is always
    // 0, so the fallback path must clamp to the floor rather than collapsing
    // the textarea to nothing.
    const composer = mountChatComposer(makeOptions());
    const textarea = composer.element.querySelector("textarea")!;
    textarea.value = "line one\nline two\nline three";
    textarea.dispatchEvent(new Event("input"));
    const height = parseInt(textarea.style.height || "0", 10);
    expect(height).toBeGreaterThanOrEqual(44);
    expect(height).toBeLessThanOrEqual(180);
    composer.teardown();
  });
});
