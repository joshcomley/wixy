import { afterEach, describe, expect, it } from "vitest";
import { ServerLockedError } from "../../src/server/api/http";
import { parseRoundPhotos, type PhotosResult } from "../../src/server/cookout/api";
import { PHOTO_CHANGED } from "../../src/server/cookout/cookedSheet";
import { picture, recipesNone } from "./fixtures";
import { bankedSlot, cookedInfo, makeHarness, q, qa, settle, twistFinished, type Harness, type Json } from "./twistFixtures";

// The "We cooked it!" corner of a banked recipe (spec/server-chat/09a-cookout-twists.md §1.8, §9): the mark,
// two heart rows (own editable, partner read-only), the unmark confirmation, the plates side by side, and the
// photo chooser (one tile per message; the link names exactly that tile's ids).

afterEach(() => document.body.replaceChildren());

const RECIPE = '.wx-srv-ck-dish[data-concept="a"]';

function cookedView(cooked: Json | null, root: Json = {}): Json {
  return twistFinished(
    { concepts: "ready", images: "done" },
    { recipes: { ...recipesNone(), a: bankedSlot(1, { cooked }) }, ...root },
  );
}

/** The round with dish a's recipe open. */
function openRecipe(h: Harness, raw: Json): void {
  h.show(raw);
  q<HTMLButtonElement>(h.pane, `${RECIPE} .wx-srv-ck-banked`).click();
}

function hearts(h: Harness, slot: 1 | 2): HTMLElement {
  return q(h.pane, `${RECIPE} .wx-srv-ck-hearts[data-slot="${slot}"]`);
}

function button(h: Harness, selector: string): HTMLButtonElement {
  return q<HTMLButtonElement>(h.pane, selector);
}

const PHOTOS_BODY: Json = {
  photos: [
    { messageSeq: 9, attachmentId: "att-90", sender: "Josh", createdAt: 1793300200, picture: picture(90) },
    { messageSeq: 7, attachmentId: "att-70", sender: "Cupcake", createdAt: 1793300100, picture: picture(70) },
  ],
};

function photosResult(body: Json = PHOTOS_BODY): PhotosResult {
  return { ok: true, photos: parseRoundPhotos(body) ?? [] };
}

describe("marking a recipe cooked", () => {
  it("'We cooked it!' marks that dish cooked, naming the recipe's own generation", async () => {
    const h = makeHarness();
    openRecipe(h, cookedView(null));
    const mark = button(h, `${RECIPE} .wx-srv-ck-cooked-mark`);
    expect(mark.textContent).toContain("We cooked it!");
    h.api.markCooked.mockResolvedValue(h.ok(cookedView(cookedInfo())));
    mark.click();
    expect(h.api.markCooked).toHaveBeenCalledWith(41, 1, "a", true);
    expect(button(h, `${RECIPE} .wx-srv-ck-cooked-mark`).textContent).toBe("Saving…");
    await settle();
    expect(q(h.pane, `${RECIPE} .wx-srv-ck-cooked-badge`).textContent).toBe("✓ Cooked");
    expect(h.pane.querySelector(`${RECIPE} .wx-srv-ck-cooked-mark`)).toBeNull();
  });

  it("a refused mark says somebody else changed it and re-reads the round", async () => {
    const h = makeHarness();
    openRecipe(h, cookedView(null));
    h.api.markCooked.mockResolvedValue({ ok: false, kind: "bad_state" });
    button(h, `${RECIPE} .wx-srv-ck-cooked-mark`).click();
    await settle();
    expect(q(h.pane, ".wx-srv-ck-toast").textContent).toBe("Somebody else changed this recipe — have another look.");
    expect(button(h, `${RECIPE} .wx-srv-ck-cooked-mark`).disabled).toBe(false);
  });

  it("a non-player sees no button to mark it, but sees a cooked recipe's badge", () => {
    const h = makeHarness();
    openRecipe(h, cookedView(null, { you: null }));
    expect(h.pane.querySelector(".wx-srv-ck-cooked-mark")).toBeNull();
    h.show(cookedView(cookedInfo({ ratings: { "1": 4, "2": null } }), { you: null }));
    expect(q(h.pane, ".wx-srv-ck-cooked-badge").textContent).toBe("✓ Cooked");
    expect(h.pane.querySelector(".wx-srv-ck-cooked-more")).toBeNull();
    expect(h.pane.querySelector("button.wx-srv-ck-heart")).toBeNull();
  });
});

