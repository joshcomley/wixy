import { describe, expect, it, vi } from "vitest";
import { renderPagesPanel } from "../src/pagesPanel";
import type { PageSummary } from "../src/api";

const PAGES: PageSummary[] = [
  {
    slug: "index",
    meta: { title: "Home", navLabel: "Home", inNav: true, navOrder: 10 },
    lastModified: "2026-07-01T12:00:00+00:00",
  },
  {
    slug: "about",
    meta: { title: "About", navLabel: "About", inNav: false },
    lastModified: null,
  },
];

describe("renderPagesPanel", () => {
  it("renders one row per page with its meta fields", () => {
    const el = renderPagesPanel(PAGES, { onEdit: vi.fn() });
    const rows = el.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(2);

    const first = rows[0] as HTMLElement;
    expect(first.dataset["slug"]).toBe("index");
    expect(first.textContent).toContain("Home");
    expect(first.textContent).toContain("Yes");
    expect(first.textContent).toContain("10");
  });

  it("shows a placeholder for missing navOrder and lastModified", () => {
    const el = renderPagesPanel(PAGES, { onEdit: vi.fn() });
    const rows = el.querySelectorAll("tbody tr");
    const second = rows[1] as HTMLElement;
    expect(second.textContent).toContain("No");
    expect(second.textContent).toContain("—");
  });

  it("falls back to the slug when title/navLabel are missing", () => {
    const el = renderPagesPanel(
      [{ slug: "contact", meta: {}, lastModified: null }],
      { onEdit: vi.fn() },
    );
    const row = el.querySelector("tbody tr") as HTMLElement;
    expect(row.textContent).toContain("contact");
  });

  it("calls onEdit with the page slug when Edit is clicked", () => {
    const onEdit = vi.fn();
    const el = renderPagesPanel(PAGES, { onEdit });
    const editButtons = el.querySelectorAll<HTMLButtonElement>(".wx-pages-edit");
    editButtons[1]?.click();
    expect(onEdit).toHaveBeenCalledWith("about");
  });

  it("includes a hint pointing structural work at the AI chat lane", () => {
    const el = renderPagesPanel([], { onEdit: vi.fn() });
    expect(el.querySelector(".wx-pages-hint")?.textContent).toMatch(/chat/i);
  });
});
