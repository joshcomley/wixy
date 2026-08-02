// The shared chat composer (decisions/00110) — ONE component backing both the
// "New conversation" box on `#/chat` (mode "compose") and the always-visible
// composer pinned at the bottom of `#/chat/<conv>` (mode "composer"). Before
// this component the two flows were separate implementations, and only the
// open conversation could attach images (the operator's 2026-08-02 report:
// "when you start a chat, you can't attach an image").
//
// Everything a modern chat box does, in one place:
// - an auto-growing textarea (native `field-sizing: content` where the engine
//   has it, a tiny scrollHeight fallback elsewhere) — no more text
//   overflowing a fixed two-row box;
// - image attachments via the 📎 button, paste, or drag-drop, staged as
//   uploads BEFORE submit, with a spinner per chip and a ✕ to remove;
// - submit disabled while any upload is in flight (a failed upload drops its
//   chip with a real error — never silently sends without the image);
// - Enter submits, Shift+Enter newline.
//
// Legacy class hooks are kept deliberately: the e2e suite and the unit tests
// select `.wx-chat-compose-box`, `.wx-chat-compose-input`,
// `.wx-chat-compose-actions button`, `.wx-chat-composer`,
// `.wx-chat-composer-input`, `.wx-chat-send-button`,
// `.wx-chat-composer-error`, `.wx-chat-attach-button`,
// `.wx-chat-attachment-row/-chip/-thumb/-remove` — both modes keep every one
// of those on the same kind of element they always named.

import type { ChatAttachment } from "./api";

export interface StagedAttachment {
  localId: string;
  file: File;
  /** Blob URL backing the chip's (and the local-echo bubble's) preview —
   * revoked by `reset()`/`teardown()`, never before, so a just-sent message's
   * echo keeps its thumbnails until the server copy arrives. */
  previewUrl: string;
  attachmentId: string | null;
  uploading: boolean;
}

export interface ChatComposerOptions {
  mode: "compose" | "composer";
  placeholder: string;
  submitLabel: string;
  /** Stages one file for a later submit (wixy's upload route). Injected so
   * the two call sites pass their own endpoint: conversation-scoped for the
   * open chat, session-less for a not-yet-created conversation. */
  upload: (file: File) => Promise<ChatAttachment>;
  /** Fired by Enter or the submit button, only when submittable (non-empty
   * or attachments staged, no upload in flight). The caller performs the
   * actual send, then calls `reset()` on success or `setError()` +
   * `setBusy(false)` on failure. */
  onSubmit: () => void;
  /** Compose mode submits empty ("start with nothing" creates a preamble-
   * only conversation — spec/06 §1's no-opening-message case); the
   * conversation composer's empty submit is a no-op. Defaults false. */
  allowEmptySubmit?: boolean | undefined;
  onCancel?: (() => void) | undefined;
  cancelLabel?: string | undefined;
  /** Extra click handler for the submit button (e.g. the conversation view's
   * optimistic echo) — fired BEFORE `onSubmit`, on the same gated clicks. */
  win?: Window | undefined;
}

export interface ChatComposer {
  element: HTMLElement;
  text(): string;
  /** Resolved upload ids in attach order (every staged attachment has one —
   * submit is gated on no upload still being in flight). */
  attachmentIds(): string[];
  /** The staged attachments themselves — the conversation view renders these
   * as the local echo's thumbnails (their `previewUrl`s stay valid until
   * `reset()`). */
  stagedAttachments(): readonly StagedAttachment[];
  hasUploadsInFlight(): boolean;
  setAttachmentsSupported(supported: boolean): void;
  setBusy(busy: boolean): void;
  /** Clears text + staged attachments after a successful submit and revokes
   * every preview URL. */
  reset(): void;
  setError(message: string | null): void;
  focus(): void;
  teardown(): void;
}

const MAX_TEXTAREA_HEIGHT_PX = 180;
const MIN_TEXTAREA_HEIGHT_PX = 44;