describe("the hearts", () => {
  const rated = (): Json => cookedView(cookedInfo({ ratings: { "1": 4, "2": 2 } }));

  it("the own row is five tap targets, the partner's is read-only", () => {
    const h = makeHarness();
    openRecipe(h, rated());
    const own = hearts(h, 1);
    expect(q(own, ".wx-srv-ck-hearts-who").textContent).toBe("You");
    expect(own.classList.contains("wx-srv-ck-hearts-mine")).toBe(true);
    const buttons = qa<HTMLButtonElement>(own, "button.wx-srv-ck-heart");
    expect(buttons).toHaveLength(5);
    expect(buttons.map((b) => b.textContent).join("")).toBe("♥♥♥♥♡");
    expect(q(own, ".wx-srv-ck-hearts-list").getAttribute("aria-label")).toBe("You: 4 of 5 hearts");
    expect(buttons[3]?.getAttribute("aria-checked")).toBe("true");
    const partner = hearts(h, 2);
    expect(q(partner, ".wx-srv-ck-hearts-who").textContent).toBe("Cupcake");
    expect(partner.querySelectorAll("button")).toHaveLength(0);
    expect(partner.classList.contains("wx-srv-ck-hearts-mine")).toBe(false);
    expect(qa(partner, ".wx-srv-ck-heart").map((n) => n.textContent).join("")).toBe("♥♥♡♡♡");
    expect(q(partner, ".wx-srv-ck-hearts-list").getAttribute("aria-label")).toBe("Cupcake: 2 of 5 hearts");
  });

  it("tapping the 5th heart rates 5; tapping the current rating clears it", async () => {
    const h = makeHarness();
    openRecipe(h, rated());
    h.api.rate.mockResolvedValue(h.ok(rated()));
    qa<HTMLButtonElement>(hearts(h, 1), "button.wx-srv-ck-heart")[4]?.click();
    expect(h.api.rate).toHaveBeenLastCalledWith(41, 1, "a", 5);
    await settle();
    qa<HTMLButtonElement>(hearts(h, 1), "button.wx-srv-ck-heart")[3]?.click();
    expect(h.api.rate).toHaveBeenLastCalledWith(41, 1, "a", null);
    await settle();
    qa<HTMLButtonElement>(hearts(h, 1), "button.wx-srv-ck-heart")[0]?.click();
    expect(h.api.rate).toHaveBeenLastCalledWith(41, 1, "a", 1);
    expect(h.api.rate).toHaveBeenCalledTimes(3);
  });

  it("the partner's hearts cannot be tapped into a rating call", () => {
    const h = makeHarness();
    openRecipe(h, rated());
    for (const heart of qa(hearts(h, 2), ".wx-srv-ck-heart")) heart.click();
    expect(h.api.rate).not.toHaveBeenCalled();
  });

  it("for Player 2 the own row is theirs (slot 2, first), and the partner's is Josh's, read-only", async () => {
    const h = makeHarness();
    openRecipe(h, cookedView(cookedInfo({ ratings: { "1": 4, "2": 2 } }), { you: { slot: 2, chaosUsed: false, vetoUsed: false } }));
    expect(qa(h.pane, `${RECIPE} .wx-srv-ck-hearts`).map((r) => r.dataset["slot"])).toEqual(["2", "1"]);
    expect(q(hearts(h, 2), ".wx-srv-ck-hearts-who").textContent).toBe("You");
    expect(q(hearts(h, 1), ".wx-srv-ck-hearts-who").textContent).toBe("Josh");
    expect(hearts(h, 1).querySelectorAll("button")).toHaveLength(0);
    h.api.rate.mockResolvedValue(h.ok(rated()));
    qa<HTMLButtonElement>(hearts(h, 2), "button.wx-srv-ck-heart")[2]?.click();
    expect(h.api.rate).toHaveBeenCalledWith(41, 1, "a", 3);
    await settle();
  });

  it("an unrated partner says so", () => {
    const h = makeHarness();
    openRecipe(h, cookedView(cookedInfo({ ratings: { "1": 3, "2": null } })));
    expect(q(hearts(h, 2), ".wx-srv-ck-hearts-none").textContent).toBe("not rated yet");
    expect(q(hearts(h, 2), ".wx-srv-ck-hearts-list").getAttribute("aria-label")).toBe("Cupcake: not rated yet");
  });
});

