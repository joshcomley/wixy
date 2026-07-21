import { describe, expect, it, vi } from "vitest";
import { renderPagesPanel, type PagesPanelCallbacks } from "../src/pagesPanel";
import type { PageOpOutcome, PageSummary } from "../src/api";

const PAGES: PageSummary[] = [
  {
    slug: "index",
    meta: { title: "Home", navLabel: "Home", inNav: true, navOrder: 10 },
    lastModified: "2026-07-01T12:00:00+00:00",
    editable: true,
    pendingDelete: false,
  },
  {
    slug: "about",
    meta: { title: "About", navLabel: "About", inNav: false },
    lastModified: null,
    editable: true,
    pendingDelete: false,
  },
];

function callbacks(overrides: Partial<PagesPanelCallbacks> = {}): PagesPanelCallbacks {
  return {
    onEdit: vi.fn(),
    onDuplicate: vi.fn(async (): Promise<PageOpOutcome> => ({ ok: true })),
    onDelete: vi.fn(async (): Promise<PageOpOutcome> => ({ ok: true })),
    onChanged: vi.fn(),
    ...overrides,
  };
}

describe("renderPagesPanel", () => {
  it("renders one row per page with its meta fields", () => {
    const el = renderPagesPanel(PAGES, callbacks());
    const rows = el.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(2);

    const first = rows[0] as HTMLElement;
    expect(first.dataset["slug"]).toBe("index");
    expect(first.textContent).toContain("Home");
    expect(first.textContent).toContain("Yes");
    expect(first.textContent).toContain("10");
  });

  it("shows a placeholder for missing navOrder and lastModified", () => {
    const el = renderPagesPanel(PAGES, callbacks());
    const rows = el.querySelectorAll("tbody tr");
    const second = rows[1] as HTMLElement;
    expect(second.textContent).toContain("No");
    expect(second.textContent).toContain("—");
  });

  it("falls back to the slug when title/navLabel are missing", () => {
    const el = renderPagesPanel(
      [{ slug: "contact", meta: {}, lastModified: null, editable: true, pendingDelete: false }],
      callbacks(),
    );
    const row = el.querySelector("tbody tr") as HTMLElement;
    expect(row.textContent).toContain("contact");
  });

  it("calls onEdit with the page slug when Edit is clicked", () => {
    const onEdit = vi.fn();
    const el = renderPagesPanel(PAGES, callbacks({ onEdit }));
    const editButtons = el.querySelectorAll<HTMLButtonElement>(".wx-pages-edit");
    editButtons[1]?.click();
    expect(onEdit).toHaveBeenCalledWith("about");
  });

  it("includes a hint pointing structural work at the AI chat lane", () => {
    const el = renderPagesPanel([], callbacks());
    expect(el.querySelector(".wx-pages-hint")?.textContent).toMatch(/chat/i);
  });

  it("disables Edit and shows an 'unpublished' badge for a non-editable page", () => {
    const el = renderPagesPanel(
      [
        {
          slug: "contact",
          meta: { navLabel: "Contact" },
          lastModified: null,
          editable: false,
          pendingDelete: false,
        },
      ],
      callbacks(),
    );
    const editButton = el.querySelector<HTMLButtonElement>(".wx-pages-edit");
    expect(editButton?.disabled).toBe(true);
    expect(el.querySelector(".wx-pages-badge-new")?.textContent).toBe("unpublished");
  });

  it("shows a 'pending delete' badge and disables Delete for a page staged for deletion", () => {
    const el = renderPagesPanel(
      [
        {
          slug: "about",
          meta: { navLabel: "About" },
          lastModified: null,
          editable: true,
          pendingDelete: true,
        },
      ],
      callbacks(),
    );
    expect(el.querySelector(".wx-pages-badge-delete")?.textContent).toBe("pending delete");
    expect(el.querySelector<HTMLButtonElement>(".wx-pages-delete")?.disabled).toBe(true);
  });

  it("clicking Duplicate reveals a form; the confirm button stays disabled until a valid slug and nav label are entered", () => {
    const el = renderPagesPanel(PAGES, callbacks());
    el.querySelectorAll<HTMLButtonElement>(".wx-pages-duplicate")[0]?.click();

    const form = el.querySelector(".wx-pages-inline-form") as HTMLElement;
    const [slugInput, navInput] = form.querySelectorAll<HTMLInputElement>("input");
    const confirmButton = Array.from(form.querySelectorAll("button")).find(
      (b) => b.textContent === "Create duplicate",
    );
    expect(confirmButton?.disabled).toBe(true);

    slugInput!.value = "Not A Slug";
    slugInput!.dispatchEvent(new Event("input"));
    expect(confirmButton?.disabled).toBe(true);

    slugInput!.value = "contact";
    slugInput!.dispatchEvent(new Event("input"));
    navInput!.value = "Contact";
    navInput!.dispatchEvent(new Event("input"));
    expect(confirmButton?.disabled).toBe(false);
  });

  it("confirming Duplicate calls onDuplicate and onChanged, then closes the form", async () => {
    const onDuplicate = vi.fn(async (): Promise<PageOpOutcome> => ({ ok: true }));
    const onChanged = vi.fn();
    const el = renderPagesPanel(PAGES, callbacks({ onDuplicate, onChanged }));
    el.querySelectorAll<HTMLButtonElement>(".wx-pages-duplicate")[0]?.click();

    const form = el.querySelector(".wx-pages-inline-form") as HTMLElement;
    const [slugInput, navInput] = form.querySelectorAll<HTMLInputElement>("input");
    slugInput!.value = "contact";
    slugInput!.dispatchEvent(new Event("input"));
    navInput!.value = "Contact";
    navInput!.dispatchEvent(new Event("input"));
    const confirmButton = Array.from(form.querySelectorAll("button")).find(
      (b) => b.textContent === "Create duplicate",
    );
    confirmButton?.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(onDuplicate).toHaveBeenCalledWith("index", "contact", "Contact");
    expect(onChanged).toHaveBeenCalledOnce();
    expect(el.querySelector(".wx-pages-inline-form")).toBeNull();
  });

  it("a failed Duplicate keeps the form open and shows the error", async () => {
    const onDuplicate = vi.fn(async (): Promise<PageOpOutcome> => ({
      ok: false,
      message: "page already exists: contact",
    }));
    const el = renderPagesPanel(PAGES, callbacks({ onDuplicate }));
    el.querySelectorAll<HTMLButtonElement>(".wx-pages-duplicate")[0]?.click();
    const form = el.querySelector(".wx-pages-inline-form") as HTMLElement;
    const [slugInput, navInput] = form.querySelectorAll<HTMLInputElement>("input");
    slugInput!.value = "contact";
    slugInput!.dispatchEvent(new Event("input"));
    navInput!.value = "Contact";
    navInput!.dispatchEvent(new Event("input"));
    const confirmButton = Array.from(form.querySelectorAll("button")).find(
      (b) => b.textContent === "Create duplicate",
    );
    confirmButton?.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(el.querySelector(".wx-pages-error")?.textContent).toBe("page already exists: contact");
    expect(el.querySelector(".wx-pages-inline-form")).not.toBeNull();
  });

  it("the Delete confirm button stays disabled until the exact phrase DELETE is typed", () => {
    const el = renderPagesPanel(PAGES, callbacks());
    el.querySelectorAll<HTMLButtonElement>(".wx-pages-delete")[1]?.click();
    const form = el.querySelector(".wx-pages-inline-form") as HTMLElement;
    const input = form.querySelector<HTMLInputElement>("input")!;
    const confirmButton = Array.from(form.querySelectorAll("button")).find(
      (b) => b.textContent === "Confirm delete",
    );
    expect(confirmButton?.disabled).toBe(true);

    input.value = "delete";
    input.dispatchEvent(new Event("input"));
    expect(confirmButton?.disabled).toBe(true);

    input.value = "DELETE";
    input.dispatchEvent(new Event("input"));
    expect(confirmButton?.disabled).toBe(false);
  });

  it("confirming Delete calls onDelete with the page's slug and onChanged", async () => {
    const onDelete = vi.fn(async (): Promise<PageOpOutcome> => ({ ok: true }));
    const onChanged = vi.fn();
    const el = renderPagesPanel(PAGES, callbacks({ onDelete, onChanged }));
    el.querySelectorAll<HTMLButtonElement>(".wx-pages-delete")[1]?.click();
    const form = el.querySelector(".wx-pages-inline-form") as HTMLElement;
    const input = form.querySelector<HTMLInputElement>("input")!;
    input.value = "DELETE";
    input.dispatchEvent(new Event("input"));
    const confirmButton = Array.from(form.querySelectorAll("button")).find(
      (b) => b.textContent === "Confirm delete",
    );
    confirmButton?.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(onDelete).toHaveBeenCalledWith("about");
    expect(onChanged).toHaveBeenCalledOnce();
  });
});

