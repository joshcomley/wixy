// Adventure Time preview — the holiday pack as a magazine page: a swipeable hero carousel of the place,
// then the headline and summary, then a card per section whose items carry a photo where one exists
// (and lay out cleanly where it does not), with a full-screen viewer behind every photo. All text goes in
// through textContent and every link is http(s) only; photos are `<img>`s of data: URIs in the preview.

import type { Dest, Pack, PackItem, PackPhoto } from "./data";
import { h } from "./ui";

/** Section titles the client sets itself, whatever the pack says (spec 4.3b: the old food section is "Where to eat"). */
const SECTION_TITLE: Readonly<Record<string, string>> = { dishes: "Local food to try", food: "Where to eat" };

const SECTION_ICON: Readonly<Record<string, string>> = {
  dishes: "\uD83E\uDD58",
  food: "🍽️",
  stay: "🏡",
  culture: "🎭",
  sights: "📍",
  do: "🎯",
  practical: "🧳",
};

function safeUrl(url: string | null): string | null {
  if (url === null || url === "") return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function link(url: string | null, label: string, cls = "pk-link"): HTMLElement | null {
  const href = safeUrl(url);
  return href === null ? null : h("a", { class: cls, href, target: "_blank", rel: "noopener noreferrer" }, label);
}

// -- The full-screen viewer --------------------------------------------------------------------------

export interface Viewer {
  open(gallery: readonly PackPhoto[], index: number): void;
  close(): void;
}

let viewerSingleton: Viewer | null = null;

export function getViewer(): Viewer {
  if (viewerSingleton !== null) return viewerSingleton;
  const track = h("div", { class: "viewer-track" });
  const count = h("span", { class: "viewer-count" });
  const credit = h("span", { class: "viewer-credit" });
  const closeBtn = h("button", { class: "viewer-close", type: "button", "aria-label": "Close photo" }, "✕");
  const root = h(
    "div",
    { class: "viewer", role: "dialog", "aria-modal": "true", "aria-label": "Photo", hidden: "" },
    track,
    closeBtn,
    h("div", { class: "viewer-bar" }, count, credit),
  );
  document.body.append(root);

  let gallery: readonly PackPhoto[] = [];
  let shown = -1;
  let frame = 0;

  function showCaption(index: number): void {
    if (index === shown) return;
    shown = index;
    const photo = gallery[index];
    count.textContent = gallery.length > 1 ? `${index + 1} / ${gallery.length}` : "";
    credit.replaceChildren();
    if (photo === undefined) return;
    if (photo.credit === "") return;
    const label = photo.credit;
    const anchor = link(photo.creditUrl, label, "viewer-link");
    credit.append(anchor ?? label);
  }

  track.addEventListener(
    "scroll",
    () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        showCaption(Math.round(track.scrollLeft / Math.max(1, track.clientWidth)));
      });
    },
    { passive: true },
  );

  const close = (): void => {
    root.hidden = true;
    track.replaceChildren();
    gallery = [];
    shown = -1;
  };
  closeBtn.addEventListener("click", close);
  track.addEventListener("click", (e) => {
    // A tap on the dark margin closes; a tap on the photo itself does not.
    if (!(e.target instanceof HTMLImageElement)) close();
  });
  document.addEventListener("keydown", (e) => {
    if (root.hidden) return;
    if (e.key === "Escape") close();
    else if (e.key === "ArrowRight") track.scrollBy({ left: track.clientWidth, behavior: "smooth" });
    else if (e.key === "ArrowLeft") track.scrollBy({ left: -track.clientWidth, behavior: "smooth" });
  });

  viewerSingleton = {
    open(photos, index) {
      gallery = photos;
      track.replaceChildren(
        ...photos.map((p) => h("figure", { class: "viewer-slide" }, h("img", { src: p.src, alt: p.alt, decoding: "async", draggable: "false" }))),
      );
      root.hidden = false;
      shown = -1;
      // Jump to the tapped photo once the track has its width.
      window.requestAnimationFrame(() => {
        track.style.scrollBehavior = "auto";
        track.scrollLeft = index * track.clientWidth;
        track.style.scrollBehavior = "";
        showCaption(index);
      });
      closeBtn.focus({ preventScroll: true });
    },
    close,
  };
  return viewerSingleton;
}

// -- The pack ----------------------------------------------------------------------------------------

function photoButton(photo: PackPhoto, gallery: readonly PackPhoto[], className: string, showCredit = true): HTMLButtonElement {
  const index = gallery.indexOf(photo);
  const img = h("img", { src: photo.src, alt: photo.alt, loading: "lazy", decoding: "async", draggable: "false" });
  // A photo that fails to load simply disappears, leaving the text (the layout never depends on it).
  img.addEventListener("error", () => button.classList.add("pk-photo-failed"));
  const button = h(
    "button",
    { class: className, type: "button", "aria-label": `Open photo: ${photo.alt}` },
    img,
    photo.credit === "" || !showCredit ? null : h("span", { class: "pk-credit" }, photo.credit),
  );
  button.addEventListener("click", () => getViewer().open(gallery, Math.max(0, index)));
  return button;
}

