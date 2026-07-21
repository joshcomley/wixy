// The review drawer's list-value rendering (decisions/00081): a whole-array
// op (opening hours, footer links, treatment cards) must read as human
// per-item lines — "Wednesday: value: By phone enquiry → Closed" — never as a
// raw `JSON.stringify` dump, which is what a total-layman site owner was
// asked to review before this existed.

import { describe, expect, it } from "vitest";
import type { PublishDiffEntry } from "../src/api";
import { renderDiffGroups } from "../src/diffView";

function render(entries: PublishDiffEntry[]): HTMLElement {
  return renderDiffGroups({ _global: entries }, { emptyText: "No content edits to review." });
}

const HOURS_OLD = [
  { closed: false, day: "Monday", value: "10:00 – 19:00" },
  { closed: true, day: "Wednesday", value: "By phone enquiry" },
  { closed: true, day: "Sunday", value: "Closed" },
];
const HOURS_NEW = [
  { closed: false, day: "Monday", value: "10:00 – 19:00" },
  { closed: true, day: "Wednesday", value: "Closed" },
  { closed: true, day: "Sunday", value: "Closed" },
];

describe("renderDiffGroups — list entries", () => {
  it("renders a changed list item as a labelled field line, not raw JSON", () => {
    const el = render([{ key: "hours", kind: "list", old: HOURS_OLD, new: HOURS_NEW }]);

    expect(el.textContent).not.toContain('{"');
    const lines = [...el.querySelectorAll(".wx-diff-list-line")].map((l) =>
      l.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(lines).toEqual(["Wednesday: value: By phone enquiry → Closed"]);
  });

  it("summarises added and removed items instead of dumping them", () => {
    const el = render([
      {
        key: "hours",
        kind: "list",
        old: HOURS_OLD.slice(0, 1),
        new: HOURS_OLD.slice(0, 2),
      },
    ]);
    const text = el.textContent ?? "";
    expect(text).toContain("Added: Wednesday, By phone enquiry");
    expect(text).not.toContain('{"');

    const removed = render([
      { key: "hours", kind: "list", old: HOURS_OLD.slice(0, 2), new: HOURS_OLD.slice(0, 1) },
    ]);
    expect(removed.textContent).toContain("Removed: Wednesday, By phone enquiry");
  });

  it("labels items by an identity-ish key (day/title/label/name) when present", () => {
    const el = render([
      {
        key: "footer.legal",
        kind: "list",
        old: [{ label: "Privacy", href: "/policies.html" }],
        new: [{ label: "Privacy", href: "/privacy" }],
      },
    ]);
    const lines = [...el.querySelectorAll(".wx-diff-list-line")].map((l) => l.textContent);
    expect(lines).toEqual(["Privacy: href: /policies.html → /privacy"]);
  });

  it("treats a null side as all-added / all-removed", () => {
    const el = render([{ key: "hours", kind: "list", old: null, new: HOURS_OLD.slice(0, 1) }]);
    expect(el.textContent).toContain("Added: Monday, 10:00 – 19:00");
  });

  it("caps long lists with an overflow note", () => {
    const many = (suffix: string) =>
      Array.from({ length: 15 }, (_, i) => ({ day: `Day ${i}`, value: `open ${suffix}` }));
    const el = render([{ key: "hours", kind: "list", old: many("old"), new: many("new") }]);
    expect(el.querySelectorAll(".wx-diff-list-line:not(.wx-diff-list-more)").length).toBe(10);
    expect(el.textContent).toContain("…and 5 more");
  });

  it("falls back to the item-count summary when a side isn't an array", () => {
    const el = render([{ key: "hours", kind: "list", old: "not-an-array", new: HOURS_OLD }]);
    expect(el.textContent).toContain("3 item(s)");
  });

  it("keeps the old plain old → new row for non-list kinds", () => {
    const el = render([{ key: "brand.line1", kind: "text", old: "Old", new: "New" }]);
    expect(el.querySelector(".wx-diff-list-line")).toBeNull();
    const values = [...el.querySelectorAll(".wx-diff-value")].map((v) => v.textContent);
    expect(values).toEqual(["Old", "New"]);
  });
});
