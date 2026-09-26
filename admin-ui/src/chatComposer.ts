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
  /** Bytes reported by the in-flight upload's `onProgress`, or `null` before
   * the first tick (or once it's resolved/failed). Nothing in this module
   * renders from it — it's read-only plumbing for a caller-supplied
   * `renderChipPreview` (or any other consumer of `stagedAttachments()`) to
   * build its own progress UI against; workspace #29 sec.10 P5a/P6a. */
  progress: { loaded: number; total: number } | null;
}

/** Passed to an injected `upload()` so it can report progress and be
 * cancelled — workspace #29 sec.10 P5a generalisation for the chunked
 * photo/video/voice uploader P6a builds on top of this composer. */
export interface ChatComposerUploadContext {
  onProgress: (loadedBytes: number, totalBytes: number) => void;
  signal: AbortSignal;
}

export interface ChatComposerOptions {
  mode: "compose" | "composer";
  placeholder: string;
  submitLabel: string;
  /** Stages one file for a later submit (wixy's upload route). Injected so
   * the two call sites pass their own endpoint: conversation-scoped for the
   * open chat, session-less for a not-yet-created conversation. The AI
   * composer's callers pass a single-argument function and ignore `ctx` —
   * that remains valid (JS/TS both allow a callback to declare fewer
   * parameters than the type it's assigned to expects). */
  upload: (file: File, ctx: ChatComposerUploadContext) => Promise<ChatAttachment>;
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
  /** The file-picker's `accept` filter. Defaults to `"image/*"` — the AI
   * composer's existing behaviour. */
  accept?: string | undefined;
  /** Gates every file the picker, paste, and drag-drop can stage (replacing
   * this module's own hardcoded image check). Defaults to
   * `file.type.startsWith("image/")` — the AI composer's existing
   * behaviour, unchanged unless overridden. */
  acceptFile?: ((file: File) => boolean) | undefined;
  /** Renders a staged file's chip preview. Defaults to the existing
   * `<img class="wx-chat-attachment-thumb">` sourced from the file's blob
   * URL — a caller overrides this for a non-image kind (e.g. a voice note
   * or video chip) without touching this module. */
  renderChipPreview?: ((file: File, previewUrl: string) => HTMLElement) | undefined;
  /** Extra buttons mounted in a slot right after the 📎 attach button (e.g.
   * the server chat's 🎤 recorder, P6b). Defaults to none — the AI composer
   * omits this and its input row is unaffected. */
  extraButtons?: HTMLElement[] | undefined;
  /** Called immediately before opening the native file picker. The returned
   * release is called on either `change` or `cancel`; server chat uses this
   * to pause its idle lock while the picker is open. */
  onFilePickerOpen?: (() => () => void) | undefined;
  /** Called at the end of every chip re-render, with the currently staged files (possibly
   * empty). A caller that needs to react to the staged set changing as a whole — not per chip,
   * the way `renderChipPreview` does — uses this instead of reaching into the composer's
   * internal DOM; it fires even when the last chip is removed, which a `renderChipPreview`-based
   * hook cannot see (that callback simply stops being called at zero chips). */
  onChipsRendered?: ((stagedFiles: readonly File[]) => void) | undefined;
  /** Sending never touches the input. `setBusy` then only arms the submit guard (it does not
   * disable the textarea or the Send button), and pressing Send does not take focus from the
   * input, so the caret - and on a phone the soft keyboard - never leaves. The caller pairs it
   * with `takeDraft()` (clear the box at once) and `restoreDraft()` (put the draft back if the
   * send fails). The AI chat omits this and keeps its disabled-while-busy input. */
  keepInputLive?: boolean | undefined;
}

/** What `takeDraft()` lifted out of the composer: the caller owns it until it calls either
 * `restoreDraft()` (the send failed) or `discardDraft()` (the send is done). */
export interface ComposerDraft {
  readonly text: string;
  readonly attachmentIds: readonly string[];
  readonly staged: readonly StagedAttachment[];
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
  /** Programmatically stage a file from an auxiliary composer control, such
   * as a MediaRecorder result. Picker/paste/drop still use `acceptFile`. */
  addFile(file: File): void;
  hasUploadsInFlight(): boolean;
  setAttachmentsSupported(supported: boolean): void;
  setBusy(busy: boolean): void;
  /** Clears text + staged attachments after a successful submit and revokes
   * every preview URL. */
  reset(): void;
  /** Lifts the text and staged attachments out and clears the composer at once (no busy
   * state, no focus change), for the `keepInputLive` send flow. Preview URLs stay valid: the
   * draft owns them until `restoreDraft()` or `discardDraft()`. */
  takeDraft(): ComposerDraft;
  /** Puts a draft back after a failed send. Text the user has typed since is kept, after the
   * restored text; staged attachments go back in front of any newly staged ones. */
  restoreDraft(draft: ComposerDraft): void;
  /** Releases a draft whose message went through: revokes its preview URLs. */
  discardDraft(draft: ComposerDraft): void;
  setError(message: string | null): void;
  focus(): void;
  teardown(): void;
}

