// The `#/media` route (spec/05-editor.md §4) — a thin wrapper mounting
// `mediaDialog.ts`'s shared grid with no `onPick` (management-only: upload,
// inspect dimensions/size/references, delete unreferenced draft items). Same
// "detached element, caller mounts" shape as `pagesPanel.ts`.

import type { AdminApi } from "./api";
import { renderMediaGrid, type MediaGrid } from "./mediaDialog";

export interface MediaPanel {
  element: HTMLElement;
  teardown(): void;
}

export function mountMediaPanel(api: AdminApi, win?: Window): MediaPanel {
  const root = document.createElement("div");
  root.className = "wx-media-panel";

  // One-line header (operator 2026-07-21: "the media subheader is far too
  // tall, doesn't need to be over two lines") — title left, upload right; the
  // grid's own toolbar button moves up here.
  const headerRow = document.createElement("div");
  headerRow.className = "wx-media-header-row";
  const heading = document.createElement("h2");
  heading.textContent = "Media";
  headerRow.appendChild(heading);
  root.appendChild(headerRow);

  const hint = document.createElement("p");
  hint.className = "wx-pages-hint";
  hint.textContent = "Upload images here, or replace one directly from the editor.";
  root.appendChild(hint);

  const grid: MediaGrid = renderMediaGrid({
    api,
    ...(win !== undefined ? { win } : {}),
    headerRow,
  });
  root.appendChild(grid.element);

  return {
    element: root,
    teardown(): void {
      grid.teardown();
    },
  };
}