describe("unmarking", () => {
  it("⋯ → Unmark as cooked asks first, then unmarks that recipe", async () => {
    const h = makeHarness();
    openRecipe(h, cookedView(cookedInfo()));
    button(h, `${RECIPE} .wx-srv-ck-cooked-more`).click();
    expect(button(h, `${RECIPE} .wx-srv-ck-cooked-unmark`).textContent).toBe("Unmark as cooked");
    button(h, `${RECIPE} .wx-srv-ck-cooked-unmark`).click();
    expect(q(h.pane, `${RECIPE} .wx-srv-ck-cooked-confirm-text`).textContent).toBe("Unmark as cooked? Your ratings and photo link will be removed.");
    expect(h.api.markCooked).not.toHaveBeenCalled();
    h.api.markCooked.mockResolvedValue(h.ok(cookedView(null)));
    button(h, `${RECIPE} .wx-srv-ck-cooked-unmark-yes`).click();
    expect(h.api.markCooked).toHaveBeenCalledWith(41, 1, "a", false);
    await settle();
    expect(h.pane.querySelector(`${RECIPE} .wx-srv-ck-cooked-menu`)).toBeNull();
    expect(h.pane.querySelector(`${RECIPE} .wx-srv-ck-cooked-mark`)).not.toBeNull();
  });

  it("'Keep it' backs out without a call", () => {
    const h = makeHarness();
    openRecipe(h, cookedView(cookedInfo()));
    button(h, `${RECIPE} .wx-srv-ck-cooked-more`).click();
    button(h, `${RECIPE} .wx-srv-ck-cooked-unmark`).click();
    button(h, `${RECIPE} .wx-srv-ck-cooked-keep`).click();
    expect(h.pane.querySelector(`${RECIPE} .wx-srv-ck-cooked-menu`)).toBeNull();
    expect(h.api.markCooked).not.toHaveBeenCalled();
    expect(q(h.pane, `${RECIPE} .wx-srv-ck-cooked-badge`).textContent).toBe("✓ Cooked");
  });

  it("a linked photo adds 'Remove our photo', which unlinks both ids", async () => {
    const h = makeHarness();
    openRecipe(h, cookedView(cookedInfo({ photo: picture(5), photoMessageSeq: 9 })));
    button(h, `${RECIPE} .wx-srv-ck-cooked-more`).click();
    const items = qa<HTMLButtonElement>(h.pane, `${RECIPE} .wx-srv-ck-cooked-menu-item`);
    expect(items.map((i) => i.textContent)).toEqual(["Remove our photo", "Unmark as cooked"]);
    h.api.linkPhoto.mockResolvedValue(h.ok(cookedView(cookedInfo())));
    items[0]?.click();
    expect(h.api.linkPhoto).toHaveBeenCalledWith(41, 1, "a", null, null);
    await settle();
  });
});

describe("our plate beside the chef's daydream", () => {
  it("shows the chef's picture and the real photo side by side, each captioned", () => {
    const h = makeHarness();
    openRecipe(
      h,
      cookedView(cookedInfo({ photo: picture(5), photoMessageSeq: 9 }), { images: { state: "done", pictures: { a: picture(1), b: null, c: null } } }),
    );
    const tiles = qa(h.pane, `${RECIPE} .wx-srv-ck-plates-tile`);
    expect(tiles.map((t) => t.querySelector(".wx-srv-ck-plates-caption")?.textContent)).toEqual(["Chef's daydream", "Our plate"]);
    expect(tiles.map((t) => t.querySelector("img")?.getAttribute("src"))).toEqual(["/api/admin/server/media/thumb-1.jpg", "/api/admin/server/media/thumb-5.jpg"]);
    expect(button(h, `${RECIPE} .wx-srv-ck-plates-change`).textContent).toBe("Change photo");
  });

  it("without a photo it offers 'Add our photo' in its place", () => {
    const h = makeHarness();
    openRecipe(h, cookedView(cookedInfo()));
    const add = button(h, `${RECIPE} .wx-srv-ck-plates-add`);
    expect(add.textContent).toContain("Add our photo");
    expect(h.pane.querySelector(`${RECIPE} .wx-srv-ck-plates-change`)).toBeNull();
  });
});

