// Registry-configured section editor (spec 3c, decisions/00098) — the
// dedicated Before & After management screen and any future registry-declared
// section (Inv 1: no site literals here, everything comes from the
// `AdminSection`/`AdminCollection`/`AdminField` config passed in). Owns its
// own fetch (`api.getContent`), unlike `pagesPanel.ts`'s `renderXPanel(data,
// callbacks)` shape — a section's collection VALUES live in page content, not
// in `StateResponse`, so this mirrors `mediaPanel.ts`'s `mountXPanel(api,
// win)` "owns its own lifecycle" precedent instead.

import type { AdminApi, AdminCollection, AdminField, AdminSection } from "./api";
import type { OpQueueLike } from "./editView";
import { openAlignerDialog, type AlignerResult } from "./alignerDialog";
import { contentSrcToDisplayUrl, openMediaDialog, type MediaPickValue } from "./mediaDialog";
import {
  appendItem,
  blankItem,
  decodeCommonEntities,
  deleteItemAt,
  imageFieldValue,
  isNewItemComplete,
  itemsAt,
  moveItemDown,
  moveItemUp,
  moveItemTo,
  removeItemField,
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
   * the staged file) or a draft repair. Without it the panel's array keeps
   * pre-publish `/admin/draft-media/` srcs whose files are gone, and the very
   * next edit writes them all back as one op, blocking the next publish. */
  refresh(): void;
  teardown(): void;
}