const MAX_TEXTAREA_HEIGHT_PX = 180;
const MIN_TEXTAREA_HEIGHT_PX = 36;
const EMPTY_TEXTAREA_ROWS = 1;
const BUSY_TEXTAREA_ROWS = 2;

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

  const acceptFile = options.acceptFile ?? ((file: File) => file.type.startsWith("image/"));

  const attachInput = document.createElement("input");
  attachInput.type = "file";
  attachInput.accept = options.accept ?? "image/*";
  attachInput.multiple = true;
  attachInput.hidden = true;
  let releaseFilePicker: (() => void) | null = null;
  function finishFilePicker(): void {
    releaseFilePicker?.();
    releaseFilePicker = null;
  }
  attachButton.addEventListener("click", () => {
    finishFilePicker();
    try {
      releaseFilePicker = options.onFilePickerOpen?.() ?? null;
      attachInput.click();
    } catch (error) {
      finishFilePicker();
      throw error;
    }
  });

  const textarea = document.createElement("textarea");
  textarea.className = isCompose ? "wx-chat-compose-input" : "wx-chat-composer-input";
  textarea.placeholder = options.placeholder;
  // decisions/00113: ONE line when empty — the 00110 floor (44px/2 rows) read
  // "very tall for no reason before anything's been typed in" (operator
  // feedback). Grows to 2 rows the moment there's content, and to the 180px
  // cap beyond that.
  textarea.rows = EMPTY_TEXTAREA_ROWS;

  const submitButton = document.createElement("button");
  submitButton.type = "button";
  submitButton.className = "wx-chat-send-button";
  submitButton.textContent = options.submitLabel;

  inputRow.append(attachButton, attachInput, ...(options.extraButtons ?? []), textarea, submitButton);
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
  /** One AbortController per in-flight upload, keyed by `localId` — aborted
   * when its chip is removed before the upload resolves, and on teardown.
   * Kept out of `StagedAttachment` (a plain data snapshot handed to
   * callers) so it stays purely an implementation detail of this module. */
  const uploadControllers = new Map<string, AbortController>();

  // -- Auto-grow -------------------------------------------------------------
  // The scrollHeight dance, UNCONDITIONALLY — no `field-sizing: content`.
  // Measured live (not theorised): this engine generation gives ANY
  // field-sizing textarea an intrinsic TWO-row floor (≈52px) that nothing
  // escapes — not rows=1, not an explicit inline height, not max-height, not
  // the property's own `border-box` value from JS (read-only — silently
  // ignored), not even a class `border-box !important`. A single-line empty
  // composer (the whole point of the 00113 "not tall for no reason" fix) is
  // impossible with field-sizing active, so we size by hand — one proven
  // path, exactly what older engines get too, no dual-path drift.
  textarea.style.boxSizing = "border-box";
  function autogrow(): void {
    const empty = textarea.value === "";
    textarea.classList.toggle("wx-chat-input-empty", empty);
    textarea.rows = empty ? EMPTY_TEXTAREA_ROWS : BUSY_TEXTAREA_ROWS;
    if (empty) {
      // Pinned by the `.wx-chat-input-empty` rule (36px) — nothing to
      // measure (scrollHeight 0 would collapse it to nothing).
      textarea.style.height = "";
      textarea.style.overflowY = "";
      return;
    }
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

  const keepInputLive = options.keepInputLive === true;

  function refreshSubmitState(): void {
    // keepInputLive: an in-flight send is guarded in `trySubmit`, never by disabling the button
    // (a disabled control flashes, and drops focus if it happened to be focused).
    submitButton.disabled = (keepInputLive ? false : busy) || anyUploading();
  }

  function defaultChipPreview(previewUrl: string): HTMLElement {
    const thumb = document.createElement("img");
    thumb.className = "wx-chat-attachment-thumb";
    thumb.src = previewUrl;
    thumb.alt = "";
    return thumb;
  }

  function renderChips(): void {
    attachmentRow.innerHTML = "";
    attachmentRow.hidden = staged.length === 0;
    for (const attachment of staged) {
      const chip = document.createElement("div");
      chip.className = "wx-chat-attachment-chip";
      chip.appendChild(
        options.renderChipPreview?.(attachment.file, attachment.previewUrl) ?? defaultChipPreview(attachment.previewUrl),
      );
      if (attachment.uploading) {
        const spinner = document.createElement("span");
        spinner.className = "wx-spinner wx-chat-attachment-spinner";
        spinner.setAttribute("aria-hidden", "true");
        chip.appendChild(spinner);
        if (attachment.progress !== null) {
          const progress = document.createElement("progress");
          progress.className = "wx-chat-attachment-progress";
          progress.max = Math.max(attachment.progress.total, 1);
          progress.value = attachment.progress.loaded;
          progress.setAttribute("aria-label", `Uploading ${attachment.file.name}`);
          chip.appendChild(progress);
        }
      }
      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "wx-chat-attachment-remove";
      removeButton.textContent = "✕";
      removeButton.setAttribute("aria-label", "Remove this attachment");
      removeButton.addEventListener("click", () => removeAttachment(attachment.localId));
      chip.appendChild(removeButton);
      attachmentRow.appendChild(chip);
    }
    refreshSubmitState();
    options.onChipsRendered?.(staged.map((attachment) => attachment.file));
  }

  function removeAttachment(localId: string): void {
    uploadControllers.get(localId)?.abort();
    uploadControllers.delete(localId);
    const found = staged.find((a) => a.localId === localId);
    if (found !== undefined) URL.revokeObjectURL(found.previewUrl);
    staged = staged.filter((a) => a.localId !== localId);
    renderChips();
  }

  function uploadAndAttach(file: File, checkAcceptedType = true): void {
    if (checkAcceptedType && !acceptFile(file)) return;
    const localId = cryptoRandomId(win);
    const previewUrl = URL.createObjectURL(file);
    staged = [...staged, { localId, file, previewUrl, attachmentId: null, uploading: true, progress: null }];
    renderChips();
    const controller = new AbortController();
    uploadControllers.set(localId, controller);
    options
      .upload(file, {
        onProgress: (loaded, total) => {
          if (tornDown) return;
          staged = staged.map((a) => (a.localId === localId ? { ...a, progress: { loaded, total } } : a));
          renderChips();
        },
        signal: controller.signal,
      })
      .then((result) => {
        uploadControllers.delete(localId);
        if (tornDown) return;
        staged = staged.map((a) =>
          a.localId === localId ? { ...a, attachmentId: result.attachmentId, uploading: false } : a,
        );
        renderChips();
      })
      .catch((error: unknown) => {
        uploadControllers.delete(localId);
        if (tornDown) return;
        if (controller.signal.aborted) return;
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
    finishFilePicker();
    handleFileList(attachInput.files);
    attachInput.value = "";
  });
  attachInput.addEventListener("cancel", finishFilePicker);
  textarea.addEventListener("paste", (evt) => {
    const items = evt.clipboardData?.items;
    if (items === undefined) return;
    const matchingFiles = Array.from(items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null && acceptFile(file));
    if (matchingFiles.length === 0) return;
    // Only intercept the paste when it's actually matching file data — a
    // text paste must still land in the textarea normally.
    evt.preventDefault();
    for (const file of matchingFiles) uploadAndAttach(file);
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
  if (keepInputLive) {
    // Pressing a button moves focus to it by default, which blurs the input (and closes a
    // phone's soft keyboard). Cancelling the mousedown keeps focus where it is; the click
    // still fires. Touch taps reach here too, as the browser's compatibility mousedown.
    submitButton.addEventListener("mousedown", (evt) => evt.preventDefault());
  }
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
    addFile(file) {
      uploadAndAttach(file, false);
    },
    hasUploadsInFlight() {
      return anyUploading();
    },
    setAttachmentsSupported(supported) {
      attachButton.hidden = !supported;
    },
    setBusy(nextBusy) {
      busy = nextBusy;
      if (!keepInputLive) textarea.disabled = nextBusy;
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
    takeDraft() {
      const draft: ComposerDraft = {
        text: textarea.value.trim(),
        attachmentIds: staged.map((a) => a.attachmentId).filter((id): id is string => id !== null),
        staged,
      };
      textarea.value = "";
      autogrow();
      staged = [];
      renderChips();
      setError(null);
      return draft;
    },
    restoreDraft(draft) {
      const typedSince = textarea.value;
      if (draft.text !== "") {
        textarea.value = typedSince === "" ? draft.text : `${draft.text}
${typedSince}`;
      }
      autogrow();
      staged = [...draft.staged, ...staged];
      renderChips();
      refreshSubmitState();
    },
    discardDraft(draft) {
      for (const attachment of draft.staged) URL.revokeObjectURL(attachment.previewUrl);
    },
    setError,
    focus() {
      textarea.focus();
    },
    teardown() {
      tornDown = true;
      finishFilePicker();
      for (const controller of uploadControllers.values()) controller.abort();
      uploadControllers.clear();
      for (const attachment of staged) URL.revokeObjectURL(attachment.previewUrl);
      staged = [];
    },
  };
}
