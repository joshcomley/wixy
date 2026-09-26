// The client's record of drawings and the rules that reconcile it with the server
// (spec/server-chat/07-live-drawing.md §2, §4, §6): a summary only triggers a fetch, a fetch is
// the only authority, an answer that raced this client's own create never deletes what it just
// made, stale answers are dropped, own strokes are matched by strokeId (no duplicates), and ids a
// delete removed stay removed.

import { describe, expect, it } from "vitest";
import type { StoredDrawing } from "../../src/server/api/drawings";
import { createDrawingModel, type DrawingModel, type ModelStroke } from "../../src/server/drawingModel";

function stroke(strokeId: string, points: Array<[number, number]> = [[1, 2], [3, 4]]): ModelStroke {
  return { strokeId, color: "#ff3b30", width: 4, points, state: "pending", sent: false };
}

function stored(id: number, rev: number, strokeIds: string[], columnWidth = 310): StoredDrawing {
  return {
    id,
    rev,
    sender: "Bob",
    columnWidth,
    strokes: strokeIds.map((strokeId) => ({ strokeId, color: "#0a84ff", width: 8, points: [[1, 2], [3, 4]] })),
  };
}

function ownDrawing(model: DrawingModel, clientId = "client-a", anchorSeq = 7) {
  return model.addOwn({ clientId, anchorSeq, columnWidth: 310, sender: "Alice" });
}

describe("drawingModel: own drawings", () => {
  it("an own drawing is keyed by its client id and has no server id yet", () => {
    const model = createDrawingModel();
    const drawing = ownDrawing(model);
    expect(drawing.key).toBe("c:client-a");
    expect(drawing.own).toBe(true);
    expect(drawing.id).toBeNull();
    expect(model.hasOwnClientId("client-a")).toBe(true);
    expect(model.get("c:client-a")).toBe(drawing);
  });

  it("confirmCreate files the drawing under its server id; confirmStroke marks the stroke stored", () => {
    const model = createDrawingModel();
    const drawing = ownDrawing(model);
    drawing.strokes.push(stroke("s1"));
    model.confirmCreate(drawing.key, 41, 1);
    model.confirmStroke(drawing.key, "s1", 1);
    expect(model.byId(41)).toBe(drawing);
    expect(drawing.rev).toBe(1);
    expect(drawing.strokes[0]?.state).toBe("stored");
  });

  it("confirmStroke never marks a stroke that is still under the finger as stored", () => {
    const model = createDrawingModel();
    const drawing = ownDrawing(model);
    const live = stroke("s1");
    live.state = "drawing";
    drawing.strokes.push(live);
    model.confirmStroke(drawing.key, "s1", 3);
    expect(live.state).toBe("drawing");
    expect(drawing.rev).toBe(3);
  });

  it("hasStroke finds a stroke in any drawing, in any state", () => {
    const model = createDrawingModel();
    const drawing = ownDrawing(model);
    drawing.strokes.push(stroke("s1"));
    expect(model.hasStroke("s1")).toBe(true);
    expect(model.hasStroke("s2")).toBe(false);
  });

  it("split moves the named strokes, in order, to a new own drawing on the same anchor and scale", () => {
    const model = createDrawingModel();
    const drawing = ownDrawing(model);
    drawing.strokes.push(stroke("s1"), stroke("s2"), stroke("s3"));
    const moved = model.split(drawing.key, ["s2", "s3"], "client-b");
    expect(moved?.key).toBe("c:client-b");
    expect(moved?.anchorSeq).toBe(7);
    expect(moved?.columnWidth).toBe(310);
    expect(moved?.strokes.map((s) => s.strokeId)).toEqual(["s2", "s3"]);
    expect(drawing.strokes.map((s) => s.strokeId)).toEqual(["s1"]);
  });
});