describe("the photo chooser", () => {
  async function chooser(h: Harness, result: PhotosResult | Promise<PhotosResult> = photosResult()): Promise<HTMLElement> {
    h.api.photos.mockResolvedValue(result);
    button(h, `${RECIPE} .wx-srv-ck-plates-add`).click();
    await settle();
    return q(h.pane, ".wx-srv-ck-photos");
  }

  it("opens over the game with one tile per message, from a fresh read of this game's photos", async () => {
    const h = makeHarness();
    openRecipe(h, cookedView(cookedInfo()));
    expect(q(h.pane, ".wx-srv-ck-photos").hidden).toBe(true);
    const sheet = await chooser(h);
    expect(h.api.photos).toHaveBeenCalledTimes(1);
    expect(h.api.photos).toHaveBeenCalledWith(41);
    expect(sheet.hidden).toBe(false);
    const tiles = qa<HTMLButtonElement>(sheet, ".wx-srv-ck-photos-tile");
    expect(tiles.map((t) => [t.dataset["messageSeq"], t.dataset["attachmentId"]])).toEqual([
      ["9", "att-90"],
      ["7", "att-70"],
    ]);
    expect(tiles.map((t) => t.querySelector("img")?.getAttribute("src"))).toEqual(["/api/admin/server/media/thumb-90.jpg", "/api/admin/server/media/thumb-70.jpg"]);
    expect(q(sheet, ".wx-srv-ck-photos-note").textContent).toBe("Tap the photo of the dish you made.");
  });

  it("tapping a tile links EXACTLY that tile's message and attachment to this recipe's generation", async () => {
    const h = makeHarness();
    openRecipe(h, cookedView(cookedInfo()));
    const sheet = await chooser(h);
    h.api.linkPhoto.mockResolvedValue(h.ok(cookedView(cookedInfo({ photo: picture(70), photoMessageSeq: 7 }))));
    qa<HTMLButtonElement>(sheet, ".wx-srv-ck-photos-tile")[1]?.click();
    expect(h.api.linkPhoto).toHaveBeenCalledTimes(1);
    expect(h.api.linkPhoto).toHaveBeenCalledWith(41, 1, "a", 7, "att-70");
    expect(sheet.hidden).toBe(true);
    await settle();
    expect(h.pane.querySelector(`${RECIPE} .wx-srv-ck-plates-change`)).not.toBeNull();
    // The first tile would have sent the first ids.
    const again = await (async () => {
      button(h, `${RECIPE} .wx-srv-ck-plates-change`).click();
      await settle();
      return q(h.pane, ".wx-srv-ck-photos");
    })();
    qa<HTMLButtonElement>(again, ".wx-srv-ck-photos-tile")[0]?.click();
    expect(h.api.linkPhoto).toHaveBeenLastCalledWith(41, 1, "a", 9, "att-90");
  });

  it("a 409 bad_state says the photo changed and opens the chooser again with a FRESH list", async () => {
    const h = makeHarness();
    openRecipe(h, cookedView(cookedInfo()));
    const fresh = photosResult({ photos: [{ messageSeq: 11, attachmentId: "att-110", sender: "Josh", createdAt: 5, picture: picture(110) }] });
    h.api.photos.mockResolvedValueOnce(photosResult()).mockResolvedValueOnce(fresh);
    button(h, `${RECIPE} .wx-srv-ck-plates-add`).click();
    await settle();
    h.api.linkPhoto.mockResolvedValue({ ok: false, kind: "bad_state" });
    qa<HTMLButtonElement>(q(h.pane, ".wx-srv-ck-photos"), ".wx-srv-ck-photos-tile")[0]?.click();
    await settle();
    expect(PHOTO_CHANGED).toBe("That photo changed - pick again");
    expect(h.api.photos).toHaveBeenCalledTimes(2);
    const sheet = q(h.pane, ".wx-srv-ck-photos");
    expect(sheet.hidden).toBe(false);
    expect(q(sheet, ".wx-srv-ck-photos-note").textContent).toBe("That photo changed - pick again");
    expect(qa<HTMLButtonElement>(sheet, ".wx-srv-ck-photos-tile").map((t) => t.dataset["attachmentId"])).toEqual(["att-110"]);
    expect(q(h.pane, ".wx-srv-ck-toast").textContent).toBe("That photo changed - pick again");
    // The new tile links the new ids.
    h.api.linkPhoto.mockResolvedValue(h.ok(cookedView(cookedInfo())));
    qa<HTMLButtonElement>(sheet, ".wx-srv-ck-photos-tile")[0]?.click();
    expect(h.api.linkPhoto).toHaveBeenLastCalledWith(41, 1, "a", 11, "att-110");
    await settle();
  });

  it("'Send a new photo to this game's chat' opens the round's mini-chat pop-up", async () => {
    const h = makeHarness();
    openRecipe(h, cookedView(cookedInfo()));
    const sheet = await chooser(h);
    const send = q<HTMLButtonElement>(sheet, ".wx-srv-ck-photos-send");
    expect(send.textContent).toContain("Send a new photo to this game's chat");
    send.click();
    expect(h.itemChat.openPopup).toHaveBeenCalledWith(41, "Cookout chat");
    expect(sheet.hidden).toBe(true);
  });

  it("with no photos yet it says so (and still offers to send one)", async () => {
    const h = makeHarness();
    openRecipe(h, cookedView(cookedInfo()));
    const sheet = await chooser(h, { ok: true, photos: [] });
    expect(qa(sheet, ".wx-srv-ck-photos-tile")).toHaveLength(0);
    expect(q(sheet, ".wx-srv-ck-photos-note").textContent).toBe("No photos in this game's chat yet — send one first.");
    expect(q(sheet, ".wx-srv-ck-photos-send")).not.toBeNull();
  });

  it("says when the list could not be read, and Cancel closes without a link", async () => {
    const h = makeHarness();
    openRecipe(h, cookedView(cookedInfo()));
    const sheet = await chooser(h, { ok: false, kind: "unavailable" });
    expect(q(sheet, ".wx-srv-ck-photos-note").textContent).toBe("Couldn't load this game's photos — try again.");
    q<HTMLButtonElement>(sheet, ".wx-srv-ck-photos-cancel").click();
    expect(sheet.hidden).toBe(true);
    expect(h.api.linkPhoto).not.toHaveBeenCalled();
  });

  it("a lock while reading the photos locks the chat", async () => {
    const h = makeHarness();
    openRecipe(h, cookedView(cookedInfo()));
    h.api.photos.mockRejectedValue(new ServerLockedError());
    button(h, `${RECIPE} .wx-srv-ck-plates-add`).click();
    await settle();
    expect(h.lockNow).toHaveBeenCalledWith("unauthorized");
  });

  it("a reset (lock or wipe) closes the chooser and drops its answer", async () => {
    const h = makeHarness();
    openRecipe(h, cookedView(cookedInfo()));
    let resolve: (r: PhotosResult) => void = () => {};
    h.api.photos.mockReturnValue(new Promise<PhotosResult>((r) => (resolve = r)));
    button(h, `${RECIPE} .wx-srv-ck-plates-add`).click();
    expect(q(h.pane, ".wx-srv-ck-photos").hidden).toBe(false);
    h.tabs.reset();
    expect(q(h.pane, ".wx-srv-ck-photos").hidden).toBe(true);
    resolve(photosResult());
    await settle();
    expect(qa(h.pane, ".wx-srv-ck-photos-tile")).toHaveLength(0);
  });
});
