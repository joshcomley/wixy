// Registry-configured section editor (spec 3c, decisions/00098) — the
// dedicated Before & After management screen and any future registry-declared
// section (Inv 1: no site literals here, everything comes from the
// `AdminSection`/`AdminCollection`/`AdminField` config passed in). Owns its
// own fetch (`api.getContent`), unlike `pagesPanel.ts`'s `renderXPanel(data,
// callbacks)` shape — a section's collection VALUES live in page content, not
// in `StateResponse`, so this mirrors `mediaPanel.ts`'s `mountXPanel(api,
// win)` "owns its own lifecycle" precedent instead.
//
// Staged-save model (decisions/00118): unlike the rest of the admin (which
// auto-saves every edit through the shared `OpQueue`), this panel holds edits
// LOCALLY (`collectionState`) until she presses Save. `savedState` is the
// last-known-saved-or-loaded snapshot; the difference between the two is
// "dirty". This is a deliberate divergence, scoped to this panel only — it's
// her primary surface, and the one she asked to be made legible: edit ->
// (visibly unsaved) -> Save -> "ready to publish" -> Publish, with Undo/
// Discard available at both the local and the draft stage.

import type { AdminApi, AdminCollection, AdminField, AdminSection } from "./api";
import { openAlignerDialog, type AlignerResult } from "./alignerDialog";
import { renderBeforeAfter } from "./beforeAfterSlider";
import { contentSrcToDisplayUrl, openMediaDialog, type MediaPickValue } from "./mediaDialog";
import type { EnqueueOutcome } from "./opQueue";
import type { DraftOp } from "./protocol";
import { setButtonBusy, setButtonIdle } from "./spinnerButton";
import {
  appendItem,
  blankItem,
  cloneItems,
  decodeCommonEntities,
  deleteItemAt,
  fieldDirty,
  hideAllItems,
  imageFieldValue,
  isNewItemComplete,
  itemDirty,
  itemsAt,
  itemsEqual,
  moveItemDown,
  moveItemUp,
  moveItemTo,
  removeItemField,
  showAllItems,
  textFieldValue,
  updateItemField,
  type SectionItem,
} from "./sectionPanelModel";

export interface SectionPanel {
  element: HTMLElement;
  /** Re-read this section's content from the server and re-render, replacing
   * the in-memory working copy (decisions/00115). The shell calls this after
   * anything that rewrites the draft BEHIND the panel — a publish (which
   * re-points every staged upload at its published `images/<name>` and deletes
   * the staged file) or a draft repair. Deferred while she's mid-edit or has
   * unsaved local changes (decisions/00118) — a re-read would otherwise
   * throw away typing, or unsaved staged edits she hasn't pressed Save on. */
  refresh(): void;
  /** Whether any collection has local edits not yet written to the draft
   * (decisions/00118's staged-save model) — the shell checks this before a
   * route change / tab close so nothing is silently lost. */
  hasUnsavedChanges(): boolean;
  teardown(): void;
}

/** The narrow slice of `OpQueue` this panel needs — `enqueueTracked` (decisions/
 * 00119), not `editView.ts`'s plain `enqueue`, so `saveNow()` gets a REAL
 * per-batch accepted signal instead of inferring success from `rev` advancing
 * (decisions/00118's known gap: a 409-refetch immediately followed by a
 * network error also advances `rev`, via `fetchCurrentRev`, without the batch
 * landing). The real `OpQueue` class satisfies this without any change. */
export interface SectionOpQueueLike {
  readonly rev: number;
  enqueueTracked(op: DraftOp): Promise<EnqueueOutcome>;
  flushNow(): Promise<void>;
}

export interface SectionPanelDeps {
  api: AdminApi;
  opQueue: SectionOpQueueLike;
  win?: Window;
  /** Test seam for the aligner (decisions/00111): the dialog paints on a
   * real canvas, which jsdom doesn't have — panel tests stub this and drive
   * its `respond` callback directly. Production always uses the real one. */
  openAligner?: typeof openAlignerDialog;
  /** Ask the shell to open the publish review drawer (decisions/00118) — the
   * panel never re-implements publish itself (Inv 25: publish progress/
   * completion feedback is shell-owned). Wired in shell.ts's section-route
   * mount to `openPublishDrawer()`. */
  onRequestPublish?: () => void;
  /** Tell the shell to re-read `/api/admin/state` after this panel changes
   * the draft OUTSIDE the normal `opQueue` path — today, only "Discard all
   * changes" (`api.discardDraft()` is a plain DELETE, not an op the shared
   * queue's `onAccepted` hook would otherwise notice), so the global status
   * bar's chip reflects the now-empty draft immediately rather than waiting
   * for the next 60s revalidation. */
  onDraftChanged?: () => void;
}

const MAX_UNDO_SNAPSHOTS = 50;
const SAVE_STATUS_CLEAR_MS = 2500;