function cryptoRandomId(win: Window): string {
  const cryptoObj = win.crypto;
  if (typeof cryptoObj?.randomUUID === "function") return cryptoObj.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function mountChatComposer(options: ChatComposerOptions): ChatComposer {
  const win = options.win ?? window;
  const isCompose = options.mode === "compose";

  const root = document.createElement("div");
  // The legacy per-mode root class comes first (existing selectors), the
  // shared `wx-chatc` class carries the new card styling.
  root.className = isCompose ? "wx-chat-compose-box wx-chatc" : "wx-chat-composer wx-chatc";

  const attachmentRow = document.createElement("div");
  attachmentRow.className = "wx-chat-attachment-row";
  attachmentRow.hidden = true;
  root.appendChild(attachmentRow);

  const inputRow = document.createElement("div");
  inputRow.className = "wx-chatc-input-row";

  const attachButton = document.createElement("button");
  attachButton.type = "button";
  attachButton.className = "wx-chat-attach-button";
  attachButton.textContent = "📎";
  attachButton.title = "Attach an image";
  attachButton.setAttribute("aria-label", "Attach an image");
  attachButton.hidden = true; // revealed by setAttachmentsSupported(true)

  const attachInput = document.createElement("input");
  attachInput.type = "file";
  attachInput.accept = "image/*";
  attachInput.multiple = true;
  attachInput.hidden = true;
  attachButton.addEventListener("click", () => attachInput.click());

  const textarea = document.createElement("textarea");
  textarea.className = isCompose ? "wx-chat-compose-input" : "wx-chat-composer-input";
  textarea.placeholder = options.placeholder;
  textarea.rows = 2;

  const submitButton = document.createElement("button");
  submitButton.type = "button";
  submitButton.className = "wx-chat-send-button";
  submitButton.textContent = options.submitLabel;

  inputRow.append(attachButton, attachInput, textarea, submitButton);
  root.appendChild(inputRow);

  // Compose mode (the list view's "New conversation" box) keeps its legacy
  // actions row — Start/Cancel in exactly this order, what the existing
  // tests and e2e select by position.
  let cancelButton: HTMLButtonElement | null = null;
  if (isCompose) {
    // In compose mode the submit button lives in the actions row, not the
    // input row — move it there so the legacy `.wx-chat-compose-actions
    // button` ordering (Start first, Cancel second) holds.
    inputRow.removeChild(submitButton);
    const actions = document.createElement("div");
    actions.className = "wx-chat-compose-actions";
    actions.appendChild(submitButton);
    if (options.onCancel !== undefined) {
      cancelButton = document.createElement("button");
      cancelButton.type = "button";
      cancelButton.textContent = options.cancelLabel ?? "Cancel";
      cancelButton.addEventListener("click", () => options.onCancel?.());
      actions.appendChild(cancelButton);
    }
    root.appendChild(actions);
  }

  const errorEl = document.createElement("span");
  errorEl.className = isCompose ? "wx-chat-compose-error" : "wx-chat-composer-error";
  errorEl.hidden = true;
  root.appendChild(errorEl);

  let staged: StagedAttachment[] = [];
  let busy = false;
  let tornDown = false;

  // -- Auto-grow -------------------------------------------------------------
  // Native path: `field-sizing: content` (Chrome/Edge 123+, Firefox 132+,
  // Safari 18.4+) grows the textarea with its content purely in CSS, clamped
  // by the stylesheet's min/max-height. Fallback: the classic scrollHeight
  // dance — guarded so jsdom (scrollHeight 0) just sits at the floor.
  const nativeAutogrow =
    typeof CSS !== "undefined" && CSS.supports("field-sizing", "content");
  if (!nativeAutogrow) {
    textarea.style.boxSizing = "border-box";
  }
  function autogrow(): void {
    if (nativeAutogrow) return;
    textarea.style.height = "0px";
    const next = Math.min(
      Math.max(textarea.scrollHeight, MIN_TEXTAREA_HEIGHT_PX),
      MAX_TEXTAREA_HEIGHT_PX,
    );
    textarea.style.height = `${next}px`;
    textarea.style.overflowY = textarea.scrollHeight > MAX_TEXTAREA_HEIGHT_PX ? "auto" : "hidden";
  }
  textarea.addEventListener("input", autogrow);
  autogrow();

  function anyUploading(): boolean {
    return staged.some((a) => a.uploading);
  }

  function refreshSubmitState(): void {
    submitButton.disabled = busy || anyUploading();
  }

  function renderChips(): void {
    attachmentRow.innerHTML = "";
    attachmentRow.hidden = staged.length === 0;
    for (const attachment of staged) {
      const chip = document.createElement("div");
      chip.className = "wx-chat-attachment-chip";
      const thumb = document.createElement("img");
      thumb.className = "wx-chat-attachment-thumb";
      thumb.src = attachment.previewUrl;
      thumb.alt = "";
      chip.appendChild(thumb);
      if (attachment.uploading) {
        const spinner = document.createElement("span");
        spinner.className = "wx-spinner wx-chat-attachment-spinner";
        spinner.setAttribute("aria-hidden", "true");
        chip.appendChild(spinner);
      }
      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "wx-chat-attachment-remove";
      removeButton.textContent = "✕";
      removeButton.setAttribute("aria-label", "Remove this image");
      removeButton.addEventListener("click", () => removeAttachment(attachment.localId));
      chip.appendChild(removeButton);
      attachmentRow.appendChild(chip);
    }
    refreshSubmitState();
  }

  function removeAttachment(localId: string): void {
    const found = staged.find((a) => a.localId === localId);
    if (found !== undefined) URL.revokeObjectURL(found.previewUrl);
    staged = staged.filter((a) => a.localId !== localId);
    renderChips();
  }

  function uploadAndAttach(file: File): void {
    if (!file.type.startsWith("image/")) return;
    const localId = cryptoRandomId(win);
    const previewUrl = URL.createObjectURL(file);
    staged = [...staged, { localId, file, previewUrl, attachmentId: null, uploading: true }];
    renderChips();
    options
      .upload(file)
      .then((result) => {
        if (tornDown) return;
        staged = staged.map((a) =>
          a.localId === localId ? { ...a, attachmentId: result.attachmentId, uploading: false } : a,
        );
        renderChips();
      })
      .catch((error: unknown) => {
        if (tornDown) return;
        // A failed upload never sends silently without the image the owner
        // thinks is attached — drop the chip and surface why.
        removeAttachment(localId);
        setError(error instanceof Error ? error.message : "Couldn't attach that image — try again.");
      });
  }

  function handleFileList(files: FileList | null): void {
    if (files === null) return;
    for (const file of Array.from(files)) uploadAndAttach(file);
  }

  attachInput.addEventListener("change", () => {
    handleFileList(attachInput.files);
    attachInput.value = "";
  });
  textarea.addEventListener("paste", (evt) => {
    const items = evt.clipboardData?.items;
    if (items === undefined) return;
    const imageFiles = Array.from(items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (imageFiles.length === 0) return;
    // Only intercept the paste when it's actually image data — a text paste
    // must still land in the textarea normally.
    evt.preventDefault();
    for (const file of imageFiles) uploadAndAttach(file);
  });
  root.addEventListener("dragover", (evt) => {
    evt.preventDefault();
  });
  root.addEventListener("drop", (evt) => {
    evt.preventDefault();
    handleFileList(evt.dataTransfer?.files ?? null);
  });

  function trySubmit(): void {
    if (busy || anyUploading()) return;
    if (!options.allowEmptySubmit && textarea.value.trim() === "" && staged.length === 0) return;
    options.onSubmit();
  }

  submitButton.addEventListener("click", trySubmit);
  textarea.addEventListener("keydown", (evt) => {
    if (evt.key === "Enter" && !evt.shiftKey) {
      evt.preventDefault();
      trySubmit();
    }
  });

  function setError(message: string | null): void {
    errorEl.hidden = message === null;
    errorEl.textContent = message ?? "";
  }

  refreshSubmitState();

  return {
    element: root,
    text() {
      return textarea.value.trim();
    },
    attachmentIds() {
      return staged
        .map((a) => a.attachmentId)
        .filter((id): id is string => id !== null);
    },
    stagedAttachments() {
      return staged;
    },
    hasUploadsInFlight() {
      return anyUploading();
    },
    setAttachmentsSupported(supported) {
      attachButton.hidden = !supported;
    },
    setBusy(nextBusy) {
      busy = nextBusy;
      textarea.disabled = nextBusy;
      refreshSubmitState();
    },
    reset() {
      textarea.value = "";
      autogrow();
      for (const attachment of staged) URL.revokeObjectURL(attachment.previewUrl);
      staged = [];
      renderChips();
      setError(null);
    },
    setError,
    focus() {
      textarea.focus();
    },
    teardown() {
      tornDown = true;
      for (const attachment of staged) URL.revokeObjectURL(attachment.previewUrl);
      staged = [];
    },
  };
}
