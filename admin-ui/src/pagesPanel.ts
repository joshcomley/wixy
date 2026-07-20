// The pages panel (spec/05-editor.md §2, "Page settings & pages panel"): a table
// of pages — nav label, title, in-nav toggle, nav order, last-modified; Edit,
// Duplicate, and Delete actions. Duplicate/Delete were deferred past milestone 7
// (decisions/00015 decision 3: the backend page-ops surface + publish-time
// materialization semantics were milestone 9 territory) and built in milestone 9
// slice 4 once that contract existed (decisions/00029).

import type { PageOpOutcome, PageSummary } from "./api";

const DUPLICATE_SLUG_RE = /^[a-z][a-z0-9-]*$/;
const DELETE_CONFIRM_PHRASE = "DELETE";

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function formatLastModified(iso: string | null): string {
  if (iso === null) return "—";
  const parsed = new Date(iso);
  // Medium-date/short-time keeps the value compact — it shares one wrapping
  // meta line with the other fields in the narrow-viewport stacked layout.
  return Number.isNaN(parsed.getTime())
    ? iso
    : parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export interface PagesPanelCallbacks {
  onEdit: (slug: string) => void;
  onDuplicate: (fromSlug: string, newSlug: string, navLabel: string) => Promise<PageOpOutcome>;
  onDelete: (slug: string) => Promise<PageOpOutcome>;
  /** Called after a duplicate/delete succeeds — the caller (shell.ts) owns
   * refreshing state and re-rendering this panel with the new page list;
   * this component never re-fetches or re-renders itself. */
  onChanged: () => void;
}

function renderDuplicateRow(
  fromSlug: string,
  callbacks: PagesPanelCallbacks,
  onDone: () => void,
): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.className = "wx-pages-duplicate-row";
  const td = document.createElement("td");
  td.colSpan = 6;
  tr.appendChild(td);

  const row = document.createElement("div");
  row.className = "wx-pages-inline-form";
  td.appendChild(row);

  const slugLabel = document.createElement("span");
  slugLabel.textContent = "New slug:";
  const slugInput = document.createElement("input");
  slugInput.type = "text";
  slugInput.placeholder = "e.g. contact";

  const navLabel = document.createElement("span");
  navLabel.textContent = "Nav label:";
  const navInput = document.createElement("input");
  navInput.type = "text";

  const confirmButton = document.createElement("button");
  confirmButton.type = "button";
  confirmButton.textContent = "Create duplicate";
  confirmButton.disabled = true;

  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.textContent = "Cancel";
  cancelButton.addEventListener("click", () => onDone());

  const errorEl = document.createElement("span");
  errorEl.className = "wx-pages-error";
  errorEl.hidden = true;

  function updateConfirmEnabled(): void {
    confirmButton.disabled =
      !DUPLICATE_SLUG_RE.test(slugInput.value) || navInput.value.trim().length === 0;
  }
  slugInput.addEventListener("input", updateConfirmEnabled);
  navInput.addEventListener("input", updateConfirmEnabled);

  confirmButton.addEventListener("click", () => {
    confirmButton.disabled = true;
    slugInput.disabled = true;
    navInput.disabled = true;
    callbacks
      .onDuplicate(fromSlug, slugInput.value, navInput.value)
      .then((outcome) => {
        if (outcome.ok) {
          callbacks.onChanged();
          onDone();
          return;
        }
        confirmButton.disabled = false;
        slugInput.disabled = false;
        navInput.disabled = false;
        errorEl.hidden = false;
        errorEl.textContent = outcome.message;
      })
      .catch((error: unknown) => {
        confirmButton.disabled = false;
        slugInput.disabled = false;
        navInput.disabled = false;
        errorEl.hidden = false;
        errorEl.textContent = error instanceof Error ? error.message : "Duplicate failed.";
      });
  });

  row.append(slugLabel, slugInput, navLabel, navInput, confirmButton, cancelButton, errorEl);
  return tr;
}