describe("drawingModel.needsFetch (a summary only ever TRIGGERS a fetch)", () => {
  it("an id the client does not know needs a fetch", () => {
    const model = createDrawingModel();
    expect(model.needsFetch(7, [{ id: 5, rev: 1 }])).toBe(true);
  });

  it("an empty summary for a message with no drawings needs nothing", () => {
    expect(createDrawingModel().needsFetch(7, [])).toBe(false);
  });

  it("another person's drawing needs a fetch only when its rev moved past the known one", () => {
    const model = createDrawingModel();
    model.applyFetched(7, [stored(5, 2, ["x1", "x2"])], model.nextEpoch());
    expect(model.needsFetch(7, [{ id: 5, rev: 2 }])).toBe(false);
    expect(model.needsFetch(7, [{ id: 5, rev: 1 }])).toBe(false);
    expect(model.needsFetch(7, [{ id: 5, rev: 3 }])).toBe(true);
  });

  it("an own drawing's revisions up to the strokes it has SENT are already accounted for", () => {
    const model = createDrawingModel();
    const drawing = ownDrawing(model);
    const a = stroke("s1");
    const b = stroke("s2");
    drawing.strokes.push(a, b);
    model.confirmCreate(drawing.key, 5, 1);
    a.sent = true;
    b.sent = true; // the append is still out: its revision may already be on the stream
    expect(model.needsFetch(7, [{ id: 5, rev: 2 }])).toBe(false);
    expect(model.needsFetch(7, [{ id: 5, rev: 3 }])).toBe(true);
  });

  it("a known drawing missing from the summary needs a fetch (it may have been deleted)", () => {
    const model = createDrawingModel();
    model.applyFetched(7, [stored(5, 1, ["x1"])], model.nextEpoch());
    expect(model.needsFetch(7, [])).toBe(true);
  });

  it("a tombstoned id (deleted here) is ignored even while the summary still lists it", () => {
    const model = createDrawingModel();
    model.tombstone(5);
    expect(model.needsFetch(7, [{ id: 5, rev: 9 }])).toBe(false);
  });
});

describe("drawingModel.applyFetched (the only authority)", () => {
  it("creates another person's drawings with their strokes in stored order", () => {
    const model = createDrawingModel();
    const result = model.applyFetched(7, [stored(5, 2, ["x1", "x2"])], model.nextEpoch());
    expect(result.stale).toBe(false);
    expect(result.changed).toEqual(["s:5"]);
    expect(result.storedStrokeIds).toEqual(["x1", "x2"]);
    const drawing = model.byId(5);
    expect(drawing?.own).toBe(false);
    expect(drawing?.sender).toBe("Bob");
    expect(drawing?.strokes.map((s) => [s.strokeId, s.state])).toEqual([["x1", "stored"], ["x2", "stored"]]);
  });

  it("drops an answer older than one already applied for the same message", () => {
    const model = createDrawingModel();
    const older = model.nextEpoch();
    const newer = model.nextEpoch();
    model.applyFetched(7, [stored(5, 2, ["x1", "x2"])], newer);
    const result = model.applyFetched(7, [], older);
    expect(result.stale).toBe(true);
    expect(model.byId(5)).toBeDefined();
  });

  it("adopts this client's own drawing by stroke id when the fetch beat the create's answer — no duplicate", () => {
    const model = createDrawingModel();
    const drawing = ownDrawing(model);
    const mine = stroke("s1");
    drawing.strokes.push(mine);
    const result = model.applyFetched(
      7,
      [{ id: 9, rev: 1, sender: "Alice", columnWidth: 310, strokes: [{ strokeId: "s1", color: "#ff3b30", width: 4, points: [[1, 2], [3, 4]] }] }],
      model.nextEpoch(),
    );
    expect(Array.from(model.all())).toHaveLength(1);
    expect(drawing.id).toBe(9);
    expect(model.byId(9)).toBe(drawing);
    expect(result.changed).toEqual([drawing.key]);
    // The same stroke object is kept (so its <path> is not rebuilt), now marked stored.
    expect(drawing.strokes[0]).toBe(mine);
    expect(mine.state).toBe("stored");
    // The create's answer arriving afterwards changes nothing.
    model.confirmCreate(drawing.key, 9, 1);
    expect(Array.from(model.all())).toHaveLength(1);
  });

  it("keeps strokes the server does not have yet (being drawn, or on their way) after the stored ones", () => {
    const model = createDrawingModel();
    const drawing = ownDrawing(model);
    drawing.strokes.push(stroke("s1"), stroke("s2"));
    const underFinger = stroke("s3");
    underFinger.state = "drawing";
    drawing.strokes.push(underFinger);
    model.confirmCreate(drawing.key, 9, 1);
    model.applyFetched(
      7,
      [{ id: 9, rev: 1, sender: "Alice", columnWidth: 310, strokes: [{ strokeId: "s1", color: "#ff3b30", width: 4, points: [[1, 2], [3, 4]] }] }],
      model.nextEpoch(),
    );
    expect(drawing.strokes.map((s) => [s.strokeId, s.state])).toEqual([
      ["s1", "stored"],
      ["s2", "pending"],
      ["s3", "drawing"],
    ]);
  });

  it("removes (and tombstones) a drawing the server no longer has, when the client knew it before asking", () => {
    const model = createDrawingModel();
    model.applyFetched(7, [stored(5, 1, ["x1"])], model.nextEpoch());
    const result = model.applyFetched(7, [], model.nextEpoch());
    expect(result.removed.map((d) => d.id)).toEqual([5]);
    expect(model.byId(5)).toBeUndefined();
    expect(model.isTombstoned(5)).toBe(true);
  });

  it("never removes a drawing this client created AFTER the fetch was sent (the create/fetch race)", () => {
    const model = createDrawingModel();
    const drawing = ownDrawing(model);
    drawing.strokes.push(stroke("s1"));
    const requestEpoch = model.nextEpoch(); // the GET leaves...
    model.confirmCreate(drawing.key, 9, 1); // ...our create commits and answers...
    const result = model.applyFetched(7, [], requestEpoch); // ...the GET's older snapshot arrives
    expect(result.removed).toEqual([]);
    expect(model.byId(9)).toBe(drawing);
    // A fetch sent after the client knew the id IS evidence: then it goes.
    const later = model.applyFetched(7, [], model.nextEpoch());
    expect(later.removed.map((d) => d.id)).toEqual([9]);
  });

  it("never resurrects a tombstoned (deleted here) drawing from a stale answer", () => {
    const model = createDrawingModel();
    model.tombstone(5);
    const result = model.applyFetched(7, [stored(5, 1, ["x1"])], model.nextEpoch());
    expect(result.changed).toEqual([]);
    expect(model.byId(5)).toBeUndefined();
  });

  it("replaces a stroke's points only when the server's differ (unchanged strokes keep their object)", () => {
    const model = createDrawingModel();
    model.applyFetched(7, [stored(5, 1, ["x1"])], model.nextEpoch());
    const before = model.byId(5)?.strokes[0];
    model.applyFetched(7, [stored(5, 2, ["x1", "x2"])], model.nextEpoch());
    const drawing = model.byId(5);
    expect(drawing?.strokes[0]).toBe(before);
    expect(drawing?.strokes.map((s) => s.strokeId)).toEqual(["x1", "x2"]);
    expect(drawing?.rev).toBe(2);
  });

  it("confirmCreate folds in a copy a fetch had filed under the same id, keeping one drawing", () => {
    const model = createDrawingModel();
    const drawing = ownDrawing(model);
    drawing.strokes.push(stroke("s1"));
    // A fetch that could NOT be matched by stroke id files it separately...
    model.applyFetched(7, [stored(9, 2, ["other"])], model.nextEpoch());
    expect(model.byId(9)?.key).toBe("s:9");
    // ...then our create answers with that same id.
    model.confirmCreate(drawing.key, 9, 1);
    expect(model.byId(9)).toBe(drawing);
    expect(model.get("s:9")).toBeUndefined();
    expect(drawing.strokes.map((s) => s.strokeId)).toEqual(["s1", "other"]);
    expect(drawing.rev).toBe(2);
  });
});

