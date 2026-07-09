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

  const heading = document.createElement("h2");
  heading.textContent = "Media";
  root.appendChild(heading);

  const hint = document.createElement("p");
  hint.className = "wx-pages-hint";
  hint.textContent = "Upload images here, or replace one directly from the editor.";
  root.appendChild(hint);

  const grid: MediaGrid = renderMediaGrid({ api, ...(win !== undefined ? { win } : {}) });
  root.appendChild(grid.element);

  return {
    element: root,
    teardown(): void {
      grid.teardown();
    },
  };
}