export function mountSectionPanel(section: AdminSection, deps: SectionPanelDeps): SectionPanel {
  const win = deps.win ?? window;
  const { api, opQueue } = deps;
  const openAligner = deps.openAligner ?? openAlignerDialog;
  let destroyed = false;

  const element = document.createElement("div");
  element.className = "wx-section-panel";

  const header = document.createElement("div");
  header.className = "wx-section-header";
  const titleEl = document.createElement("h2");
  titleEl.className = "wx-section-title";
  titleEl.textContent = section.title;
  const descEl = document.createElement("p");
  descEl.className = "wx-section-description";
  descEl.textContent = section.description;
  header.append(titleEl, descEl);

  // -- "Ready to publish" banner (decisions/00118) ---------------------------
  // Reflects the DRAFT (server) state — what's already saved and queued,
  // reconciling with the shell's own status-bar chip (both read the same
  // `state.draft.opCount`). Distinct from the save bar below, which reflects
  // LOCAL unsaved edits: "unsaved" and "ready to publish" are deliberately
  // two different, clearly separated ideas (the exact confusion she reported).

  const readyBanner = document.createElement("div");
  readyBanner.className = "wx-section-ready-banner";
  readyBanner.hidden = true;
  const readyBannerText = document.createElement("span");
  readyBannerText.className = "wx-section-ready-banner-text";
  const publishFromBannerButton = document.createElement("button");
  publishFromBannerButton.type = "button";
  publishFromBannerButton.className = "wx-publish-button";
  publishFromBannerButton.textContent = "Publish";
  publishFromBannerButton.addEventListener("click", () => void onPublishClick());
  const discardAllButton = document.createElement("button");
  discardAllButton.type = "button";
  discardAllButton.className = "wx-section-discard-all-button";
  discardAllButton.textContent = "Discard all changes";
  discardAllButton.addEventListener("click", () => void discardAll());
  readyBanner.append(readyBannerText, publishFromBannerButton, discardAllButton);

  const body = document.createElement("div");
  body.className = "wx-section-body";

  // -- Sticky Save bar (decisions/00118) --------------------------------------
  // Reflects LOCAL unsaved edits — hidden while the panel is clean. Sticky to
  // the bottom of the panel so it's reachable without hunting for it on a
  // phone; `.wx-main` gets matching bottom padding (style.css) so it never
  // overlaps the last card.

  const saveBar = document.createElement("div");
  saveBar.className = "wx-section-save-bar";
  saveBar.hidden = true;
  const saveBarText = document.createElement("span");
  saveBarText.className = "wx-section-save-bar-text";
  saveBarText.textContent = "You have unsaved changes";
  const saveBarStatus = document.createElement("span");
  saveBarStatus.className = "wx-section-save-bar-status";
  const undoButton = document.createElement("button");
  undoButton.type = "button";
  undoButton.className = "wx-section-undo-button";
  undoButton.textContent = "Undo last";
  undoButton.addEventListener("click", () => undoLast());
  const discardUnsavedButton = document.createElement("button");
  discardUnsavedButton.type = "button";
  discardUnsavedButton.className = "wx-section-discard-unsaved-button";
  discardUnsavedButton.textContent = "Discard unsaved";
  discardUnsavedButton.addEventListener("click", () => discardUnsaved());
  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.className = "wx-publish-button wx-section-save-button";
  saveButton.textContent = "Save";
  saveButton.addEventListener("click", () => void saveNow());
  // A dedicated group for the buttons (rather than making them direct flex
  // children of the bar) so they stay put as a right-aligned cluster when
  // Undo conditionally hides — an auto-margin on an individual button would
  // otherwise need to migrate to whichever button is currently first-visible.
  const saveBarActions = document.createElement("div");
  saveBarActions.className = "wx-section-save-bar-actions";
  saveBarActions.append(undoButton, discardUnsavedButton, saveButton);
  saveBar.append(saveBarText, saveBarStatus, saveBarActions);

  element.append(header, readyBanner, body, saveBar);

  // The panel's own working copy of each collection's array while mounted
  // (spec 3c: "the panel state — the panel is the array's source of truth
  // while mounted"). `savedState` is the last snapshot the SERVER accepted
  // (or, before any edit, what `load()` just read) — the two together define
  // "dirty" (decisions/00118). Neither map needs deep-cloning on every read:
  // every pure helper in sectionPanelModel.ts returns a NEW array/object
  // rather than mutating in place, so a reference captured into `savedState`
  // is never retroactively changed by a later edit.
  const collectionState = new Map<string, SectionItem[]>();
  const savedState = new Map<string, SectionItem[]>();
  const collectionBodies = new Map<string, HTMLElement>();

  /** A single panel-wide stack of pre-mutation snapshots (bounded), not one
   * per collection — "Undo last" means "undo what I just did", regardless of
   * which collection it touched, matching how she described the ask. */
  const undoStack: Array<{ path: string; items: SectionItem[] }> = [];

  let saving = false;
  let draftOpCount = 0;

  function itemsFor(collection: AdminCollection): SectionItem[] {
    return collectionState.get(collection.path) ?? [];
  }

  function isCollectionDirty(collection: AdminCollection): boolean {
    return !itemsEqual(itemsFor(collection), savedState.get(collection.path) ?? []);
  }

  function isDirty(): boolean {
    return section.collections.some((collection) => isCollectionDirty(collection));
  }

  function pushUndoSnapshot(path: string, items: SectionItem[]): void {
    undoStack.push({ path, items });
    if (undoStack.length > MAX_UNDO_SNAPSHOTS) undoStack.shift();
  }

  /** Stages an edit into the local working copy — everything `commit` used to
   * do EXCEPT writing to the server (decisions/00118). The whole array is
   * still the unit of change (Inv 6); only the MOMENT it reaches the draft
   * has moved, from "every edit" to "when she presses Save". */
  function stageLocal(collection: AdminCollection, items: SectionItem[]): void {
    pushUndoSnapshot(collection.path, itemsFor(collection));
    collectionState.set(collection.path, items);
    renderCollectionBody(collection);
    refreshSaveBar();
  }

  function undoLast(): void {
    const last = undoStack.pop();
    if (last === undefined) return;
    collectionState.set(last.path, last.items);
    const collection = section.collections.find((c) => c.path === last.path);
    if (collection !== undefined) renderCollectionBody(collection);
    refreshSaveBar();
    maybeRunPendingRefresh();
  }

  function discardUnsaved(): void {
    const ok = win.confirm("Discard your unsaved changes? This can't be undone.");
    if (!ok) return;
    for (const collection of section.collections) {
      collectionState.set(collection.path, cloneItems(savedState.get(collection.path) ?? []));
      renderCollectionBody(collection);
    }
    undoStack.length = 0;
    refreshSaveBar();
    maybeRunPendingRefresh();
  }

  function refreshSaveBar(): void {
    const dirty = isDirty();
    saveBar.hidden = !dirty;
    undoButton.hidden = undoStack.length === 0;
    if (!saving) saveButton.disabled = !dirty;
  }

  /** Only re-runs a deferred `refresh()` once it's actually safe — i.e. once
   * she's no longer mid-edit AND no longer dirty (decisions/00115, 00118). */
  function maybeRunPendingRefresh(): void {
    if (!refreshPending || destroyed || isEditingInPanel() || isDirty()) return;
    refreshPending = false;
    void refreshFromServer();
  }

  /** Writes every dirty collection to the draft in one PATCH batch, via the
   * SAME `opQueue.enqueueTracked` chokepoint every other edit in this
   * codebase uses (Inv 6 unchanged) — Save just chooses WHEN that write
   * happens, instead of it happening on every field commit. `enqueueTracked`
   * (decisions/00119) resolves with the REAL per-batch outcome — accepted
   * (with the new `rev`) or not — bounded to this one flush attempt, so
   * Save's success/failure reporting can never be fooled by `rev` advancing
   * for an unrelated reason (decisions/00118's original gap: a 409-refetch
   * immediately followed by a network error also advances `rev`, without the
   * batch landing). The shell's own toasts already surface WHY a save
   * failed; this panel doesn't need to duplicate that detail. */
  async function saveNow(): Promise<void> {
    if (destroyed || saving || !isDirty()) return;
    saving = true;
    setButtonBusy(saveButton, "Saving…");
    undoButton.disabled = true;
    discardUnsavedButton.disabled = true;
    saveBarStatus.textContent = "";
    saveBarStatus.classList.remove("wx-section-save-bar-status-error", "wx-section-save-bar-status-ok");

    const outcomes: Promise<EnqueueOutcome>[] = [];
    for (const collection of section.collections) {
      if (isCollectionDirty(collection)) {
        outcomes.push(
          opQueue.enqueueTracked({ file: section.page, path: collection.path, value: itemsFor(collection) }),
        );
      }
    }
    await opQueue.flushNow();
    const settled = await Promise.all(outcomes);

    saving = false;
    if (destroyed) return;
    setButtonIdle(saveButton, "Save");
    undoButton.disabled = false;
    discardUnsavedButton.disabled = false;

    const succeeded = settled.every((outcome) => outcome.accepted);
    if (succeeded) {
      for (const collection of section.collections) {
        savedState.set(collection.path, cloneItems(itemsFor(collection)));
        // Re-render so per-field/per-card "unsaved" markers (computed against
        // `savedState` at render time) clear now that they're saved — nothing
        // else re-renders a card on a successful Save.
        renderCollectionBody(collection);
      }
      undoStack.length = 0;
      saveBarStatus.textContent = "Saved. Ready to publish.";
      saveBarStatus.classList.add("wx-section-save-bar-status-ok");
      // Capability-guarded (unit-test fakes of `win` may omit timers, matching
      // shell.ts's own convention) — production always has a real `setTimeout`.
      if (typeof win.setTimeout === "function") {
        win.setTimeout(() => {
          if (destroyed) return;
          saveBarStatus.textContent = "";
          saveBarStatus.classList.remove("wx-section-save-bar-status-ok");
        }, SAVE_STATUS_CLEAR_MS);
      }
      void refreshDraftState();
      maybeRunPendingRefresh();
    } else {
      saveBarStatus.textContent = "Couldn't save — check your connection and try Save again.";
      saveBarStatus.classList.add("wx-section-save-bar-status-error");
    }
    refreshSaveBar();
  }

  /** Auto-saves before opening the publish drawer (decisions/00118) — fewer
   * taps than making her Save separately first, and the drawer must preview a
   * COMPLETE draft. On a save failure this stays put with the save bar's own
   * error showing rather than opening a drawer that can't see her latest
   * edits. */
  async function onPublishClick(): Promise<void> {
    if (destroyed) return;
    if (isDirty()) {
      await saveNow();
      if (destroyed || isDirty()) return;
    }
    deps.onRequestPublish?.();
  }

  let discardingAll = false;

  async function discardAll(): Promise<void> {
    // `win.confirm` blocks the main thread in a real browser, so a second
    // click can't land while it's open — but the network round-trip AFTER
    // confirming isn't blocking, so a double-click there could otherwise fire
    // two overlapping discards.
    if (destroyed || discardingAll) return;
    const ok = win.confirm(
      "Discard ALL your changes and go back to what's on your site now? This can't be undone.",
    );
    if (!ok || destroyed) return;
    discardingAll = true;
    discardAllButton.disabled = true;
    try {
      await api.discardDraft();
      if (destroyed) return;
      undoStack.length = 0;
      await load();
      deps.onDraftChanged?.();
    } finally {
      discardingAll = false;
      discardAllButton.disabled = false;
    }
  }

  async function refreshDraftState(): Promise<void> {
    try {
      const state = await api.getState();
      if (destroyed) return;
      draftOpCount = state.draft.opCount;
    } catch {
      // Best-effort — the global status bar already surfaces connectivity
      // issues; a missed read here just means the banner is stale until the
      // next successful one.
    }
    renderReadyBanner();
  }

  function renderReadyBanner(): void {
    const show = draftOpCount > 0;
    readyBanner.hidden = !show;
    if (!show) return;
    readyBannerText.textContent =
      draftOpCount === 1 ? "1 change ready to publish" : `${draftOpCount} changes ready to publish`;
  }

  // -- The before/after aligner (decisions/00111) ---------------------------
  // Offered only where it makes sense: the registry gave the collection an
  // `alignAspect` (the frame its pairs display in) AND it declares ≥2 image
  // fields. The aligner bakes adjusted photo(s) into NEW uploads and hands
  // back replacement `{src, alt}`s; the item keeps its other fields, and the
  // whole array stages as one local edit like every other panel edit.

  function alignImageFields(collection: AdminCollection): [AdminField, AdminField] | null {
    if (collection.alignAspect === null) return null;
    const imageFields = collection.fields.filter((f) => f.kind === "image");
    const first = imageFields[0];
    const second = imageFields[1];
    if (first === undefined || second === undefined) return null;
    return [first, second];
  }

  function openAlignerForSides(
    collection: AdminCollection,
    fields: [AdminField, AdminField],
    firstValue: { src: string; alt: string },
    secondValue: { src: string; alt: string },
    onResult: (result: AlignerResult) => void,
  ): void {
    const aspect = collection.alignAspect;
    if (aspect === null) return;
    openAligner(
      { api, win },
      {
        first: { key: fields[0].key, label: fields[0].label, src: firstValue.src, alt: firstValue.alt },
        second: { key: fields[1].key, label: fields[1].label, src: secondValue.src, alt: secondValue.alt },
        aspectW: aspect.w,
        aspectH: aspect.h,
      },
      (result) => {
        if (result === null || destroyed) return;
        onResult(result);
      },
    );
  }

  function openAlignerForItem(collection: AdminCollection, item: SectionItem, index: number): void {
    const fields = alignImageFields(collection);
    if (fields === null) return;
    const firstValue = imageFieldValue(item, fields[0].key);
    const secondValue = imageFieldValue(item, fields[1].key);
    if (firstValue === null || secondValue === null) return;
    openAlignerForSides(collection, fields, firstValue, secondValue, (result) => {
      const items = itemsFor(collection);
      const current = items[index];
      if (current === undefined) return;
      let next = current;
      if (result.first !== undefined) next = { ...next, [fields[0].key]: result.first };
      if (result.second !== undefined) next = { ...next, [fields[1].key]: result.second };
      stageLocal(
        collection,
        items.map((it, i) => (i === index ? next : it)),
      );
    });
  }

  function renderAlignButton(onClick: () => void): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "wx-section-align-button";
    button.textContent = "Line up photos";
    button.title = "Move, zoom or straighten one photo so it matches the other";
    button.addEventListener("click", onClick);
    return button;
  }

  function renderCardAlignButton(collection: AdminCollection, item: SectionItem, index: number): HTMLElement | null {
    const fields = alignImageFields(collection);
    if (fields === null) return null;
    // Both photos must be picked first — with one missing there's nothing to
    // line up against, and a dead button is worse than no button.
    if (imageFieldValue(item, fields[0].key) === null) return null;
    if (imageFieldValue(item, fields[1].key) === null) return null;
    return renderAlignButton(() => openAlignerForItem(collection, item, index));
  }

  // -- Card rendering -----------------------------------------------------

  function renderImageSlot(
    collection: AdminCollection,
    field: AdminField,
    item: SectionItem,
    index: number,
  ): HTMLElement {
    const slot = document.createElement("div");
    slot.className = "wx-section-image-slot";
    const picked = imageFieldValue(item, field.key);
    if (picked !== null) {
      const img = document.createElement("img");
      img.className = "wx-section-image-thumb";
      img.src = contentSrcToDisplayUrl(picked.src);
      img.alt = picked.alt;
      slot.appendChild(img);
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "wx-section-image-placeholder";
      placeholder.textContent = "No photo";
      slot.appendChild(placeholder);
    }
    const tag = document.createElement("span");
    tag.className = "wx-section-image-tag";
    tag.textContent = field.label;
    slot.appendChild(tag);
    const changeButton = document.createElement("button");
    changeButton.type = "button";
    changeButton.className = "wx-section-image-change";
    changeButton.textContent = picked === null ? "Add photo" : "Change";
    changeButton.addEventListener("click", () => {
      openMediaDialog({ api, win }, (value: MediaPickValue | null) => {
        if (value === null || destroyed) return;
        const items = itemsFor(collection);
        stageLocal(
          collection,
          updateItemField(items, index, field.key, { src: value.src, alt: value.alt }),
        );
      });
    });
    slot.appendChild(changeButton);
    return slot;
  }

  function renderTextField(
    collection: AdminCollection,
    field: AdminField,
    item: SectionItem,
    index: number,
  ): HTMLElement {
    const wrap = document.createElement("label");
    wrap.className = "wx-section-field";
    const labelText = document.createElement("span");
    labelText.className = "wx-section-field-label";
    labelText.textContent = field.label;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "wx-section-field-input";
    if (fieldDirty(itemsFor(collection), savedState.get(collection.path) ?? [], index, field.key)) {
      input.classList.add("wx-field-dirty");
    }
    input.value = decodeCommonEntities(textFieldValue(item, field.key));
    const commitValue = (): void => {
      if (destroyed) return;
      const current = itemsFor(collection);
      if (textFieldValue(current[index] ?? {}, field.key) === input.value) return;
      stageLocal(collection, updateItemField(current, index, field.key, input.value));
    };
    input.addEventListener("blur", commitValue);
    input.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") input.blur();
    });
    wrap.append(labelText, input);
    return wrap;
  }

  function renderChoiceField(
    collection: AdminCollection,
    field: AdminField,
    item: SectionItem,
    index: number,
  ): HTMLElement {
    const wrap = document.createElement("label");
    wrap.className = "wx-section-field";
    const labelText = document.createElement("span");
    labelText.className = "wx-section-field-label";
    labelText.textContent = field.label;
    const select = document.createElement("select");
    select.className = "wx-section-field-select";
    if (fieldDirty(itemsFor(collection), savedState.get(collection.path) ?? [], index, field.key)) {
      select.classList.add("wx-field-dirty");
    }
    for (const option of field.options) {
      const optionEl = document.createElement("option");
      optionEl.value = option.value;
      optionEl.textContent = option.label;
      select.appendChild(optionEl);
    }
    select.value = textFieldValue(item, field.key);
    select.addEventListener("change", () => {
      if (destroyed) return;
      const current = itemsFor(collection);
      stageLocal(collection, updateItemField(current, index, field.key, select.value));
    });
    wrap.append(labelText, select);
    return wrap;
  }

  /** `visible` items convention (docs/ai/invariants.md, sibling of Inv 10):
   * absent/`true` = shown, `false` = hidden from the public site but still
   * fully editable here. A full-width card-header switch (decisions/00119,
   * replacing the old small "Hidden" chip) — the explanatory line IS the fix
   * for "unclear why entries are greyed out": a plain sentence instead of a
   * one-word chip. The whole bar is a `<label>` so tapping the text also
   * toggles it (native label-wraps-control semantics, same as the old
   * per-field toggle this replaces). Still stages via `stageLocal` (PR1's
   * model) — never auto-saves. */
  function renderVisibilityBar(
    collection: AdminCollection,
    field: AdminField,
    item: SectionItem,
    index: number,
  ): HTMLElement {
    const checked = item[field.key] !== false;

    const bar = document.createElement("label");
    bar.className = "wx-section-visibility-bar";

    const switchEl = document.createElement("span");
    switchEl.className = "wx-switch";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "wx-switch-input";
    input.checked = checked;
    input.addEventListener("change", () => {
      if (destroyed) return;
      const current = itemsFor(collection);
      stageLocal(
        collection,
        input.checked
          ? removeItemField(current, index, field.key)
          : updateItemField(current, index, field.key, false),
      );
    });
    const track = document.createElement("span");
    track.className = "wx-switch-track";
    const thumb = document.createElement("span");
    thumb.className = "wx-switch-thumb";
    track.appendChild(thumb);
    switchEl.append(input, track);

    const text = document.createElement("span");
    text.className = "wx-section-visibility-text";
    text.textContent = checked ? "Shown on your site" : "Hidden — not on your site yet. Turn on to add it.";

    bar.append(switchEl, text);
    return bar;
  }

  // -- Inline before/after preview (decisions/00119, PR3) -------------------
  // Read-only drag-to-compare, distinct from the aligner (a heavyweight
  // canvas EDITOR this never reuses) — a collection with >=2 `image`-kind
  // fields where BOTH are filled gets one under its images block; tapping
  // the expand button opens the SAME component larger in a modal. NEVER
  // fabricated from a single image (a tile, or a pair with one photo still
  // missing, just keeps its existing thumbnail(s) as-is).

  function openBeforeAfterModal(beforeUrl: string, afterUrl: string, beforeAlt: string, afterAlt: string): void {
    const backdrop = document.createElement("div");
    backdrop.className = "wx-before-after-modal-backdrop";
    const box = document.createElement("div");
    box.className = "wx-before-after-modal";

    function close(): void {
      backdrop.remove();
    }
    const header = document.createElement("div");
    header.className = "wx-drawer-header";
    const heading = document.createElement("h3");
    heading.textContent = "Before & after";
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "wx-drawer-close";
    closeButton.textContent = "✕";
    closeButton.setAttribute("aria-label", "Close");
    closeButton.addEventListener("click", close);
    header.append(heading, closeButton);

    const preview = renderBeforeAfter({ beforeUrl, afterUrl, beforeAlt, afterAlt });

    box.append(header, preview);
    backdrop.appendChild(box);
    backdrop.addEventListener("click", (evt) => {
      if (evt.target === backdrop) close();
    });
    function onEscape(evt: KeyboardEvent): void {
      if (evt.key === "Escape") close();
    }
    win.addEventListener("keydown", onEscape);
    const originalRemove = backdrop.remove.bind(backdrop);
    backdrop.remove = (): void => {
      win.removeEventListener("keydown", onEscape);
      originalRemove();
    };
    element.appendChild(backdrop);
  }

  function renderBeforeAfterPreview(beforeUrl: string, afterUrl: string, beforeAlt: string, afterAlt: string): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "wx-section-before-after-wrap";
    const slider = renderBeforeAfter({ beforeUrl, afterUrl, beforeAlt, afterAlt });
    const expandButton = document.createElement("button");
    expandButton.type = "button";
    expandButton.className = "wx-section-before-after-expand";
    expandButton.textContent = "⤢";
    expandButton.setAttribute("aria-label", "View larger");
    expandButton.addEventListener("click", () => openBeforeAfterModal(beforeUrl, afterUrl, beforeAlt, afterAlt));
    wrap.append(slider, expandButton);
    return wrap;
  }

  /** `null` unless the collection declares >=2 `image`-kind fields AND the
   * first two are both filled on THIS item — never fabricated from one
   * photo (Inv 1: which fields are images comes from the registry, never a
   * hardcoded `before`/`after` key name). */
  function beforeAfterPreviewFor(collection: AdminCollection, item: SectionItem): HTMLElement | null {
    const imageFields = collection.fields.filter((f) => f.kind === "image");
    const beforeField = imageFields[0];
    const afterField = imageFields[1];
    if (beforeField === undefined || afterField === undefined) return null;
    const beforeValue = imageFieldValue(item, beforeField.key);
    const afterValue = imageFieldValue(item, afterField.key);
    if (beforeValue === null || afterValue === null) return null;
    return renderBeforeAfterPreview(
      contentSrcToDisplayUrl(beforeValue.src),
      contentSrcToDisplayUrl(afterValue.src),
      beforeValue.alt,
      afterValue.alt,
    );
  }

  function renderCard(collection: AdminCollection, item: SectionItem, index: number, count: number): HTMLElement {
    const card = document.createElement("div");
    card.className = "wx-section-card";
    card.dataset["index"] = String(index);
    const hidden = item["visible"] === false;
    if (hidden) card.classList.add("wx-section-card-hidden");
    const saved = savedState.get(collection.path) ?? [];
    const dirty = itemDirty(itemsFor(collection), saved, index);
    if (dirty) card.classList.add("wx-section-card-dirty");

    const toggleField = collection.fields.find((f) => f.kind === "toggle");
    const visibilityBar =
      toggleField !== undefined ? renderVisibilityBar(collection, toggleField, item, index) : null;

    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "wx-section-drag-handle";
    handle.textContent = "⠿";
    handle.setAttribute("aria-label", `Drag to reorder this ${collection.itemNoun}`);
    attachDragHandlers(collection, handle, card);

    const images = document.createElement("div");
    images.className = "wx-section-card-images";
    for (const field of collection.fields) {
      if (field.kind === "image") images.appendChild(renderImageSlot(collection, field, item, index));
    }

    const beforeAfterPreview = beforeAfterPreviewFor(collection, item);

    const fields = document.createElement("div");
    fields.className = "wx-section-card-fields";
    for (const field of collection.fields) {
      if (field.kind === "text") fields.appendChild(renderTextField(collection, field, item, index));
      if (field.kind === "choice") fields.appendChild(renderChoiceField(collection, field, item, index));
    }

    const actions = document.createElement("div");
    actions.className = "wx-section-card-actions";

    const alignButton = renderCardAlignButton(collection, item, index);

    const upButton = document.createElement("button");
    upButton.type = "button";
    upButton.className = "wx-section-move-button";
    upButton.textContent = "↑";
    upButton.setAttribute("aria-label", "Move up");
    upButton.disabled = index === 0;
    upButton.addEventListener("click", () => stageLocal(collection, moveItemUp(itemsFor(collection), index)));

    const downButton = document.createElement("button");
    downButton.type = "button";
    downButton.className = "wx-section-move-button";
    downButton.textContent = "↓";
    downButton.setAttribute("aria-label", "Move down");
    downButton.disabled = index === count - 1;
    downButton.addEventListener("click", () => stageLocal(collection, moveItemDown(itemsFor(collection), index)));

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "wx-section-delete-button";
    deleteButton.textContent = "Remove";
    deleteButton.addEventListener("click", () => {
      const ok = win.confirm(
        `Remove this ${collection.itemNoun}? You can undo with "Undo last" until you Save, or "Discard unsaved" to drop every change since your last Save.`,
      );
      if (!ok) return;
      stageLocal(collection, deleteItemAt(itemsFor(collection), index));
    });

    if (alignButton !== null) actions.append(alignButton);
    actions.append(upButton, downButton, deleteButton);

    if (dirty) {
      const unsavedBadge = document.createElement("span");
      unsavedBadge.className = "wx-section-unsaved-badge";
      unsavedBadge.textContent = "Unsaved";
      card.appendChild(unsavedBadge);
    }
    card.append(
      ...(visibilityBar !== null ? [visibilityBar] : []),
      handle,
      images,
      ...(beforeAfterPreview !== null ? [beforeAfterPreview] : []),
      fields,
      actions,
    );
    return card;
  }

  // -- Pointer-based drag-to-reorder ---------------------------------------
  // A drop indicator line, not a live-reflow drag — simpler to keep correct
  // than tracking every other card's transform mid-drag, and the ↑/↓ buttons
  // above already cover the no-pointer / accessibility case, so this is a
  // convenience on top rather than the only way to reorder (spec 3c).

  function attachDragHandlers(collection: AdminCollection, handle: HTMLElement, card: HTMLElement): void {
    handle.addEventListener("pointerdown", (evt) => {
      evt.preventDefault();
      const grid = card.parentElement;
      if (grid === null) return;
      const startIndex = Number(card.dataset["index"] ?? "-1");
      if (startIndex < 0) return;
      card.classList.add("wx-section-card-dragging");
      let dropIndex = startIndex;

      const indicator = document.createElement("div");
      indicator.className = "wx-section-drop-indicator";

      const onMove = (moveEvt: PointerEvent): void => {
        const siblings = Array.from(grid.querySelectorAll<HTMLElement>(".wx-section-card"));
        let target = siblings.length;
        for (let i = 0; i < siblings.length; i++) {
          const sibling = siblings[i];
          if (sibling === undefined || sibling === card) continue;
          const rect = sibling.getBoundingClientRect();
          const midpoint = rect.top + rect.height / 2;
          if (moveEvt.clientY < midpoint) {
            target = i;
            break;
          }
        }
        dropIndex = target;
        indicator.remove();
        const targetSibling = siblings[target];
        if (targetSibling !== undefined) grid.insertBefore(indicator, targetSibling);
        else grid.appendChild(indicator);
      };

      const onUp = (): void => {
        win.removeEventListener("pointermove", onMove);
        win.removeEventListener("pointerup", onUp);
        indicator.remove();
        card.classList.remove("wx-section-card-dragging");
        // `dropIndex` counts every OTHER card ahead of the drop point; the
        // dragged card itself still occupies `startIndex` in the source
        // array, so a drop point past it needs shifting back by one to land
        // in the right final slot (moveItemTo splices the source out first).
        const adjusted = dropIndex > startIndex ? dropIndex - 1 : dropIndex;
        if (adjusted !== startIndex) {
          stageLocal(collection, moveItemTo(itemsFor(collection), startIndex, adjusted));
        }
      };

      win.addEventListener("pointermove", onMove);
      win.addEventListener("pointerup", onUp);
    });
  }

  // -- Guided add flow ------------------------------------------------------
  // A linear wizard: one step per image field (in field order), then a final
  // form step for every text/choice field — generalizes the brief's literal
  // "step 1 Before, step 2 After, step 3 form" to however many image fields a
  // collection actually declares (one for `gallery.tiles`, two for
  // `gallery.sliders`), so the flow never hardcodes a specific collection's
  // shape. Save stays disabled until `isNewItemComplete` — a new item is
  // always born schema-valid, never a half-filled placeholder in the array.
  // Its own "Save" finishes the WIZARD (stages the finished item locally,
  // decisions/00118) — a SEPARATE step from the panel-level Save bar, which
  // is what actually writes it to the draft.

  function openAddFlow(collection: AdminCollection): void {
    const imageFields = collection.fields.filter((f) => f.kind === "image");
    let draft = blankItem(collection.fields);
    let stepIndex = 0; // 0..imageFields.length-1 are photo steps; the last step is the form.
    const totalSteps = imageFields.length + 1;

    // Deliberately its OWN class names, not a reuse of `.wx-media-dialog-
    // backdrop`/`.wx-media-dialog` (this flow itself opens the REAL media
    // dialog on top of this one mid-flow, per image step -- sharing a class
    // with it made the two indistinguishable to any selector, a real E2E
    // strict-mode-violation failure this test suite's own coverage caught).
    const backdrop = document.createElement("div");
    backdrop.className = "wx-section-add-backdrop";
    const dialog = document.createElement("div");
    dialog.className = "wx-section-add-dialog";
    backdrop.appendChild(dialog);

    function close(): void {
      backdrop.remove();
    }
    backdrop.addEventListener("click", (evt) => {
      if (evt.target === backdrop) close();
    });
    function onEscape(evt: KeyboardEvent): void {
      if (evt.key === "Escape") close();
    }
    win.addEventListener("keydown", onEscape);
    const originalRemove = backdrop.remove.bind(backdrop);
    backdrop.remove = (): void => {
      win.removeEventListener("keydown", onEscape);
      originalRemove();
    };

    function renderStep(): void {
      dialog.innerHTML = "";
      const header = document.createElement("div");
      header.className = "wx-drawer-header";
      const heading = document.createElement("h3");
      heading.textContent = `Add a ${collection.itemNoun}`;
      const closeButton = document.createElement("button");
      closeButton.type = "button";
      closeButton.className = "wx-drawer-close";
      closeButton.textContent = "✕";
      closeButton.setAttribute("aria-label", "Cancel");
      closeButton.addEventListener("click", close);
      header.append(heading, closeButton);
      dialog.appendChild(header);

      const progress = document.createElement("p");
      progress.className = "wx-section-add-progress";
      progress.textContent = `Step ${stepIndex + 1} of ${totalSteps}`;
      dialog.appendChild(progress);

      if (stepIndex < imageFields.length) {
        renderImageStep(imageFields[stepIndex] as AdminField);
      } else {
        renderFormStep();
      }
    }

    function renderImageStep(field: AdminField): void {
      const prompt = document.createElement("p");
      prompt.textContent = `Choose the ${field.label.toLowerCase()}.`;
      dialog.appendChild(prompt);

      const picked = imageFieldValue(draft, field.key);
      if (picked !== null) {
        const preview = document.createElement("img");
        preview.className = "wx-section-add-preview";
        preview.src = contentSrcToDisplayUrl(picked.src);
        preview.alt = picked.alt;
        dialog.appendChild(preview);
      }

      const pickButton = document.createElement("button");
      pickButton.type = "button";
      pickButton.className = "wx-publish-button";
      pickButton.textContent = picked === null ? `Choose ${field.label}` : "Change photo";
      pickButton.addEventListener("click", () => {
        openMediaDialog({ api, win }, (value: MediaPickValue | null) => {
          if (value === null) return;
          draft = { ...draft, [field.key]: { src: value.src, alt: value.alt } };
          renderStep();
        });
      });
      dialog.appendChild(pickButton);

      const nav = document.createElement("div");
      nav.className = "wx-section-add-nav";
      if (stepIndex > 0) {
        const back = document.createElement("button");
        back.type = "button";
        back.className = "wx-media-delete";
        back.textContent = "Back";
        back.addEventListener("click", () => {
          stepIndex -= 1;
          renderStep();
        });
        nav.appendChild(back);
      }
      const next = document.createElement("button");
      next.type = "button";
      next.className = "wx-publish-button";
      next.textContent = "Next";
      next.disabled = picked === null;
      next.addEventListener("click", () => {
        stepIndex += 1;
        renderStep();
      });
      nav.appendChild(next);
      dialog.appendChild(nav);
    }

    function renderFormStep(): void {
      const form = document.createElement("div");
      form.className = "wx-section-add-form";
      for (const field of collection.fields) {
        if (field.kind === "image") continue;
        let row: HTMLElement;
        if (field.kind === "text") row = renderTextInputRow(field);
        else if (field.kind === "choice") row = renderChoiceInputRow(field);
        else row = renderToggleInputRow(field);
        form.appendChild(row);
      }
      dialog.appendChild(form);

      // The exact moment Purdi hit the wall (2026-08-02): she had JUST added
      // a pair and couldn't make the two photos match. Offer the aligner
      // right here in the add flow too — the result simply becomes the new
      // item's photo(s), before the item is ever saved.
      const alignFields = alignImageFields(collection);
      if (alignFields !== null) {
        const firstValue = imageFieldValue(draft, alignFields[0].key);
        const secondValue = imageFieldValue(draft, alignFields[1].key);
        if (firstValue !== null && secondValue !== null) {
          dialog.appendChild(
            renderAlignButton(() => {
              openAlignerForSides(collection, alignFields, firstValue, secondValue, (result) => {
                if (result.first !== undefined) draft = { ...draft, [alignFields[0].key]: result.first };
                if (result.second !== undefined) draft = { ...draft, [alignFields[1].key]: result.second };
              });
            }),
          );
        }
      }

      const nav = document.createElement("div");
      nav.className = "wx-section-add-nav";
      if (imageFields.length > 0) {
        const back = document.createElement("button");
        back.type = "button";
        back.className = "wx-media-delete";
        back.textContent = "Back";
        back.addEventListener("click", () => {
          stepIndex -= 1;
          renderStep();
        });
        nav.appendChild(back);
      }
      const saveButton = document.createElement("button");
      saveButton.type = "button";
      saveButton.className = "wx-publish-button";
      saveButton.textContent = "Save";
      saveButton.disabled = !isNewItemComplete(collection.fields, draft);
      saveButton.addEventListener("click", () => {
        if (destroyed) return;
        stageLocal(collection, appendItem(itemsFor(collection), draft));
        close();
      });
      nav.appendChild(saveButton);
      dialog.appendChild(nav);

      function refreshSaveEnabled(): void {
        saveButton.disabled = !isNewItemComplete(collection.fields, draft);
      }

      function renderTextInputRow(field: AdminField): HTMLElement {
        const wrap = document.createElement("label");
        wrap.className = "wx-section-field";
        const labelText = document.createElement("span");
        labelText.className = "wx-section-field-label";
        labelText.textContent = field.label;
        const input = document.createElement("input");
        input.type = "text";
        input.value = textFieldValue(draft, field.key);
        input.addEventListener("input", () => {
          draft = { ...draft, [field.key]: input.value };
          refreshSaveEnabled();
        });
        wrap.append(labelText, input);
        return wrap;
      }

      function renderChoiceInputRow(field: AdminField): HTMLElement {
        const wrap = document.createElement("label");
        wrap.className = "wx-section-field";
        const labelText = document.createElement("span");
        labelText.className = "wx-section-field-label";
        labelText.textContent = field.label;
        const select = document.createElement("select");
        for (const option of field.options) {
          const optionEl = document.createElement("option");
          optionEl.value = option.value;
          optionEl.textContent = option.label;
          select.appendChild(optionEl);
        }
        select.value = textFieldValue(draft, field.key);
        select.addEventListener("change", () => {
          draft = { ...draft, [field.key]: select.value };
          refreshSaveEnabled();
        });
        wrap.append(labelText, select);
        return wrap;
      }

      // A new item is born SHOWN (blankItem seeds no key for a toggle field,
      // and absent means visible) — the switch here starts checked/on, and
      // only writes a key at all if she flips it off before saving.
      function renderToggleInputRow(field: AdminField): HTMLElement {
        const wrap = document.createElement("label");
        wrap.className = "wx-section-field wx-section-field-toggle";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.className = "wx-section-toggle-input";
        input.checked = draft[field.key] !== false;
        input.addEventListener("change", () => {
          if (input.checked) {
            const { [field.key]: _removed, ...rest } = draft;
            draft = rest;
          } else {
            draft = { ...draft, [field.key]: false };
          }
          refreshSaveEnabled();
        });
        const labelText = document.createElement("span");
        labelText.className = "wx-section-toggle-label";
        labelText.textContent = field.label;
        wrap.append(input, labelText);
        return wrap;
      }
    }

    renderStep();
    element.appendChild(backdrop);
  }

  // -- Collection layout -----------------------------------------------------

  function renderCollectionBody(collection: AdminCollection): void {
    const collectionBody = collectionBodies.get(collection.path);
    if (collectionBody === undefined) return;
    collectionBody.innerHTML = "";
    const items = itemsFor(collection);
    if (items.length === 0) {
      const empty = document.createElement("p");
      empty.className = "wx-section-empty";
      empty.textContent = `No ${collection.itemNoun}s yet — add your first ${collection.itemNoun}.`;
      collectionBody.appendChild(empty);
      return;
    }
    const grid = document.createElement("div");
    grid.className = "wx-section-card-grid";
    items.forEach((item, index) => grid.appendChild(renderCard(collection, item, index, items.length)));
    collectionBody.appendChild(grid);
  }

  function itemNounPlural(collection: AdminCollection, count: number): string {
    return count === 1 ? collection.itemNoun : `${collection.itemNoun}s`;
  }

  /** "Turn all on/off" (decisions/00119) — bulk-applies the SAME toggle every
   * card's own switch drives, via the same `stageLocal` chokepoint (one undo
   * step, one Save). A no-op on an empty collection needs no confirm — there
   * is nothing to change. */
  function turnAllOn(collection: AdminCollection, field: AdminField): void {
    const items = itemsFor(collection);
    if (items.length === 0) return;
    const ok = win.confirm(
      `Show all ${items.length} ${itemNounPlural(collection, items.length)} on your site? You choose when to publish.`,
    );
    if (!ok) return;
    stageLocal(collection, showAllItems(items, field.key));
  }

  function turnAllOff(collection: AdminCollection, field: AdminField): void {
    const items = itemsFor(collection);
    if (items.length === 0) return;
    const ok = win.confirm(
      `Hide all ${items.length} ${itemNounPlural(collection, items.length)} from your site? You choose when to publish.`,
    );
    if (!ok) return;
    stageLocal(collection, hideAllItems(items, field.key));
  }

  function renderCollectionSection(collection: AdminCollection): HTMLElement {
    const section = document.createElement("div");
    section.className = "wx-section-collection";

    const collectionHeader = document.createElement("div");
    collectionHeader.className = "wx-section-collection-header";
    const label = document.createElement("h3");
    label.textContent = collection.label;

    const headerActions = document.createElement("div");
    headerActions.className = "wx-section-collection-header-actions";

    const toggleField = collection.fields.find((f) => f.kind === "toggle");
    if (toggleField !== undefined) {
      const turnAllOnButton = document.createElement("button");
      turnAllOnButton.type = "button";
      turnAllOnButton.className = "wx-section-turn-all-button";
      turnAllOnButton.textContent = "Turn all on";
      turnAllOnButton.addEventListener("click", () => turnAllOn(collection, toggleField));
      const turnAllOffButton = document.createElement("button");
      turnAllOffButton.type = "button";
      turnAllOffButton.className = "wx-section-turn-all-button";
      turnAllOffButton.textContent = "Turn all off";
      turnAllOffButton.addEventListener("click", () => turnAllOff(collection, toggleField));
      headerActions.append(turnAllOnButton, turnAllOffButton);
    }

    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.className = "wx-publish-button wx-section-add-button";
    addButton.textContent = `Add a ${collection.itemNoun}`;
    addButton.addEventListener("click", () => openAddFlow(collection));
    headerActions.appendChild(addButton);

    collectionHeader.append(label, headerActions);

    const collectionBody = document.createElement("div");
    collectionBody.className = "wx-section-collection-body";
    collectionBodies.set(collection.path, collectionBody);

    section.append(collectionHeader, collectionBody);
    return section;
  }

  async function load(): Promise<void> {
    const [content] = await Promise.all([api.getContent(section.page), refreshDraftState()]);
    for (const collection of section.collections) {
      const items = itemsAt(content.content, collection.path);
      collectionState.set(collection.path, items);
      savedState.set(collection.path, cloneItems(items));
    }
    undoStack.length = 0;
    if (destroyed) return;
    body.innerHTML = "";
    collectionBodies.clear();
    for (const collection of section.collections) {
      body.appendChild(renderCollectionSection(collection));
      renderCollectionBody(collection);
    }
    refreshSaveBar();
  }

  // -- Refreshing behind the owner's back (decisions/00115, 00118) ----------
  // A re-read is only safe when it can't discard something she is part-way
  // through: text fields commit on BLUR, so a re-render mid-typing would throw
  // away the characters typed so far, and the op queue coalesces at 300 ms, so
  // re-reading before it flushes would read back the pre-edit value. Under the
  // staged-save model an even more common case is local edits she simply
  // hasn't pressed Save on yet — those must never be silently discarded by a
  // refresh triggered from elsewhere (another tab/device publishing, or an
  // AI-lane repair), so a refresh also defers while the panel is dirty.

  function isEditingInPanel(): boolean {
    const active = element.ownerDocument.activeElement;
    if (active === null || !element.contains(active)) return false;
    return ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName);
  }

  let refreshPending = false;

  async function refreshFromServer(): Promise<void> {
    await opQueue.flushNow();
    if (destroyed) return;
    await load();
  }

  function requestRefresh(): void {
    if (destroyed) return;
    if (isEditingInPanel() || isDirty()) {
      refreshPending = true; // deferred to focusout / the next safe moment, never dropped
      return;
    }
    refreshPending = false;
    void refreshFromServer();
  }

  element.addEventListener("focusout", () => {
    if (!refreshPending) return;
    // A timeout so the blur handler's own commit has enqueued first, and so
    // focus moving between two fields inside the panel doesn't count as done.
    win.setTimeout(() => {
      if (destroyed || !refreshPending) return;
      maybeRunPendingRefresh();
    }, 0);
  });

  // -- Unsaved-work guard (decisions/00118) ----------------------------------
  // A real browser tab close/reload with unsaved local edits must prompt —
  // the in-app route-change guard (shell.ts's handleRoute) covers navigating
  // to another admin panel; this covers leaving the page/tab entirely.

  function onBeforeUnload(event: BeforeUnloadEvent): void {
    if (!isDirty()) return;
    event.preventDefault();
    event.returnValue = "";
  }
  win.addEventListener("beforeunload", onBeforeUnload as EventListener);

  body.textContent = "Loading…";
  void load();

  return {
    element,
    refresh: requestRefresh,
    hasUnsavedChanges: () => isDirty(),
    teardown(): void {
      destroyed = true;
      win.removeEventListener("beforeunload", onBeforeUnload as EventListener);
    },
  };
}