function hero(pack: Pack, dest: Dest, unitName: string, gallery: readonly PackPhoto[]): HTMLElement | null {
  if (pack.hero.length === 0) return null;
  const track = h("div", { class: "hero-track" });
  for (const photo of pack.hero) track.append(photoButton(photo, gallery, "hero-slide"));
  const dots = h("div", { class: "hero-dots", "aria-hidden": "true" });
  const dotEls = pack.hero.map(() => h("span", { class: "hero-dot" }));
  dots.append(...dotEls);
  const setDot = (i: number): void => dotEls.forEach((d, k) => d.classList.toggle("on", k === i));
  setDot(0);
  let frame = 0;
  track.addEventListener(
    "scroll",
    () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        setDot(Math.round(track.scrollLeft / Math.max(1, track.clientWidth)));
      });
    },
    { passive: true },
  );
  return h(
    "div",
    { class: "hero" },
    track,
    h("div", { class: "hero-title" }, h("div", { class: "hero-name" }, dest.name), h("div", { class: "hero-where" }, `${dest.region}, ${unitName}`)),
    pack.hero.length > 1 ? dots : null,
  );
}

// -- Local food to try --------------------------------------------------------------------------------

/** The first sentence of a dish's detail: the one line a grid card shows (the rest is one tap away). */
export function firstSentence(text: string): string {
  const match = /^(.+?[.!?])(\s|$)/.exec(text.trim());
  return match?.[1] ?? text.trim();
}

/** A stable warm tint for a dish's text card, from its name (so a text-only dish still looks chosen, not broken). */
export function tintFor(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return 8 + (hash % 5) * 9; // hues 8..44: terracotta, saffron, amber, olive-gold
}

