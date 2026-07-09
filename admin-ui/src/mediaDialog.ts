// The media grid + picker (spec/05-editor.md §4): "grid of repo images/* + staged
// draft uploads… with dimensions, file size, and references… Upload button +
// drag-drop (multi-file). Unreferenced-media delete. The SAME component renders as
// a modal dialog when invoked from the editor (mediaRequest) — pick or upload,
// returns the image object {src, alt} with alt prompted…"
//
// `renderMediaGrid` is that "same component" — used directly (embedded, no chrome,
// no `onPick`) by `mediaPanel.ts` for the full `#/media` route, and wrapped in a
// modal by `openMediaDialog` for every "replace image" invocation (the editor's
// `mediaRequest` via `editView.ts`, and `pageSettingsDrawer.ts`'s ogImage field —
// decisions/00018 decision 9 flagged that field's old inline-list-only picker as a
// stand-in meant to be replaced here, not a permanent piece of code).
//
// Picking is always a SEPARATE, explicit click on a grid thumbnail — including for
// a file just uploaded a moment ago — rather than upload auto-selecting its result;
// this keeps "upload" and "pick" as one predictable path regardless of how many
// files were dropped at once (decisions/00022).

import type { AdminApi, MediaItem } from "./api";

export interface MediaPickValue {
  src: string;
  alt: string;
}

const HASH8_PREFIX = /^[0-9a-f]{8}-/;
const EXTENSION = /\.[a-zA-Z0-9]+$/;

/** A human-readable alt-text starting guess from a filename — strips the
 * extension and (if present) the upload pipeline's `<hash8>-` prefix
 * (`wixy_server/media.py`'s `_slugify`/`process_upload`; a repo-sourced filename
 * has no such prefix, so the regex simply doesn't match and is a no-op then). */
