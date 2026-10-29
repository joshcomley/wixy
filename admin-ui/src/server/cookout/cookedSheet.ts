// "WE COOKED IT!" (workspace 00058; spec/server-chat/09a-cookout-twists.md §1.8 T4, §9): the memory-book
// corner of a banked recipe. Mark it cooked, each give it hearts, and put a photo of the real plate next
// to the chef's daydream.
//
//   [ 👩‍🍳 We cooked it! ]                                  <- before
//   [ ✓ Cooked                                      ⋯ ]    <- after (⋯ → Remove photo / Unmark as cooked)
//   [ You     ♥ ♥ ♥ ♥ ♡   (tap to change)              ]
//   [ Cupcake ♥ ♥ ♥ ♡ ♡                                 ]
//   [ [ Chef's daydream ] [ Our plate / + Add our photo ] ]
//
// There is no upload here (09a §1.8 "no new upload path"): "Add our photo" chooses from the photos already
// sent in THIS round's mini chat (`GET /cookout/{seq}/photos`, one entry per message), and "Send a new photo
// to this game's chat" opens the round's mini-chat pop-up so the photo lives in the chat like any other.
// The link posts back exactly the `messageSeq` AND `attachmentId` the chooser showed; when the server says
// that photo changed (`409 bad_state`) the chooser says so and opens again with a fresh list.
//
// Every action names the recipe's OWN generation (a dish from before a rescue swap keeps its own), never
// the round's current one (09a §1.10). Ratings are visible to both players at once — it is a memory book,
// not a blind game. Everything user-visible is set via `textContent`.

import type { Concept, ConceptId, CookoutOutcome, CookoutView, PhotosResult, Picture, RecipeSlot, RoundPhoto } from "./api";
import { MAX_RATING } from "./api";

export interface CookedApi {
  markCooked(seq: number, generation: number, conceptId: ConceptId, cooked: boolean): Promise<CookoutOutcome>;
  rate(seq: number, generation: number, conceptId: ConceptId, rating: number | null): Promise<CookoutOutcome>;
  linkPhoto(
    seq: number,
    generation: number,
    conceptId: ConceptId,
    messageSeq: number | null,
    attachmentId: string | null,
  ): Promise<CookoutOutcome>;
  photos(seq: number): Promise<PhotosResult>;
}

export interface CookedControlsDeps {
  readonly document: Document;
  readonly api: CookedApi;
  /** Runs a call that answers with a view, applying it; a lock becomes "unavailable" (and locks). */
  run(call: () => Promise<CookoutOutcome>): Promise<CookoutOutcome>;
  /** Runs a photos read; a lock becomes "unavailable" (and locks). */
  readPhotos(call: () => Promise<PhotosResult>): Promise<PhotosResult>;
  refetch(seq: number): void;
  /** Reads the round now (applying it) and answers with it, or null when it could not be read. */
  read(seq: number): Promise<CookoutView | null>;
  toast(text: string): void;
  /** Something this module draws changed: redraw the pane. */
  redraw(): void;
  /** Opens the round's mini-chat pop-up (where a new photo is sent). */
  openChat(seq: number): void;
  openLightbox(src: string, alt: string): void;
  afterChange(): void;
}

export interface CookedControls {
  /** The photo chooser overlay: put it in the pane. */
  readonly chooser: HTMLElement;
  /** The cooked corner of one banked recipe. */
  section(view: CookoutView, concept: Concept, slot: RecipeSlot, aiPicture: Picture | null): HTMLElement;
  /** This module's local state for one recipe, for the pane's redraw keys. */
  stateKey(generation: number, conceptId: ConceptId): string;
  /** Forget everything (a different round, a lock). */
  reset(): void;
}

/** The chooser's words when the photo it showed is no longer linkable (09a §9). */
export const PHOTO_CHANGED = "That photo changed - pick again";
/** A photo link refused because the dish was unmarked meanwhile (the partner, on another screen). */
export const NOT_COOKED_ANY_MORE = "That dish isn't marked as cooked any more.";

