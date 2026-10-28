// The holiday pack panel of the Adventure Time pane (spec/server-chat/08-adventure-time.md §5.3, §4.3a):
// headline, summary, a swipeable hero carousel of the place's photographs, the sections as cards with
// links and a photo on each item that has one, best time, getting there, travel advice and sources;
// or, when the research did not produce a pack, the plain reason and a Try again button. A tap on any
// picture opens a full-screen viewer with its credit.
//
// Everything user-visible is set via `textContent` (the pack is model-written text); a link is only ever
// built from a URL `api.ts` already vetted as http(s) (`target=_blank rel="noopener noreferrer"`), and a
// picture only from a URL on THIS origin — the server fetched every picture itself, so the browser never
// contacts a third-party image host from a private chat. While the server is still finding pictures
// (`images: "pending"`) placeholders hold their places; a pack without pictures lays out as plain text.
//
// "Local food to try" (spec §4.3b, the operator's "food is essential"): the pack's `dishes` section is shown
// straight after the summary as a photo-forward grid, a square photo with the dish's name and one line of what
// it is (two columns on a phone, three on a desktop). A dish with no photo gets a tasteful text tile in the same
// grid (a wrong photo is worse than none, so the server leaves a dish text-only when nothing qualifies); while the
// server is still finding photos a dish without one shows a shimmer. A tap opens the full-screen viewer on that
// dish: the photo, its credit and the dish's whole description, swiping through every dish of the pack.
//
// The panel redraws only when what it shows changed (its `key`), so scrolling, a half-swiped carousel
// and an open viewer survive the frequent view refreshes of a busy round.

import { DISHES_SECTION, pictureKey, type AdventureDest, type PackItem, type PackPicture, type PackSection, type PackView } from "./api";

/** What the full-screen viewer shows: a photo (or, for a dish with none, a text tile) and its words. */
interface ViewerEntry {
  readonly picture: PackPicture | null;
  readonly title: string;
  readonly detail: string;
}

/** The section key of the dishes and the title it is shown under. */
export const DISHES_KEY = DISHES_SECTION;
export const DISHES_TITLE = "Local food to try";
/** The `food` section is the PLACES to eat (the dishes have their own section now). */
export const FOOD_TITLE = "Where to eat";

export interface PackPanelInput {
  readonly seq: number;
  readonly place: AdventureDest;
  readonly unitName: string;
  readonly pack: PackView;
}

export interface PackPanelDeps {
  readonly document: Document;
  /** "Try again" after a failed (or unavailable) pack. */
  retry(): void;
  /** A retry is in flight: the button waits. */
  retrying(): boolean;
}

export interface PackPanel {
  /** The panel's content: put it in the pane's scrolling pack host. */
  readonly element: HTMLElement;
  /** The full-screen picture viewer: put it over the pane. */
  readonly viewer: HTMLElement;
  render(input: PackPanelInput): void;
  isViewerOpen(): boolean;
  closeViewer(): void;
  /** Forget everything shown (the round changed, the chat locked). */
  reset(): void;
}

const SWIPE_MIN_PX = 48;
const PENDING_HERO_SLIDES = 3;

