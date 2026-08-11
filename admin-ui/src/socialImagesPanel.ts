// The "Social images" one-screen manager (`/admin/social`, decisions/00134): every
// page's current social-share image in one place, instead of opening each page's
// Settings drawer separately (`pageSettingsDrawer.ts`'s "Social image" field remains
// the per-page path this complements, not replaces). Frontend-only — composes the
// existing `GET /api/admin/content/<page>` (`api.getContent`), the shared media
// picker (`mediaDialog.ts`), and the shell's single OpQueue; no new server routes.
//
// Each row re-fetches its own page content (mirroring `pageSettingsDrawer.ts`'s own
// read path, and reusing its exact `readMeta` parsing) rather than trusting
// `state.pages[].meta` — the state snapshot can be a moment stale, and every other
// admin surface that reads/writes a page's `meta.ogImage` already goes through
// `getContent` + `readMeta`; this keeps one parsing implementation, not two.

import type { AdminApi, PageSummary } from "./api";
import type { OpQueueLike } from "./editView";
import { contentSrcToDisplayUrl, openMediaDialog, type MediaPickValue } from "./mediaDialog";
import { readMeta } from "./pageSettingsDrawer";

export interface SocialImagesPanelDeps {
  api: AdminApi;
  opQueue: OpQueueLike;
}

export interface SocialImagesPanel {
  element: HTMLElement;
  teardown(): void;
}

interface RowState {
  slug: string;
  thumbCell: HTMLTableCellElement;
  current: { src: string; alt: string } | null;
}

function pageLabel(page: PageSummary): string {
  const navLabel = page.meta["navLabel"];
  return typeof navLabel === "string" && navLabel !== "" ? navLabel : page.slug;
}

export function mountSocialImagesPanel(
  pages: PageSummary[],
  deps: SocialImagesPanelDeps,
): SocialImagesPanel {
  let cancelled = false;

  const root = document.createElement("div");
  root.className = "wx-social-panel";

  const heading = document.createElement("h2");
  heading.textContent = "Social images";
  root.appendChild(heading);

  // -- Bulk action ------------------------------------------------------------
  const bulkRow = document.createElement("div");
  bulkRow.className = "wx-social-bulk-row";
  const bulkButton = document.createElement("button");
  bulkButton.type = "button";
  bulkButton.textContent = "Use one image for all pages";
  bulkButton.addEventListener("click", () => {
    openMediaDialog({ api: deps.api }, (value) => {
      if (value === null || cancelled) return;
      applyPick(
        pages.map((p) => p.slug),
        value,
      );
    });
  });
  bulkRow.appendChild(bulkButton);
  const hint = document.createElement("p");
  hint.className = "wx-pages-hint";
  hint.textContent =
    "This is the picture WhatsApp, Facebook and X show when someone shares a link to your " +
    "site. Changes here go live the next time you press Publish.";
  bulkRow.appendChild(hint);
  root.appendChild(bulkRow);

  // -- Rows ---------------------------------------------------------------------
  const table = document.createElement("table");
  table.className = "wx-pages-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["", "Page", ""]) {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  table.appendChild(tbody);
  root.appendChild(table);

  const rows = new Map<string, RowState>();

  function renderThumb(row: RowState): void {
    row.thumbCell.innerHTML = "";
    const preview = document.createElement("div");
    preview.className = "wx-og-image-preview";
    if (row.current !== null) {
      const img = document.createElement("img");
      img.src = contentSrcToDisplayUrl(row.current.src);
      img.alt = row.current.alt;
      preview.appendChild(img);
    } else {
      const empty = document.createElement("span");
      empty.className = "wx-og-image-empty";
      empty.textContent = "No image selected";
      preview.appendChild(empty);
    }
    row.thumbCell.appendChild(preview);
  }

  function applyPick(slugs: string[], value: MediaPickValue): void {
    for (const slug of slugs) {
      deps.opQueue.enqueue({
        file: slug,
        path: "meta.ogImage",
        value: { src: value.src, alt: value.alt },
      });
      const row = rows.get(slug);
      if (row !== undefined) {
        row.current = { src: value.src, alt: value.alt };
        renderThumb(row);
      }
    }
  }

  for (const page of pages) {
    const tr = document.createElement("tr");
    tr.dataset["slug"] = page.slug;

    const thumbCell = document.createElement("td");
    thumbCell.className = "wx-social-cell-thumb";
    thumbCell.textContent = "Loading…";
    tr.appendChild(thumbCell);

    const labelCell = document.createElement("td");
    labelCell.className = "wx-pages-cell-label";
    labelCell.textContent = pageLabel(page);
    tr.appendChild(labelCell);

    const actionsCell = document.createElement("td");
    actionsCell.className = "wx-pages-cell-actions";
    const pickButton = document.createElement("button");
    pickButton.type = "button";
    pickButton.textContent = "Choose image";
    pickButton.addEventListener("click", () => {
      openMediaDialog({ api: deps.api }, (value) => {
        if (value === null || cancelled) return;
        applyPick([page.slug], value);
      });
    });
    actionsCell.appendChild(pickButton);
    tr.appendChild(actionsCell);

    tbody.appendChild(tr);
    rows.set(page.slug, { slug: page.slug, thumbCell, current: null });
  }

  function loadRow(page: PageSummary): Promise<void> {
    return deps.api
      .getContent(page.slug)
      .then((response) => {
        if (cancelled) return;
        const row = rows.get(page.slug);
        if (row === undefined) return;
        row.current = readMeta(response.content).ogImage;
        renderThumb(row);
      })
      .catch(() => {
        if (cancelled) return;
        const row = rows.get(page.slug);
        if (row === undefined) return;
        row.thumbCell.innerHTML = "";
        const error = document.createElement("span");
        error.className = "wx-og-image-empty";
        error.textContent = "Couldn't load";
        row.thumbCell.appendChild(error);
      });
  }

  void Promise.all(pages.map(loadRow));

  return {
    element: root,
    teardown(): void {
      cancelled = true;
    },
  };
}