describe("page thumbnails (decisions/00078)", () => {
  it("renders a thumbnail cell per row when thumbSrcFor is provided", () => {
    const el = renderPagesPanel(PAGES, callbacks({ thumbSrcFor: (slug) => `/thumb/${slug}.jpg` }));
    const imgs = el.querySelectorAll(".wx-pages-thumb-img");
    expect(imgs).toHaveLength(2);
    expect((imgs[0] as HTMLImageElement).src).toContain("/thumb/index.jpg");
  });

  it("omits thumbnail cells when thumbSrcFor is absent", () => {
    const el = renderPagesPanel(PAGES, callbacks());
    expect(el.querySelectorAll(".wx-pages-thumb-img")).toHaveLength(0);
  });

  it("an image error swaps in a placeholder and reports the miss", () => {
    const onThumbError = vi.fn();
    const el = renderPagesPanel(
      PAGES,
      callbacks({ thumbSrcFor: (slug) => `/thumb/${slug}.jpg`, onThumbError }),
    );
    const firstImg = el.querySelector(".wx-pages-thumb-img") as HTMLImageElement;
    firstImg.dispatchEvent(new Event("error"));
    expect(el.querySelector(".wx-pages-thumb-placeholder")).not.toBeNull();
    expect(onThumbError).toHaveBeenCalledWith("index");
  });
});