export function wikipediaUrl(title: string | null): string | null {
  if (title === null || title.trim() === "") return null;
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.trim().replaceAll(" ", "_"))}`;
}

interface DishSheet {
  open(item: PackItem, gallery: readonly PackPhoto[]): void;
  close(): void;
}

let dishSheetSingleton: DishSheet | null = null;

function getDishSheet(): DishSheet {
  if (dishSheetSingleton !== null) return dishSheetSingleton;
  const photoHost = h("div", { class: "dish-sheet-photo-host" });
  const kicker = h("div", { class: "dish-sheet-kicker" }, "Local food to try");
  const name = h("h2", { class: "dish-sheet-name" });
  const detail = h("p", { class: "dish-sheet-detail" });
  const credit = h("div", { class: "dish-sheet-credit" });
  const wiki = h("div", { class: "dish-sheet-wiki" });
  const closeBtn = h("button", { class: "dish-sheet-close", type: "button", "aria-label": "Close" }, "\u2715");
  const card = h("div", { class: "dish-sheet-card" }, closeBtn, photoHost, h("div", { class: "dish-sheet-body" }, kicker, name, detail, wiki, credit));
  const root = h("div", { class: "dish-sheet", role: "dialog", "aria-modal": "true", "aria-label": "Dish", hidden: "" }, card);
  document.body.append(root);
  const close = (): void => {
    root.hidden = true;
  };
  closeBtn.addEventListener("click", close);
  root.addEventListener("pointerdown", (e) => {
    if (e.target === root) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || root.hidden) return;
    if (document.querySelector(".viewer:not([hidden])") !== null) return; // the photo viewer on top closes first
    close();
  });
  dishSheetSingleton = {
    open(item, gallery) {
      photoHost.replaceChildren();
      photoHost.hidden = item.photo === null;
      if (item.photo !== null) photoHost.append(photoButton(item.photo, gallery, "dish-sheet-photo", false));
      name.textContent = item.name;
      detail.textContent = item.detail;
      credit.replaceChildren();
      if (item.photo !== null && item.photo.credit !== "") {
        const label = `Photo: ${item.photo.credit}`;
        credit.append(link(item.photo.creditUrl, label, "pk-link") ?? label);
      }
      wiki.replaceChildren();
      const wikiLink = link(wikipediaUrl(item.wikipedia), "Read about it on Wikipedia");
      if (wikiLink !== null) wiki.append(wikiLink);
      card.scrollTop = 0;
      root.hidden = false;
      closeBtn.focus({ preventScroll: true });
    },
    close,
  };
  return dishSheetSingleton;
}

function dishCard(item: PackItem, gallery: readonly PackPhoto[]): HTMLElement {
  const sentence = firstSentence(item.detail);
  const card = h("button", { class: item.photo === null ? "dish-card dish-text" : "dish-card dish-has-photo", type: "button" });
  if (item.photo !== null) {
    const img = h("img", { src: item.photo.src, alt: item.photo.alt, loading: "lazy", decoding: "async", draggable: "false" });
    const frame = h("span", { class: "dish-photo" }, img);
    // A photo that cannot load turns the card into the text card (the grid never has a hole in it).
    img.addEventListener("error", () => {
      card.classList.remove("dish-has-photo");
      card.classList.add("dish-text");
      card.style.setProperty("--dish-hue", String(tintFor(item.name)));
      frame.remove();
    });
    card.append(frame, h("span", { class: "dish-name" }, item.name), h("span", { class: "dish-line" }, sentence));
  } else {
    card.style.setProperty("--dish-hue", String(tintFor(item.name)));
    card.append(h("span", { class: "dish-glyph", "aria-hidden": "true" }, "\uD83C\uDF74"), h("span", { class: "dish-name" }, item.name), h("span", { class: "dish-line" }, sentence));
  }
  card.addEventListener("click", () => getDishSheet().open(item, gallery));
  return card;
}

function dishesSection(items: readonly PackItem[], gallery: readonly PackPhoto[]): HTMLElement {
  const grid = h("div", { class: "dish-grid" });
  for (const item of items) grid.append(dishCard(item, gallery));
  return h(
    "section",
    { class: "pk-dishes" },
    h("h3", { class: "pk-dishes-title" }, h("span", { class: "pk-icon", "aria-hidden": "true" }, SECTION_ICON["dishes"] ?? ""), SECTION_TITLE["dishes"] ?? "Local food to try"),
    h("p", { class: "pk-dishes-sub" }, "Dishes and drinks the area is known for. Tap one for the full story and the photo credit."),
    grid,
  );
}

export function renderPack(pack: Pack, dest: Dest, unitName: string, isSample: boolean): HTMLElement {
  const gallery: PackPhoto[] = [...pack.hero];
  for (const section of pack.sections) for (const item of section.items) if (item.photo !== null) gallery.push(item.photo);

  const root = h("div", { class: "pk" });
  const heroEl = hero(pack, dest, unitName, gallery);
  if (heroEl !== null) root.append(heroEl);
  const body = h("div", { class: "pk-body" });
  root.append(body);
  if (isSample) {
    body.append(
      h(
        "div",
        { class: "pk-sample" },
        "Sample pack. The real game researches the place you land on; this one is the example for ",
        h("b", null, "Kotor"),
        ".",
      ),
    );
  }
  if (heroEl === null) body.append(h("div", { class: "pk-place" }, `${dest.name}, ${unitName}`));
  body.append(h("h2", { class: "pk-headline" }, pack.headline), h("p", { class: "pk-summary" }, pack.summary));

  // "Local food to try" sits straight after the hero and the summary, whatever order the pack lists it in.
  const dishes = pack.sections.find((section) => section.key === "dishes" && section.items.length > 0);
  if (dishes !== undefined) body.append(dishesSection(dishes.items, gallery));

  for (const section of pack.sections) {
    if (section.key === "dishes") continue;
    const card = h(
      "section",
      { class: `pk-card pk-${section.key}` },
      h("h3", null, h("span", { class: "pk-icon", "aria-hidden": "true" }, SECTION_ICON[section.key] ?? "\u2728"), SECTION_TITLE[section.key] ?? section.title),
    );
    const list = h("ul", { class: "pk-items" });
    for (const item of section.items) {
      const withPhoto = item.photo !== null;
      list.append(
        h(
          "li",
          { class: withPhoto ? "pk-item has-photo" : "pk-item" },
          item.photo === null ? null : photoButton(item.photo, gallery, "pk-photo"),
          h("div", { class: "pk-item-body" }, h("div", { class: "pk-item-name" }, item.name), h("div", { class: "pk-item-detail" }, item.detail), link(item.url, "Open link")),
        ),
      );
    }
    card.append(list);
    body.append(card);
  }
  const facts: Array<[string, string]> = [
    ["Best time to go", pack.bestTime],
    ["Getting there", pack.gettingThere],
    ["Travel advice", pack.travelAdvice],
  ];
  for (const [title, text] of facts) {
    if (text === "") continue;
    body.append(h("section", { class: "pk-card pk-fact" }, h("h3", null, title), h("p", null, text)));
  }
  if (pack.sources.length > 0) {
    const list = h("ul", { class: "pk-sources" });
    for (const s of pack.sources) list.append(h("li", null, link(s.url, s.title) ?? s.title));
    body.append(h("section", { class: "pk-card pk-src" }, h("h3", null, "Sources"), list));
  }
  return root;
}