export function createPackPanel(deps: PackPanelDeps): PackPanel {
  const doc = deps.document;

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
    const node = doc.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(className: string, label: string, text: string, onClick: () => void): HTMLButtonElement {
    const b = el("button", className, text);
    b.type = "button";
    b.setAttribute("aria-label", label);
    b.setAttribute("data-srv-gesture-boundary", "");
    b.addEventListener("click", onClick);
    return b;
  }

  function link(url: string | null, label: string, className = "wx-srv-adv-pk-link"): HTMLAnchorElement | null {
    if (url === null) return null;
    const a = el("a", className, label);
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.setAttribute("data-srv-gesture-boundary", "");
    return a;
  }

  const root = el("div", "wx-srv-adv-pk");

  // -- The picture viewer ------------------------------------------------------------------------

  const viewer = el("div", "wx-srv-adv-viewer");
  viewer.hidden = true;
  viewer.setAttribute("role", "dialog");
  viewer.setAttribute("aria-modal", "true");
  viewer.setAttribute("aria-label", "Photo");
  const viewerImg = doc.createElement("img");
  viewerImg.className = "wx-srv-adv-viewer-img";
  viewerImg.alt = "";
  // A dish with no photo opens on this tile instead (its words are below, as for every entry).
  const viewerTile = el("div", "wx-srv-adv-viewer-tile");
  viewerTile.hidden = true;
  const viewerTileGlyph = el("span", "wx-srv-adv-viewer-tile-glyph", "🍽");
  viewerTileGlyph.setAttribute("aria-hidden", "true");
  viewerTile.append(viewerTileGlyph);
  const viewerCredit = el("div", "wx-srv-adv-viewer-credit");
  const viewerCount = el("span", "wx-srv-adv-viewer-count");
  const viewerClose = button("wx-srv-adv-viewer-close", "Close the photo", "✕", () => closeViewer());
  const viewerPrev = button("wx-srv-adv-viewer-prev", "Previous photo", "‹", () => step(-1));
  const viewerNext = button("wx-srv-adv-viewer-next", "Next photo", "›", () => step(1));
  const viewerStage = el("div", "wx-srv-adv-viewer-stage");
  viewerStage.setAttribute("data-srv-gesture-boundary", "");
  viewerStage.append(viewerImg, viewerTile);
  viewer.append(viewerStage, viewerClose, viewerPrev, viewerNext, viewerCount, viewerCredit);
  // Tapping the dark around the picture closes it; a swipe goes to the next one. (Escape is deliberately
  // NOT a way to close it: in this chat Escape is the panic key and locks everything.)
  let swipeStartX: number | null = null;
  viewerStage.addEventListener("pointerdown", (event) => {
    swipeStartX = event.clientX;
  });
  viewerStage.addEventListener("pointerup", (event) => {
    const start = swipeStartX;
    swipeStartX = null;
    if (start === null) return;
    const dx = event.clientX - start;
    if (Math.abs(dx) >= SWIPE_MIN_PX) step(dx < 0 ? 1 : -1);
    else if (event.target === viewerStage) closeViewer();
  });
  viewerStage.addEventListener("pointercancel", () => {
    swipeStartX = null;
  });

  let gallery: readonly ViewerEntry[] = [];
  let galleryIndex = 0;

  function showViewerPicture(): void {
    const entry = gallery[galleryIndex];
    if (entry === undefined) {
      closeViewer();
      return;
    }
    const picture = entry.picture;
    if (picture !== null) {
      if (viewerImg.getAttribute("src") !== picture.fullUrl) viewerImg.src = picture.fullUrl;
      viewerImg.alt = entry.title;
    } else {
      viewerImg.removeAttribute("src");
      viewerImg.alt = "";
    }
    viewerImg.hidden = picture === null;
    viewerTile.hidden = picture !== null;
    viewerCredit.replaceChildren();
    if (entry.title !== "") viewerCredit.append(el("div", "wx-srv-adv-viewer-caption", entry.title));
    if (entry.detail !== "") viewerCredit.append(el("div", "wx-srv-adv-viewer-detail", entry.detail));
    if (picture !== null && picture.credit !== "") {
      const credit = el("div", "wx-srv-adv-viewer-credit-line");
      const text = el("span", "", `Photo: ${picture.credit}`);
      const a = link(picture.page, "Source", "wx-srv-adv-viewer-source");
      credit.append(text);
      if (a !== null) credit.append(doc.createTextNode(" · "), a);
      viewerCredit.append(credit);
    }
    viewerCount.textContent = gallery.length > 1 ? `${galleryIndex + 1} / ${gallery.length}` : "";
    viewerPrev.hidden = gallery.length < 2;
    viewerNext.hidden = gallery.length < 2;
  }

  function openViewer(entries: readonly ViewerEntry[], index: number): void {
    if (entries.length === 0) return;
    gallery = entries;
    galleryIndex = Math.max(0, Math.min(entries.length - 1, index));
    viewer.hidden = false;
    showViewerPicture();
    viewerClose.focus();
  }

  function step(direction: 1 | -1): void {
    if (gallery.length < 2) return;
    galleryIndex = (galleryIndex + direction + gallery.length) % gallery.length;
    showViewerPicture();
  }

  function closeViewer(): void {
    if (viewer.hidden) return;
    viewer.hidden = true;
    viewerImg.removeAttribute("src");
    gallery = [];
    galleryIndex = 0;
  }

  // -- The pack ------------------------------------------------------------------------------------

  /** A picture as a tappable image that opens the viewer; a broken one removes itself. */
  function pictureButton(className: string, picture: PackPicture, alt: string, open: () => void, eager: boolean): HTMLButtonElement {
    const b = el("button", className);
    b.type = "button";
    b.setAttribute("aria-label", `Open the photo: ${alt}`);
    b.setAttribute("data-srv-gesture-boundary", "");
    const img = doc.createElement("img");
    img.src = picture.thumbUrl;
    img.alt = alt;
    img.loading = eager ? "eager" : "lazy";
    img.decoding = "async";
    img.draggable = false;
    img.addEventListener("error", () => {
      b.hidden = true;
      b.classList.add("wx-srv-adv-pic-broken");
    });
    b.append(img);
    b.addEventListener("click", open);
    return b;
  }

  function heroCarousel(place: AdventureDest, pack: PackView): HTMLElement | null {
    const pictures = pack.pictures?.hero ?? [];
    const entries: ViewerEntry[] = pictures.map((p) => ({ picture: p, title: p.caption, detail: "" }));
    const waiting = pack.images === "pending";
    if (pictures.length === 0 && !waiting) return null;
    const wrap = el("div", "wx-srv-adv-hero");
    wrap.setAttribute("role", "region");
    wrap.setAttribute("aria-label", `Photos of ${place.name}`);
    const track = el("div", "wx-srv-adv-hero-track");
    pictures.forEach((picture, index) => {
      const slide = el("figure", "wx-srv-adv-hero-slide");
      slide.append(
        pictureButton("wx-srv-adv-hero-pic", picture, picture.caption !== "" ? picture.caption : place.name, () => openViewer(entries, index), index === 0),
      );
      const cap = el("figcaption", "wx-srv-adv-hero-credit");
      if (picture.credit !== "") {
        cap.append(doc.createTextNode(`Photo: ${picture.credit}`));
        const a = link(picture.page, "Source");
        if (a !== null) cap.append(doc.createTextNode(" · "), a);
      }
      if (cap.childNodes.length > 0) slide.append(cap);
      track.append(slide);
    });
    if (waiting) {
      const missing = Math.max(1, PENDING_HERO_SLIDES - pictures.length);
      for (let i = 0; i < missing; i += 1) {
        const slide = el("div", "wx-srv-adv-hero-slide wx-srv-adv-pic-pending");
        slide.append(el("span", "wx-srv-adv-pic-note", i === 0 ? "Finding photos…" : ""));
        track.append(slide);
      }
    }
    wrap.append(track);
    const total = track.children.length;
    if (total > 1) {
      const dots = el("div", "wx-srv-adv-hero-dots");
      dots.setAttribute("aria-hidden", "true");
      for (let i = 0; i < total; i += 1) dots.append(el("span", i === 0 ? "wx-srv-adv-hero-dot wx-srv-adv-hero-dot-on" : "wx-srv-adv-hero-dot"));
      wrap.append(dots);
      track.addEventListener(
        "scroll",
        () => {
          const width = track.clientWidth;
          if (width <= 0) return;
          const index = Math.round(track.scrollLeft / width);
          [...dots.children].forEach((dot, i) => dot.classList.toggle("wx-srv-adv-hero-dot-on", i === index));
        },
        { passive: true },
      );
    }
    return wrap;
  }

  function itemList(section: PackSection, pack: PackView, allPictures: ViewerEntry[]): HTMLElement {
    const list = el("ul", "wx-srv-adv-pk-items");
    const waiting = pack.images === "pending";
    for (const item of section.items) {
      const li = el("li", "wx-srv-adv-pk-item");
      const picture = pack.pictures?.items.get(pictureKey(section, item)) ?? null;
      if (picture !== null) {
        const index = allPictures.length;
        allPictures.push({ picture, title: picture.caption !== "" ? picture.caption : item.name, detail: "" });
        li.classList.add("wx-srv-adv-pk-item-pic");
        li.append(pictureButton("wx-srv-adv-pk-thumb", picture, item.name, () => openViewer(allPictures, index), false));
      } else if (waiting) {
        li.classList.add("wx-srv-adv-pk-item-pic");
        li.append(el("span", "wx-srv-adv-pk-thumb wx-srv-adv-pic-pending"));
      }
      const body = el("div", "wx-srv-adv-pk-item-body");
      body.append(el("div", "wx-srv-adv-pk-item-name", item.name));
      if (item.detail !== "") body.append(el("div", "wx-srv-adv-pk-item-detail", item.detail));
      const a = link(item.url, "Open link");
      if (a !== null) body.append(a);
      if (picture !== null && picture.credit !== "") {
        const credit = el("div", "wx-srv-adv-pk-credit");
        credit.append(doc.createTextNode(`Photo: ${picture.credit}`));
        const src = link(picture.page, "Source");
        if (src !== null) credit.append(doc.createTextNode(" · "), src);
        body.append(credit);
      }
      li.append(body);
      list.append(li);
    }
    return list;
  }

  /** One dish of the "Local food to try" grid: a square photo (or a text tile), its name, one line of detail. */
  function dishTile(item: PackItem, picture: PackPicture | null, waiting: boolean, open: () => void): HTMLElement {
    const b = el("button", "wx-srv-adv-dish");
    b.type = "button";
    b.setAttribute("data-srv-gesture-boundary", "");
    b.dataset["dish"] = String(item.index);
    b.setAttribute("aria-label", `${item.name}: open the photo and the description`);
    const frame = el("span", "wx-srv-adv-dish-frame");
    const tile = (): void => {
      frame.className = "wx-srv-adv-dish-frame wx-srv-adv-dish-text";
      frame.replaceChildren();
      const glyph = el("span", "wx-srv-adv-dish-glyph", "🍽");
      glyph.setAttribute("aria-hidden", "true");
      frame.append(glyph);
      if (item.detail !== "") frame.append(el("span", "wx-srv-adv-dish-blurb", item.detail));
      b.classList.add("wx-srv-adv-dish-nophoto");
    };
    if (picture !== null) {
      const img = doc.createElement("img");
      img.src = picture.thumbUrl;
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.draggable = false;
      // A photo that will not load becomes the text tile rather than a hole.
      img.addEventListener("error", tile);
      frame.append(img);
    } else if (waiting) {
      frame.classList.add("wx-srv-adv-pic-pending");
      b.classList.add("wx-srv-adv-dish-pending");
    } else {
      tile();
    }
    b.append(frame, el("span", "wx-srv-adv-dish-name", item.name));
    if (item.detail !== "") b.append(el("span", "wx-srv-adv-dish-detail", item.detail));
    b.addEventListener("click", open);
    return b;
  }

  /** The "Local food to try" section as a photo-forward grid. */
  function dishesGrid(section: PackSection, pack: PackView): HTMLElement {
    const waiting = pack.images === "pending";
    const wrap = el("section", "wx-srv-adv-dishes");
    wrap.append(el("h3", "wx-srv-adv-pk-title", section.title !== "" ? section.title : DISHES_TITLE));
    const entries: ViewerEntry[] = section.items.map((item) => ({
      picture: pack.pictures?.items.get(pictureKey(section, item)) ?? null,
      title: item.name,
      detail: item.detail,
    }));
    const grid = el("div", "wx-srv-adv-dish-grid");
    section.items.forEach((item, position) => {
      grid.append(dishTile(item, entries[position]?.picture ?? null, waiting, () => openViewer(entries, position)));
    });
    wrap.append(grid);
    return wrap;
  }

  function message(text: string, withRetry: boolean): HTMLElement {
    const card = el("section", "wx-srv-adv-pk-card wx-srv-adv-pk-message");
    card.append(el("p", "wx-srv-adv-pk-message-text", text));
    if (withRetry) {
      const retry = button("wx-srv-adv-pk-retry wx-srv-adv-big wx-srv-adv-big-yes", "Try the holiday pack again", "Try again", () => deps.retry());
      retry.disabled = deps.retrying();
      card.append(retry);
    }
    return card;
  }

  function renderPack(input: PackPanelInput): HTMLElement {
    const { place, unitName, pack } = input;
    const content = el("div", "wx-srv-adv-pk-content");
    const data = pack.data;
    if (pack.state === "failed") {
      content.append(message(pack.error ?? "The research didn't finish. Try again.", pack.canRetry));
      return content;
    }
    if (pack.state === "unavailable") {
      content.append(
        message("Holiday packs aren't available on this server. You can still bank this place or pass on it.", pack.canRetry),
      );
      return content;
    }
    if (pack.state !== "ready") return content;
    if (data === null) {
      content.append(message("The holiday pack couldn't be read.", false));
      return content;
    }
    const allPictures: ViewerEntry[] = [];
    const hero = heroCarousel(place, pack);
    if (hero !== null) content.append(hero);
    content.append(el("div", "wx-srv-adv-pk-place", [place.name, unitName].filter((s) => s !== "").join(", ")));
    if (data.headline !== "") content.append(el("h2", "wx-srv-adv-pk-headline", data.headline));
    if (data.summary !== "") content.append(el("p", "wx-srv-adv-pk-summary", data.summary));
    // The dishes come straight after the summary, whichever place the section holds in the list.
    const dishes = data.sections.find((section) => section.key === DISHES_KEY);
    if (dishes !== undefined) content.append(dishesGrid(dishes, pack));
    for (const section of data.sections) {
      if (section.key === DISHES_KEY) continue;
      const safeKey = section.key.replace(/[^a-z0-9_-]/gi, "").slice(0, 16);
      const card = el("section", `wx-srv-adv-pk-card wx-srv-adv-pk-${safeKey}`);
      // The food section is the PLACES to eat; the dishes have their own section above.
      const title = section.key === "food" ? FOOD_TITLE : section.title;
      card.append(el("h3", "wx-srv-adv-pk-title", title), itemList(section, pack, allPictures));
      content.append(card);
    }
    const facts: ReadonlyArray<readonly [string, string]> = [
      ["Best time to go", data.bestTime],
      ["Getting there", data.gettingThere],
      ["Travel advice", data.travelAdvice],
    ];
    for (const [title, text] of facts) {
      if (text === "") continue;
      const card = el("section", "wx-srv-adv-pk-card wx-srv-adv-pk-fact");
      card.append(el("h3", "wx-srv-adv-pk-title", title), el("p", "wx-srv-adv-pk-fact-text", text));
      content.append(card);
    }
    if (data.sources.length > 0) {
      const card = el("section", "wx-srv-adv-pk-card wx-srv-adv-pk-sources");
      card.append(el("h3", "wx-srv-adv-pk-title", "Sources"));
      const list = el("ul", "wx-srv-adv-pk-source-list");
      for (const source of data.sources) {
        const li = el("li", "wx-srv-adv-pk-source");
        const a = link(source.url, source.title);
        if (a !== null) li.append(a);
        list.append(li);
      }
      card.append(list);
      content.append(card);
    }
    return content;
  }

  /** What the panel's content depends on: equal keys mean nothing visible would change. */
  function keyOf(input: PackPanelInput): string {
    const { pack } = input;
    const pictures = pack.pictures;
    const heroKey = pictures === null ? "" : pictures.hero.map((p) => p.thumbUrl).join(",");
    const itemKey = pictures === null ? "" : [...pictures.items].map(([k, p]) => `${k}=${p.thumbUrl}`).join(",");
    return [
      input.seq,
      pack.state,
      pack.images,
      pack.canRetry,
      pack.error ?? "",
      deps.retrying(),
      pack.data?.headline ?? "",
      pack.data?.sections.length ?? 0,
      heroKey,
      itemKey,
    ].join("|");
  }

  let drawnKey = "";

  return {
    element: root,
    viewer,
    render(input) {
      const key = keyOf(input);
      if (key === drawnKey) return;
      const sameRound = drawnKey.startsWith(`${input.seq}|`);
      drawnKey = key;
      root.replaceChildren(renderPack(input));
      // A rebuild of the same round (more pictures arriving) leaves an open viewer alone: it holds its
      // own list of pictures, which stay valid.
      if (!sameRound) closeViewer();
    },
    isViewerOpen: () => !viewer.hidden,
    closeViewer,
    reset() {
      drawnKey = "";
      root.replaceChildren();
      closeViewer();
    },
  };
}
