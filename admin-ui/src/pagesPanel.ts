// The pages panel (spec/05-editor.md §2, "Page settings & pages panel"): a table
// of pages — nav label, title, in-nav toggle, nav order, last-modified; **Edit
// action only** — Duplicate/Delete are explicitly out of scope for milestone 7
// (decisions/00015 decision 3: no E2E flow needs them, the backend page-ops
// surface doesn't exist yet, and publish-time materialization semantics are
// milestone 9 territory).

import type { PageSummary } from "./api";

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function formatLastModified(iso: string | null): string {
  if (iso === null) return "—";
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
}

export interface PagesPanelCallbacks {
  onEdit: (slug: string) => void;
}

/** A detached element the caller mounts — same pattern as `editor/src/popovers.ts`
 * (easy to test: build it, query it, no attach-to-document required). */
export function renderPagesPanel(pages: PageSummary[], callbacks: PagesPanelCallbacks): HTMLElement {
  const root = document.createElement("div");
  root.className = "wx-pages-panel";

  const heading = document.createElement("h2");
  heading.textContent = "Pages";
  root.appendChild(heading);

  const hint = document.createElement("p");
  hint.className = "wx-pages-hint";
  hint.textContent =
    "Need a new section, a reordered layout, or a new page type? That's the AI chat assistant's job — see Chat.";
  root.appendChild(hint);

  const table = document.createElement("table");
  table.className = "wx-pages-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["Nav label", "Title", "In nav", "Nav order", "Last modified", ""]) {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const page of pages) {
    const row = document.createElement("tr");
    row.dataset["slug"] = page.slug;

    const navLabel = document.createElement("td");
    navLabel.textContent = text(page.meta["navLabel"], page.slug);
    row.appendChild(navLabel);

    const title = document.createElement("td");
    title.textContent = text(page.meta["title"], page.slug);
    row.appendChild(title);

    const inNav = document.createElement("td");
    inNav.textContent = page.meta["inNav"] === true ? "Yes" : "No";
    row.appendChild(inNav);

    const navOrder = document.createElement("td");
    navOrder.textContent = typeof page.meta["navOrder"] === "number" ? String(page.meta["navOrder"]) : "—";
    row.appendChild(navOrder);

    const lastModified = document.createElement("td");
    lastModified.textContent = formatLastModified(page.lastModified);
    row.appendChild(lastModified);

    const actions = document.createElement("td");
    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "wx-pages-edit";
    editButton.textContent = "Edit";
    editButton.addEventListener("click", () => callbacks.onEdit(page.slug));
    actions.appendChild(editButton);
    row.appendChild(actions);

    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  root.appendChild(table);

  return root;
}