/** One dish's recipe slot in any of the round's dish sets. */
function slotOf(view: CookoutView, generation: number, conceptId: ConceptId): RecipeSlot | null {
  if (view.generation === generation) return view.recipes[conceptId];
  return view.generations.find((g) => g.generation === generation)?.recipes[conceptId] ?? null;
}

type Action = "cooked" | "rating" | "photo";

export function createCookedControls(deps: CookedControlsDeps): CookedControls {
  const doc = deps.document;

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
    const node = doc.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function glyph(className: string, text: string): HTMLElement {
    const span = el("span", className, text);
    span.setAttribute("aria-hidden", "true");
    return span;
  }

  function button(className: string, text: string, onClick: () => void, label?: string): HTMLButtonElement {
    const b = el("button", className, text);
    b.type = "button";
    if (label !== undefined) b.setAttribute("aria-label", label);
    b.setAttribute("data-srv-gesture-boundary", "");
    b.addEventListener("click", onClick);
    return b;
  }

  function recipeKey(generation: number, conceptId: ConceptId): string {
    return `${generation}:${conceptId}`;
  }

  const busy = new Set<string>();
  /** The recipe whose ⋯ menu is open, and whether its unmark confirmation is showing. */
  let menuFor: string | null = null;
  let confirmFor: string | null = null;
  /** Bumped on reset: an answer for an earlier round is dropped. */
  let epoch = 0;

  // -- The photo chooser -----------------------------------------------------------------------------------

  const chooser = el("div", "wx-srv-ck-photos");
  chooser.hidden = true;
  chooser.setAttribute("role", "dialog");
  chooser.setAttribute("aria-label", "Choose your photo");
  const chooserBackdrop = el("div", "wx-srv-ck-photos-backdrop");
  chooserBackdrop.setAttribute("data-srv-gesture-boundary", "");
  const chooserSheet = el("div", "wx-srv-ck-photos-sheet");
  const chooserTitle = el("p", "wx-srv-ck-photos-title");
  chooserTitle.append(glyph("wx-srv-ck-photos-icon", "📷"), doc.createTextNode("Our plate — pick a photo"));
  const chooserNote = el("p", "wx-srv-ck-photos-note");
  chooserNote.setAttribute("role", "status");
  const chooserGrid = el("div", "wx-srv-ck-photos-grid");
  const chooserActions = el("div", "wx-srv-ck-photos-actions");
  const sendNew = button("wx-srv-ck-photos-send", "", () => {
    const target = chooserTarget;
    closeChooser();
    if (target !== null) deps.openChat(target.seq);
  });
  sendNew.append(glyph("wx-srv-ck-photos-send-icon", "📨"), doc.createTextNode("Send a new photo to this game's chat"));
  const chooserCancel = button("wx-srv-ck-photos-cancel", "Cancel", () => closeChooser());
  chooserActions.append(sendNew, chooserCancel);
  chooserSheet.append(chooserTitle, chooserNote, chooserGrid, chooserActions);
  chooser.append(chooserBackdrop, chooserSheet);
  chooserBackdrop.addEventListener("click", () => closeChooser());

  let chooserTarget: { readonly seq: number; readonly generation: number; readonly conceptId: ConceptId; readonly title: string } | null = null;
  let chooserTicket = 0;

  function closeChooser(): void {
    chooserTicket += 1;
    chooserTarget = null;
    chooser.hidden = true;
    chooserGrid.replaceChildren();
    deps.afterChange();
  }

  function photoTile(photo: RoundPhoto): HTMLButtonElement {
    const tile = button("wx-srv-ck-photos-tile", "", () => void link(photo), `Use the photo ${photo.sender === "" ? "" : `from ${photo.sender}`}`.trim());
    tile.dataset["messageSeq"] = String(photo.messageSeq);
    tile.dataset["attachmentId"] = photo.attachmentId;
    const img = doc.createElement("img");
    img.className = "wx-srv-ck-photos-img";
    img.src = photo.picture.thumbUrl;
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    img.draggable = false;
    tile.append(img);
    if (photo.sender !== "") tile.append(el("span", "wx-srv-ck-photos-who", photo.sender));
    return tile;
  }

  async function openChooser(seq: number, generation: number, conceptId: ConceptId, title: string, note = ""): Promise<void> {
    const mine = ++chooserTicket;
    const started = epoch;
    chooserTarget = { seq, generation, conceptId, title };
    chooserGrid.replaceChildren();
    chooserNote.textContent = note !== "" ? note : "Loading this game's photos…";
    chooserNote.classList.toggle("wx-srv-ck-photos-note-warn", note !== "");
    chooser.hidden = false;
    chooserCancel.focus();
    deps.afterChange();
    const result = await deps.readPhotos(() => deps.api.photos(seq));
    if (mine !== chooserTicket || started !== epoch) return;
    if (!result.ok) {
      chooserNote.textContent = "Couldn't load this game's photos — try again.";
      chooserNote.classList.add("wx-srv-ck-photos-note-warn");
      deps.afterChange();
      return;
    }
    if (result.photos.length === 0) {
      chooserNote.textContent = note !== "" ? `${note}. No photos in this game's chat yet.` : "No photos in this game's chat yet — send one first.";
    } else if (note === "") {
      chooserNote.textContent = "Tap the photo of the dish you made.";
    }
    chooserGrid.replaceChildren(...result.photos.map(photoTile));
    deps.afterChange();
  }

  async function link(photo: RoundPhoto): Promise<void> {
    const target = chooserTarget;
    if (target === null) return;
    const key = `${recipeKey(target.generation, target.conceptId)}:photo`;
    if (busy.has(key)) return;
    const started = epoch;
    busy.add(key);
    closeChooser();
    deps.redraw();
    const outcome = await deps.run(() =>
      deps.api.linkPhoto(target.seq, target.generation, target.conceptId, photo.messageSeq, photo.attachmentId),
    );
    if (started !== epoch) return;
    busy.delete(key);
    if (!outcome.ok) {
      if (outcome.kind === "bad_state") {
        // The same 409 answers a photo that is no longer linkable AND a dish that is no longer cooked (the
        // partner unmarked it meanwhile): read the round to tell which. Only the first is "pick again".
        const fresh = await deps.read(target.seq);
        if (started !== epoch) return;
        const slot = fresh === null ? null : slotOf(fresh, target.generation, target.conceptId);
        if (fresh !== null && (slot === null || slot.state !== "banked" || slot.cooked === null)) {
          deps.toast(NOT_COOKED_ANY_MORE);
        } else {
          if (fresh === null) deps.refetch(target.seq);
          deps.toast(PHOTO_CHANGED);
          void openChooser(target.seq, target.generation, target.conceptId, target.title, PHOTO_CHANGED);
        }
      } else {
        deps.refetch(target.seq);
        deps.toast(outcome.kind === "unavailable" ? "Couldn't add that photo — try again." : "Couldn't add that photo.");
      }
    }
    deps.redraw();
  }

  // -- Actions -----------------------------------------------------------------------------------------------

  async function act(seq: number, slot: RecipeSlot, conceptId: ConceptId, action: Action, callFn: () => Promise<CookoutOutcome>, failed: string): Promise<void> {
    const key = `${recipeKey(slot.generation, conceptId)}:${action}`;
    if (busy.has(key)) return;
    const started = epoch;
    busy.add(key);
    deps.redraw();
    const outcome = await deps.run(callFn);
    if (started !== epoch) return;
    busy.delete(key);
    if (!outcome.ok) {
      deps.refetch(seq);
      deps.toast(outcome.kind === "unavailable" ? failed : "Somebody else changed this recipe — have another look.");
    }
    deps.redraw();
  }

  // -- Drawing ----------------------------------------------------------------------------------------------

  function hearts(seq: number, slot: RecipeSlot, conceptId: ConceptId, playerSlot: 1 | 2, who: string, editable: boolean): HTMLElement {
    const rating = slot.cooked?.ratings[playerSlot] ?? null;
    const row = el("div", "wx-srv-ck-hearts");
    row.dataset["slot"] = String(playerSlot);
    row.classList.toggle("wx-srv-ck-hearts-mine", editable);
    row.append(el("span", "wx-srv-ck-hearts-who", who));
    const list = el("span", "wx-srv-ck-hearts-list");
    list.setAttribute("role", editable ? "radiogroup" : "img");
    list.setAttribute("aria-label", rating === null ? `${who}: not rated yet` : `${who}: ${rating} of ${MAX_RATING} hearts`);
    const key = `${recipeKey(slot.generation, conceptId)}:rating`;
    for (let n = 1; n <= MAX_RATING; n += 1) {
      const full = rating !== null && n <= rating;
      if (editable) {
        // Tapping your current rating again clears it.
        const heart = button("wx-srv-ck-heart", full ? "♥" : "♡", () =>
          void act(seq, slot, conceptId, "rating", () => deps.api.rate(seq, slot.generation, conceptId, rating === n ? null : n), "Couldn't save your hearts — try again."),
        );
        heart.setAttribute("role", "radio");
        heart.setAttribute("aria-checked", rating === n ? "true" : "false");
        heart.setAttribute("aria-label", `${n} ${n === 1 ? "heart" : "hearts"}`);
        heart.classList.toggle("wx-srv-ck-heart-full", full);
        heart.disabled = busy.has(key);
        list.append(heart);
      } else {
        const heart = glyph("wx-srv-ck-heart", full ? "♥" : "♡");
        heart.classList.toggle("wx-srv-ck-heart-full", full);
        list.append(heart);
      }
    }
    row.append(list);
    if (!editable && rating === null) row.append(el("span", "wx-srv-ck-hearts-none", "not rated yet"));
    return row;
  }

  function pictureTile(caption: string, picture: Picture | null, alt: string, fallback: HTMLElement): HTMLElement {
    const tile = el("figure", "wx-srv-ck-plates-tile");
    if (picture !== null) {
      const open = button("wx-srv-ck-plates-open", "", () => deps.openLightbox(picture.fullUrl, alt), `See a bigger picture: ${alt}`);
      const img = doc.createElement("img");
      img.className = "wx-srv-ck-plates-img";
      img.src = picture.thumbUrl;
      img.alt = alt;
      img.loading = "lazy";
      img.decoding = "async";
      img.draggable = false;
      img.addEventListener("error", () => open.replaceWith(fallback));
      open.append(img);
      tile.append(open);
    } else {
      tile.append(fallback);
    }
    tile.append(el("figcaption", "wx-srv-ck-plates-caption", caption));
    return tile;
  }

  function section(view: CookoutView, concept: Concept, slot: RecipeSlot, aiPicture: Picture | null): HTMLElement {
    const seq = view.seq;
    const conceptId = concept.id;
    const key = recipeKey(slot.generation, conceptId);
    const box = el("section", "wx-srv-ck-cooked");
    box.dataset["generation"] = String(slot.generation);
    box.dataset["concept"] = conceptId;
    const player = view.you !== null;
    const cooked = slot.cooked;
    if (cooked === null) {
      if (!player) return box;
      const mark = button(
        "wx-srv-ck-cooked-mark",
        busy.has(`${key}:cooked`) ? "Saving…" : "",
        () => void act(seq, slot, conceptId, "cooked", () => deps.api.markCooked(seq, slot.generation, conceptId, true), "Couldn't mark it cooked — try again."),
        `We cooked ${concept.title}`,
      );
      if (!busy.has(`${key}:cooked`)) mark.append(glyph("wx-srv-ck-cooked-mark-icon", "👩‍🍳"), doc.createTextNode("We cooked it!"));
      mark.disabled = busy.has(`${key}:cooked`);
      box.append(mark);
      return box;
    }
    box.classList.add("wx-srv-ck-cooked-on");
    const head = el("div", "wx-srv-ck-cooked-head");
    head.append(el("span", "wx-srv-ck-cooked-badge", "✓ Cooked"));
    if (player) {
      const more = button("wx-srv-ck-cooked-more", "⋯", () => {
        menuFor = menuFor === key ? null : key;
        confirmFor = null;
        deps.redraw();
        deps.afterChange();
      }, "More for this cooked recipe");
      more.setAttribute("aria-expanded", menuFor === key ? "true" : "false");
      head.append(more);
    }
    box.append(head);
    if (player && menuFor === key) {
      const menu = el("div", "wx-srv-ck-cooked-menu");
      menu.setAttribute("role", "menu");
      if (confirmFor === key) {
        menu.classList.add("wx-srv-ck-cooked-confirm");
        menu.setAttribute("role", "alertdialog");
        menu.append(el("p", "wx-srv-ck-cooked-confirm-text", "Unmark as cooked? Your ratings and photo link will be removed."));
        const keep = button("wx-srv-ck-cooked-keep", "Keep it", () => {
          confirmFor = null;
          menuFor = null;
          deps.redraw();
        });
        const unmark = button("wx-srv-ck-cooked-unmark-yes", "Unmark", () => {
          confirmFor = null;
          menuFor = null;
          void act(seq, slot, conceptId, "cooked", () => deps.api.markCooked(seq, slot.generation, conceptId, false), "Couldn't unmark it — try again.");
        });
        menu.append(keep, unmark);
      } else {
        if (cooked.photo !== null || cooked.photoMessageSeq !== null) {
          const remove = button("wx-srv-ck-cooked-menu-item", "Remove our photo", () => {
            menuFor = null;
            void act(seq, slot, conceptId, "photo", () => deps.api.linkPhoto(seq, slot.generation, conceptId, null, null), "Couldn't remove the photo — try again.");
          });
          remove.setAttribute("role", "menuitem");
          menu.append(remove);
        }
        const unmarkItem = button("wx-srv-ck-cooked-menu-item wx-srv-ck-cooked-unmark", "Unmark as cooked", () => {
          confirmFor = key;
          deps.redraw();
        });
        unmarkItem.setAttribute("role", "menuitem");
        menu.append(unmarkItem);
      }
      box.append(menu);
    }
    const you = view.you?.slot ?? null;
    const order: Array<1 | 2> = you === 2 ? [2, 1] : [1, 2];
    const ratings = el("div", "wx-srv-ck-ratings");
    for (const s of order) {
      const who = s === you ? "You" : (view.players[s - 1]?.name ?? (s === 1 ? "Player 1" : "Player 2"));
      ratings.append(hearts(seq, slot, conceptId, s, who, s === you));
    }
    box.append(ratings);

    const plates = el("div", "wx-srv-ck-plates");
    const dream = el("span", "wx-srv-ck-plates-empty", "🍽️");
    dream.setAttribute("aria-hidden", "true");
    plates.append(pictureTile("Chef's daydream", aiPicture, concept.title, dream));
    const photoBusy = busy.has(`${key}:photo`);
    let ours: HTMLElement;
    if (player) {
      ours = button(
        "wx-srv-ck-plates-add",
        "",
        () => void openChooser(seq, slot.generation, conceptId, concept.title),
        cooked.photo === null ? "Add our photo" : "Change our photo",
      );
      ours.append(glyph("wx-srv-ck-plates-add-icon", photoBusy ? "⏳" : "📷"), el("span", "wx-srv-ck-plates-add-text", photoBusy ? "Adding…" : "Add our photo"));
      (ours as HTMLButtonElement).disabled = photoBusy;
    } else {
      ours = el("span", "wx-srv-ck-plates-empty", "📷");
      ours.setAttribute("aria-hidden", "true");
    }
    const ourTile = pictureTile("Our plate", cooked.photo, `Our plate: ${concept.title}`, ours);
    if (player && cooked.photo !== null) {
      const change = button("wx-srv-ck-plates-change", photoBusy ? "Adding…" : "Change photo", () => void openChooser(seq, slot.generation, conceptId, concept.title));
      change.disabled = photoBusy;
      ourTile.append(change);
    }
    plates.append(ourTile);
    box.append(plates);
    return box;
  }

  return {
    chooser,
    section,
    stateKey(generation, conceptId) {
      const key = recipeKey(generation, conceptId);
      return JSON.stringify([
        busy.has(`${key}:cooked`),
        busy.has(`${key}:rating`),
        busy.has(`${key}:photo`),
        menuFor === key,
        confirmFor === key,
      ]);
    },
    reset() {
      epoch += 1;
      busy.clear();
      menuFor = null;
      confirmFor = null;
      chooserTicket += 1;
      chooserTarget = null;
      chooser.hidden = true;
      chooserGrid.replaceChildren();
    },
  };
}