export interface SectionPanelDeps {
  api: AdminApi;
  opQueue: OpQueueLike;
  win?: Window;
  /** Test seam for the aligner (decisions/00111): the dialog paints on a
   * real canvas, which jsdom doesn't have — panel tests stub this and drive
   * its `respond` callback directly. Production always uses the real one. */
  openAligner?: typeof openAlignerDialog;
}

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

  const body = document.createElement("div");
  body.className = "wx-section-body";

  const footer = document.createElement("p");
  footer.className = "wx-section-footer-note";
  footer.textContent = "Changes here are drafts until you press Publish.";

  element.append(header, body, footer);

  // The panel's own working copy of each collection's array while mounted
  // (spec 3c: "the panel state — the panel is the array's source of truth
  // while mounted"); every mutation writes the WHOLE array as one op and the
  // shell's shared `opQueue.onAccepted` callback (wired once in shell.ts,
  // not here) refreshes the draft chip/status bar exactly like any edit.
  const collectionState = new Map<string, SectionItem[]>();
  const collectionBodies = new Map<string, HTMLElement>();

  function itemsFor(collection: AdminCollection): SectionItem[] {
    return collectionState.get(collection.path) ?? [];
  }

  function commit(collection: AdminCollection, items: SectionItem[]): void {
    collectionState.set(collection.path, items);
    opQueue.enqueue({ file: section.page, path: collection.path, value: items });
    renderCollectionBody(collection);
  }

  // -- The before/after aligner (decisions/00111) ---------------------------
  // Offered only where it makes sense: the registry gave the collection an
  // `alignAspect` (the frame its pairs display in) AND it declares ≥2 image
  // fields. The aligner bakes adjusted photo(s) into NEW uploads and hands
  // back replacement `{src, alt}`s; the item keeps its other fields, and the
  // whole array commits as one op like every other panel edit.

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
      commit(
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
        commit(
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
    input.value = decodeCommonEntities(textFieldValue(item, field.key));
    const commitValue = (): void => {
      if (destroyed) return;
      const current = itemsFor(collection);
      if (textFieldValue(current[index] ?? {}, field.key) === input.value) return;
      commit(collection, updateItemField(current, index, field.key, input.value));
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
      commit(collection, updateItemField(current, index, field.key, select.value));
    });
    wrap.append(labelText, select);
    return wrap;
  }

  /** `visible` items convention (docs/ai/invariants.md, sibling of Inv 10):
   * absent/`true` = shown, `false` = hidden from the public site but still
   * fully editable here, dimmed with a "Hidden" chip so it's obvious at a
   * glance which imports are still switched off. */
  function renderToggleField(
    collection: AdminCollection,
    field: AdminField,
    item: SectionItem,
    index: number,
  ): HTMLElement {
    const wrap = document.createElement("label");
    wrap.className = "wx-section-field wx-section-field-toggle";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "wx-section-toggle-input";
    input.checked = item[field.key] !== false;
    input.addEventListener("change", () => {
      if (destroyed) return;
      const current = itemsFor(collection);
      commit(
        collection,
        input.checked
          ? removeItemField(current, index, field.key)
          : updateItemField(current, index, field.key, false),
      );
    });
    const labelText = document.createElement("span");
    labelText.className = "wx-section-toggle-label";
    labelText.textContent = field.label;
    wrap.append(input, labelText);
    return wrap;
  }

  function renderCard(collection: AdminCollection, item: SectionItem, index: number, count: number): HTMLElement {
    const card = document.createElement("div");
    card.className = "wx-section-card";
    card.dataset["index"] = String(index);
    const hidden = item["visible"] === false;
    if (hidden) card.classList.add("wx-section-card-hidden");

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

    const fields = document.createElement("div");
    fields.className = "wx-section-card-fields";
    for (const field of collection.fields) {
      if (field.kind === "text") fields.appendChild(renderTextField(collection, field, item, index));
      if (field.kind === "choice") fields.appendChild(renderChoiceField(collection, field, item, index));
      if (field.kind === "toggle") fields.appendChild(renderToggleField(collection, field, item, index));
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
    upButton.addEventListener("click", () => commit(collection, moveItemUp(itemsFor(collection), index)));

    const downButton = document.createElement("button");
    downButton.type = "button";
    downButton.className = "wx-section-move-button";
    downButton.textContent = "↓";
    downButton.setAttribute("aria-label", "Move down");
    downButton.disabled = index === count - 1;
    downButton.addEventListener("click", () => commit(collection, moveItemDown(itemsFor(collection), index)));

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "wx-section-delete-button";
    deleteButton.textContent = "Remove";
    deleteButton.addEventListener("click", () => {
      const ok = win.confirm(
        `Remove this ${collection.itemNoun}? You can undo by discarding your draft changes.`,
      );
      if (!ok) return;
      commit(collection, deleteItemAt(itemsFor(collection), index));
    });

    if (alignButton !== null) actions.append(alignButton);
    actions.append(upButton, downButton, deleteButton);

    if (hidden) {
      const chip = document.createElement("span");
      chip.className = "wx-section-hidden-chip";
      chip.textContent = "Hidden";
      card.appendChild(chip);
    }
    card.append(handle, images, fields, actions);
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
          commit(collection, moveItemTo(itemsFor(collection), startIndex, adjusted));
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
        commit(collection, appendItem(itemsFor(collection), draft));
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

  function renderCollectionSection(collection: AdminCollection): HTMLElement {
    const section = document.createElement("div");
    section.className = "wx-section-collection";

    const collectionHeader = document.createElement("div");
    collectionHeader.className = "wx-section-collection-header";
    const label = document.createElement("h3");
    label.textContent = collection.label;
    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.className = "wx-publish-button wx-section-add-button";
    addButton.textContent = `Add a ${collection.itemNoun}`;
    addButton.addEventListener("click", () => openAddFlow(collection));
    collectionHeader.append(label, addButton);

    const collectionBody = document.createElement("div");
    collectionBody.className = "wx-section-collection-body";
    collectionBodies.set(collection.path, collectionBody);

    section.append(collectionHeader, collectionBody);
    return section;
  }

  async function load(): Promise<void> {
    const content = await api.getContent(section.page);
    for (const collection of section.collections) {
      collectionState.set(collection.path, itemsAt(content.content, collection.path));
    }
    if (destroyed) return;
    body.innerHTML = "";
    collectionBodies.clear();
    for (const collection of section.collections) {
      body.appendChild(renderCollectionSection(collection));
      renderCollectionBody(collection);
    }
  }

  // -- Refreshing behind the owner's back (decisions/00115) -----------------
  // A re-read is only safe when it can't discard something she is part-way
  // through: text fields commit on BLUR, so a re-render mid-typing would throw
  // away the characters typed so far, and the op queue coalesces at 300 ms, so
  // re-reading before it flushes would read back the pre-edit value.

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
    if (isEditingInPanel()) {
      refreshPending = true; // deferred to the focusout below, never dropped
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
      if (destroyed || !refreshPending || isEditingInPanel()) return;
      refreshPending = false;
      void refreshFromServer();
    }, 0);
  });

  body.textContent = "Loading…";
  void load();

  return {
    element,
    refresh: requestRefresh,
    teardown(): void {
      destroyed = true;
    },
  };
}