function renderDeleteConfirmRow(
  slug: string,
  callbacks: PagesPanelCallbacks,
  onDone: () => void,
): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.className = "wx-pages-delete-row";
  const td = document.createElement("td");
  td.colSpan = 6;
  tr.appendChild(td);

  const row = document.createElement("div");
  row.className = "wx-pages-inline-form";
  td.appendChild(row);

  const prompt = document.createElement("span");
  prompt.textContent = `Type ${DELETE_CONFIRM_PHRASE} to stage "${slug}" for deletion at the next publish:`;
  const input = document.createElement("input");
  input.type = "text";

  const confirmButton = document.createElement("button");
  confirmButton.type = "button";
  confirmButton.textContent = "Confirm delete";
  confirmButton.disabled = true;

  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.textContent = "Cancel";
  cancelButton.addEventListener("click", () => onDone());

  const errorEl = document.createElement("span");
  errorEl.className = "wx-pages-error";
  errorEl.hidden = true;

  input.addEventListener("input", () => {
    confirmButton.disabled = input.value !== DELETE_CONFIRM_PHRASE;
  });

  confirmButton.addEventListener("click", () => {
    confirmButton.disabled = true;
    input.disabled = true;
    callbacks
      .onDelete(slug)
      .then((outcome) => {
        if (outcome.ok) {
          callbacks.onChanged();
          onDone();
          return;
        }
        confirmButton.disabled = false;
        input.disabled = false;
        errorEl.hidden = false;
        errorEl.textContent = outcome.message;
      })
      .catch((error: unknown) => {
        confirmButton.disabled = false;
        input.disabled = false;
        errorEl.hidden = false;
        errorEl.textContent = error instanceof Error ? error.message : "Delete failed.";
      });
  });

  row.append(prompt, input, confirmButton, cancelButton, errorEl);
  return tr;
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
    if (page.pendingDelete) row.classList.add("wx-pages-pending-delete");

    // Per-cell classes + data-label attributes are what the narrow-viewport
    // stylesheet hooks onto to restack each row as a compact list item (label
    // line, title line, one wrapping meta line, buttons at the bottom). On
    // wide viewports nothing matches them and the table renders unchanged.
    const navLabelText = text(page.meta["navLabel"], page.slug);
    const titleText = text(page.meta["title"], page.slug);
    if (titleText === navLabelText) row.classList.add("wx-pages-title-dupe");

    const navLabel = document.createElement("td");
    navLabel.className = "wx-pages-cell-label";
    navLabel.textContent = navLabelText;
    if (page.pendingDelete) navLabel.append(" ", _pendingBadge());
    if (!page.editable) navLabel.append(" ", _unpublishedBadge());
    row.appendChild(navLabel);

    const title = document.createElement("td");
    title.className = "wx-pages-cell-title";
    title.textContent = titleText;
    row.appendChild(title);

    const inNav = document.createElement("td");
    inNav.className = "wx-pages-cell-meta";
    inNav.dataset["label"] = "In nav";
    inNav.textContent = page.meta["inNav"] === true ? "Yes" : "No";
    row.appendChild(inNav);

    const navOrder = document.createElement("td");
    navOrder.className = "wx-pages-cell-meta";
    navOrder.dataset["label"] = "Order";
    navOrder.textContent =
      typeof page.meta["navOrder"] === "number" ? String(page.meta["navOrder"]) : "—";
    row.appendChild(navOrder);

    const lastModified = document.createElement("td");
    lastModified.className = "wx-pages-cell-meta";
    lastModified.dataset["label"] = "Modified";
    lastModified.textContent = formatLastModified(page.lastModified);
    row.appendChild(lastModified);

    const actions = document.createElement("td");
    actions.className = "wx-pages-cell-actions";
    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "wx-pages-edit";
    editButton.textContent = "Edit";
    editButton.disabled = !page.editable;
    editButton.title = page.editable ? "" : "Publish first to edit this page's content";
    editButton.addEventListener("click", () => callbacks.onEdit(page.slug));
    actions.appendChild(editButton);

    const duplicateButton = document.createElement("button");
    duplicateButton.type = "button";
    duplicateButton.className = "wx-pages-duplicate";
    duplicateButton.textContent = "Duplicate";
    actions.appendChild(duplicateButton);

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "wx-pages-delete";
    deleteButton.textContent = "Delete";
    deleteButton.disabled = page.pendingDelete;
    actions.appendChild(deleteButton);

    row.appendChild(actions);
    tbody.appendChild(row);

    let inlineRow: HTMLTableRowElement | null = null;
    function closeInline(): void {
      inlineRow?.remove();
      inlineRow = null;
    }
    duplicateButton.addEventListener("click", () => {
      if (inlineRow !== null) return;
      inlineRow = renderDuplicateRow(page.slug, callbacks, closeInline);
      row.after(inlineRow);
    });
    deleteButton.addEventListener("click", () => {
      if (inlineRow !== null) return;
      inlineRow = renderDeleteConfirmRow(page.slug, callbacks, closeInline);
      row.after(inlineRow);
    });
  }
  table.appendChild(tbody);
  root.appendChild(table);

  return root;
}

function _pendingBadge(): HTMLElement {
  const badge = document.createElement("span");
  badge.className = "wx-pages-badge wx-pages-badge-delete";
  badge.textContent = "pending delete";
  return badge;
}

function _unpublishedBadge(): HTMLElement {
  const badge = document.createElement("span");
  badge.className = "wx-pages-badge wx-pages-badge-new";
  badge.textContent = "unpublished";
  return badge;
}