export function guessAltFromFilename(name: string): string {
  const withoutExtension = name.replace(EXTENSION, "");
  const withoutHashPrefix = withoutExtension.replace(HASH8_PREFIX, "");
  const spaced = withoutHashPrefix.replace(/[-_]+/g, " ").trim();
  return spaced.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

export interface MediaGridDeps {
  api: AdminApi;
  win?: Window;
  /** Present only in PICK mode (the modal dialog) — omitted for the plain
   * `#/media` panel, where a thumbnail click does nothing (picking is dialog-only
   * behavior; the panel is management-only: upload, inspect, delete). */
  onPick?: (value: MediaPickValue) => void;
}

export interface MediaGrid {
  element: HTMLElement;
  teardown(): void;
}

export function renderMediaGrid(deps: MediaGridDeps): MediaGrid {
  const win = deps.win ?? window;

  const root = document.createElement("div");
  root.className = "wx-media-grid-root";

  const toolbar = document.createElement("div");
  toolbar.className = "wx-media-toolbar";
  const uploadButton = document.createElement("button");
  uploadButton.type = "button";
  uploadButton.className = "wx-media-upload-button";
  uploadButton.textContent = "Upload";
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/*";
  fileInput.multiple = true;
  fileInput.hidden = true;
  uploadButton.addEventListener("click", () => fileInput.click());
  toolbar.append(uploadButton, fileInput);

  const grid = document.createElement("div");
  grid.className = "wx-media-grid";
  grid.textContent = "Loading…";

  const altStep = document.createElement("div");
  altStep.className = "wx-media-alt-step";
  altStep.hidden = true;

  root.append(toolbar, grid, altStep);

  let items: MediaItem[] = [];
  let cancelled = false;

  function renderAltStep(item: MediaItem): void {
    if (deps.onPick === undefined) return;
    const onPick = deps.onPick;
    grid.hidden = true;
    altStep.hidden = false;
    altStep.innerHTML = "";

    const preview = document.createElement("img");
    preview.className = "wx-media-alt-preview";
    preview.src = item.url;
    preview.alt = "";

    const altLabel = document.createElement("label");
    altLabel.className = "wx-field-row";
    altLabel.textContent = "Alt text";
    const altInput = document.createElement("input");
    altInput.type = "text";
    altInput.value = guessAltFromFilename(item.name);
    altLabel.appendChild(altInput);

    const decorativeLabel = document.createElement("label");
    decorativeLabel.className = "wx-field-row-checkbox";
    const decorativeBox = document.createElement("input");
    decorativeBox.type = "checkbox";
    decorativeLabel.append(decorativeBox, document.createTextNode("Decorative (no alt text)"));

    const actions = document.createElement("div");
    actions.className = "wx-media-alt-actions";
    const confirmButton = document.createElement("button");
    confirmButton.type = "button";
    confirmButton.textContent = "Use this image";
    const backButton = document.createElement("button");
    backButton.type = "button";
    backButton.textContent = "Back";
    actions.append(backButton, confirmButton);

    // Accessibility default-ON (spec/05 §4): alt text is required unless the user
    // explicitly opts out via "Decorative" — the checkbox starts unchecked, and
    // Confirm stays disabled on an empty alt until it's checked.
    function refreshConfirmEnabled(): void {
      altInput.disabled = decorativeBox.checked;
      confirmButton.disabled = altInput.value.trim() === "" && !decorativeBox.checked;
    }
    altInput.addEventListener("input", refreshConfirmEnabled);
    decorativeBox.addEventListener("change", refreshConfirmEnabled);
    refreshConfirmEnabled();

    confirmButton.addEventListener("click", () => {
      onPick({ src: item.url, alt: decorativeBox.checked ? "" : altInput.value.trim() });
    });
    backButton.addEventListener("click", () => {
      altStep.hidden = true;
      grid.hidden = false;
    });

    altStep.append(preview, altLabel, decorativeLabel, actions);
  }

  function renderGrid(): void {
    grid.innerHTML = "";
    if (items.length === 0) {
      const empty = document.createElement("p");
      empty.className = "wx-media-empty";
      empty.textContent = "No media yet — upload an image to get started.";
      grid.appendChild(empty);
      return;
    }
    for (const item of items) {
      grid.appendChild(renderItem(item));
    }
  }

  function renderItem(item: MediaItem): HTMLElement {
    const cell = document.createElement("div");
    cell.className = "wx-media-item";

    const pickable = deps.onPick !== undefined;
    const thumbWrap: HTMLElement = document.createElement(pickable ? "button" : "div");
    thumbWrap.className = "wx-media-thumb";
    if (thumbWrap instanceof HTMLButtonElement) {
      thumbWrap.type = "button";
      thumbWrap.addEventListener("click", () => renderAltStep(item));
    }
    const thumb = document.createElement("img");
    thumb.src = item.url;
    thumb.alt = item.name;
    thumbWrap.appendChild(thumb);
    if (item.source === "draft") {
      const badge = document.createElement("span");
      badge.className = "wx-media-badge";
      badge.textContent = "draft";
      thumbWrap.appendChild(badge);
    }
    cell.appendChild(thumbWrap);

    const meta = document.createElement("div");
    meta.className = "wx-media-meta";
    const dims = document.createElement("span");
    dims.textContent = item.width !== null && item.height !== null ? `${item.width}×${item.height}` : "—";
    const size = document.createElement("span");
    size.textContent = formatSize(item.sizeBytes);
    const refs = document.createElement("span");
    refs.textContent =
      item.references.length > 0 ? `${item.references.length} use${item.references.length === 1 ? "" : "s"}` : "Unused";
    meta.append(dims, size, refs);
    cell.appendChild(meta);

    const canDelete = item.source === "draft" && item.references.length === 0;
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "wx-media-delete";
    deleteButton.textContent = "Delete";
    deleteButton.disabled = !canDelete;
    deleteButton.title = canDelete
      ? ""
      : item.source === "repo"
        ? "Published images can't be deleted from the draft yet (milestone 9)"
        : "Still referenced — remove its uses first";
    deleteButton.addEventListener("click", () => void handleDelete(item));
    cell.appendChild(deleteButton);

    return cell;
  }

  async function refresh(): Promise<void> {
    try {
      items = await deps.api.getMedia();
      if (cancelled) return;
      renderGrid();
    } catch {
      if (cancelled) return;
      grid.textContent = "Couldn't load media.";
    }
  }

  async function handleDelete(item: MediaItem): Promise<void> {
    if (!win.confirm(`Delete "${item.name}"? This can't be undone.`)) return;
    try {
      await deps.api.deleteMedia(item.name);
      await refresh();
    } catch (error) {
      win.alert(error instanceof Error ? error.message : `Couldn't delete "${item.name}".`);
    }
  }

  async function uploadFiles(files: FileList): Promise<void> {
    for (const file of Array.from(files)) {
      try {
        await deps.api.uploadMedia(file);
      } catch (error) {
        win.alert(error instanceof Error ? error.message : `Couldn't upload "${file.name}".`);
      }
    }
    await refresh();
  }

  fileInput.addEventListener("change", () => {
    if (fileInput.files !== null && fileInput.files.length > 0) void uploadFiles(fileInput.files);
    fileInput.value = "";
  });

  root.addEventListener("dragover", (event) => {
    event.preventDefault();
  });
  root.addEventListener("drop", (event) => {
    event.preventDefault();
    if (event.dataTransfer !== null && event.dataTransfer.files.length > 0) {
      void uploadFiles(event.dataTransfer.files);
    }
  });

  void refresh();

  return {
    element: root,
    teardown(): void {
      cancelled = true;
    },
  };
}

export interface MediaDialog {
  element: HTMLElement;
  teardown(): void;
}

export interface MediaDialogCallbacks {
  onPick: (value: MediaPickValue) => void;
  onCancel: () => void;
}

export function mountMediaDialog(
  deps: { api: AdminApi; win?: Window },
  callbacks: MediaDialogCallbacks,
): MediaDialog {
  const win = deps.win ?? window;

  const backdrop = document.createElement("div");
  backdrop.className = "wx-media-dialog-backdrop";
  const box = document.createElement("div");
  box.className = "wx-media-dialog";

  const header = document.createElement("div");
  header.className = "wx-drawer-header";
  const heading = document.createElement("h3");
  heading.textContent = "Media";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "wx-drawer-close";
  closeButton.textContent = "×";
  closeButton.setAttribute("aria-label", "Close");
  closeButton.addEventListener("click", () => callbacks.onCancel());
  header.append(heading, closeButton);

  const grid = renderMediaGrid({ api: deps.api, win, onPick: callbacks.onPick });

  box.append(header, grid.element);
  backdrop.appendChild(box);

  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) callbacks.onCancel();
  });
  const keydownListener = (event: KeyboardEvent): void => {
    if (event.key === "Escape") callbacks.onCancel();
  };
  win.addEventListener("keydown", keydownListener);

  return {
    element: backdrop,
    teardown(): void {
      grid.teardown();
      win.removeEventListener("keydown", keydownListener);
    },
  };
}

/** The single entry point callers use to resolve a "replace image" request: mounts
 * the modal onto `document.body`, tears itself down, and calls `respond` EXACTLY
 * once — with the picked `{src, alt}`, or `null` if the dialog was closed without
 * picking anything (backdrop click, Escape, or the close button). */
export function openMediaDialog(
  deps: { api: AdminApi; win?: Window },
  respond: (value: MediaPickValue | null) => void,
): void {
  let dialog: MediaDialog | null = null;
  function finish(value: MediaPickValue | null): void {
    dialog?.teardown();
    dialog?.element.remove();
    dialog = null;
    respond(value);
  }
  dialog = mountMediaDialog(deps, {
    onPick: (value) => finish(value),
    onCancel: () => finish(null),
  });
  document.body.appendChild(dialog.element);
}