describe("drawingModel: erasure bookkeeping", () => {
  it("removeAnchor drops every drawing of that message and its fetch ordering", () => {
    const model = createDrawingModel();
    model.applyFetched(7, [stored(5, 1, ["x1"]), stored(6, 1, ["x2"])], model.nextEpoch());
    model.applyFetched(8, [stored(10, 1, ["x3"])], model.nextEpoch());
    const removed = model.removeAnchor(7);
    expect(removed.map((d) => d.id).sort()).toEqual([5, 6]);
    expect(model.anchorSeqs()).toEqual([8]);
    // Its ordering bookkeeping went with it: a fresh answer for seq 7 applies again.
    const fresh = model.applyFetched(7, [stored(11, 1, ["x4"])], 1);
    expect(fresh.stale).toBe(false);
  });

  it("restore puts back a drawing a failed delete had removed, and forgets its tombstone", () => {
    const model = createDrawingModel();
    model.applyFetched(7, [stored(5, 1, ["x1"])], model.nextEpoch());
    const drawing = model.byId(5)!;
    model.remove(drawing.key);
    model.tombstone(5);
    model.restore(drawing);
    expect(model.byId(5)).toBe(drawing);
    expect(model.isTombstoned(5)).toBe(false);
  });

  it("forAnchor lists stored drawings in server order, then drawings not yet created", () => {
    const model = createDrawingModel();
    const pending = ownDrawing(model, "client-z");
    model.applyFetched(7, [stored(6, 1, ["x2"]), stored(5, 1, ["x1"])], model.nextEpoch());
    expect(model.forAnchor(7).map((d) => d.key)).toEqual(["s:5", "s:6", pending.key]);
  });

  it("clear forgets everything, tombstones included", () => {
    const model = createDrawingModel();
    model.applyFetched(7, [stored(5, 1, ["x1"])], model.nextEpoch());
    model.tombstone(99);
    model.clear();
    expect(Array.from(model.all())).toEqual([]);
    expect(model.isTombstoned(99)).toBe(false);
  });
});
