// The deploy-awareness version badge (decisions/00109) — the client-facing,
// deliberately-simple variant of the fleet's `ver` pattern (Aim.Mcp.Common
// code/ver-mcp): a tiny muted `v N` at the far left of the always-visible
// status bar while up to date; the canonical green glow (`v old → v new`) once
// a Slots deploy has landed past the loaded page. Tapping it opens a THEMED
// confirmation ("Would you like to load the latest version?") — never the git
// history the fleet pattern shows, because this surface is the site owner's,
// not a developer's. The confirmation exists because she may be mid-edit: the
// shell passes `beforeReload` (flushes the OpQueue) and a failed save blocks
// the reload with a calm note instead of silently losing the coalesced batch.
//
// The badge is pinned to the LOADED page's version (same rule as the fleet
// pattern): the first successful `check()` establishes what "this page" is;
// later checks only compare. Reloading is the reconvergence mechanism, so
// after a confirmed reload the new page pins the new version and goes quiet.

import type { ServerVersion } from "./api";

export interface VersionBadgeDeps {
  /** One `/api/version` fetch, already failure-tolerant — `null` means
   * "couldn't find out" (network down, gitless image), which always leaves the
   * badge exactly as it was. */
  fetchVersion: () => Promise<ServerVersion | null>;
  /** The "What's new" lines for the update popup (decisions/00112), fetched
   * with the LOADED page's sha so the range is exactly "what changed since the
   * version she's running". `null` = couldn't fetch; the popup still shows the
   * generic line rather than nothing. */
  fetchNotes: (since: string | null) => Promise<string[] | null>;
  win: Window;
  /** Runs before the confirmed reload (the shell flushes the OpQueue here).
   * A THROW blocks the reload — the dialog says so and stays open. */
  beforeReload?: () => Promise<void> | void;
}

export interface VersionBadge {
  element: HTMLButtonElement;
  /** One poll: pins the loaded version on first success; flags (or clears, if
   * the server rolled back) the update glow on a sha change. */
  check(): Promise<void>;
  /** Closes the dialog if open (shell teardown). */
  teardown(): void;
}

/** Display fallback when the notes fetch itself fails (the server already
 * substitutes this line for empty history; this is only for "couldn't ask").
 * Keep in sync with `RELEASE_NOTES_FALLBACK` in `wixy_server/routes_version.py`. */
const NOTES_FALLBACK = "General bug fixes and improvements.";

export function mountVersionBadge(deps: VersionBadgeDeps): VersionBadge {
  const badge = document.createElement("button");
  badge.type = "button";
  badge.className = "wx-version-badge";
  badge.hidden = true;
  // The quiet→glow flip is the ONLY "a deploy happened" signal in the app —
  // announced, not just painted.
  badge.setAttribute("aria-live", "polite");
  badge.addEventListener("click", () => openDialog());

  let loaded: ServerVersion | null = null;
  let latest: ServerVersion | null = null;
  let notes: string[] | null = null;
  let notesListEl: HTMLUListElement | null = null;
  let backdrop: HTMLElement | null = null;

  function render(): void {
    badge.classList.toggle("wx-version-update-available", latest !== null);
    if (latest !== null) {
      badge.hidden = false;
      const oldCount = loaded?.count ?? null;
      badge.textContent =
        oldCount !== null && latest.count !== null
          ? `v${oldCount} → v${latest.count}`
          : "New version";
      const label = "A new version of Wixy is ready — tap to load it";
      badge.title = label;
      badge.setAttribute("aria-label", label);
      return;
    }
    if (loaded === null || loaded.count === null) {
      // Nothing truthful to show yet (or a gitless image with no baked count)
      // — the badge simply stays out of the way.
      badge.hidden = true;
      badge.textContent = "";
      return;
    }
    badge.hidden = false;
    badge.textContent = `v${loaded.count}`;
    const label = `Wixy version ${loaded.count} — up to date`;
    badge.title = label;
    badge.setAttribute("aria-label", label);
  }

  async function check(): Promise<void> {
    let current: ServerVersion | null;
    try {
      current = await deps.fetchVersion();
    } catch {
      return; // same contract as a null return: leave the badge exactly as it was
    }
    if (current === null) return;
    if (loaded === null) {
      loaded = current;
      latest = null;
    } else if (
      current.shaFull !== null &&
      loaded.shaFull !== null &&
      current.shaFull !== loaded.shaFull
    ) {
      latest = current;
      // Prefetch the "What's new" lines now (the glow may sit for minutes
      // before she taps) so the popup opens with them already in hand.
      notes = null;
      void loadNotes();
    } else if (current.shaFull !== null && current.shaFull === loaded.shaFull) {
      latest = null; // a rollback deploy landed — go quiet again
    }
    // (Either sha unknown → can't compare; keep the current display.)
    render();
  }

  async function loadNotes(): Promise<void> {
    const result = await deps.fetchNotes(loaded?.shaFull ?? null);
    notes = result ?? [NOTES_FALLBACK];
    // If the dialog is open and still showing its loading line, fill it in.
    if (notesListEl !== null) renderNotesInto(notesListEl);
  }

  function renderNotesInto(list: HTMLUListElement): void {
    list.innerHTML = "";
    if (notes === null) {
      const loading = document.createElement("li");
      loading.className = "wx-version-notes-loading";
      loading.textContent = "Loading what's new…";
      list.appendChild(loading);
      return;
    }
    for (const note of notes) {
      const item = document.createElement("li");
      item.textContent = note;
      list.appendChild(item);
    }
  }

  function closeDialog(): void {
    backdrop?.remove();
    backdrop = null;
    notesListEl = null;
    document.removeEventListener("keydown", onDialogKeydown);
    badge.focus();
  }

  function onDialogKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") closeDialog();
  }

  function openDialog(): void {
    if (backdrop !== null) return; // already open — a second tap must not stack them
    backdrop = document.createElement("div");
    backdrop.className = "wx-version-backdrop";
    const dialog = document.createElement("div");
    dialog.className = "wx-version-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "wx-version-dialog-title");

    const title = document.createElement("h3");
    title.id = "wx-version-dialog-title";
    const body = document.createElement("p");
    const actions = document.createElement("div");
    actions.className = "wx-version-dialog-actions";

    const updating = latest !== null;
    if (updating) {
      title.textContent = "A new version of Wixy is ready";
      body.textContent = "Would you like to load the latest version now?";

      // The "What's new" list (decisions/00112): the Release-note trailers of
      // exactly the commits she'd advance past — plain English, never a
      // changelog. Prefetched when the glow appeared; a loading line until
      // then (loadNotes fills it in place if it lands while she's reading).
      const notesHeading = document.createElement("p");
      notesHeading.className = "wx-version-notes-heading";
      notesHeading.textContent = "What's new in this version:";
      const notesList = document.createElement("ul");
      notesList.className = "wx-version-notes";
      notesListEl = notesList;
      renderNotesInto(notesList);
      if (notes === null) void loadNotes(); // belt-and-braces (prefetch raced)

      const note = document.createElement("p");
      note.className = "wx-version-dialog-note";
      note.textContent = "Anything you've already changed is saved and will still be there.";

      const cancelButton = document.createElement("button");
      cancelButton.type = "button";
      cancelButton.className = "wx-version-dialog-cancel";
      cancelButton.textContent = "Not now";
      cancelButton.addEventListener("click", closeDialog);

      const confirmButton = document.createElement("button");
      confirmButton.type = "button";
      confirmButton.className = "wx-version-dialog-confirm";
      confirmButton.textContent = "Load latest version";
      confirmButton.addEventListener("click", () => {
        // Instant feedback (fleet rule): the flush behind beforeReload can take
        // a real network round trip, so the dialog goes busy synchronously.
        confirmButton.disabled = true;
        cancelButton.disabled = true;
        confirmButton.textContent = "Saving your changes…";
        void (async () => {
          try {
            await deps.beforeReload?.();
          } catch {
            // The queued edits did NOT reach the server — reloading now would
            // lose them. Say so and stay put; she can try again.
            note.textContent =
              "Couldn't save your latest change — check your connection, then try again.";
            confirmButton.disabled = false;
            cancelButton.disabled = false;
            confirmButton.textContent = "Load latest version";
            return;
          }
          deps.win.location.reload();
        })();
      });
      actions.append(cancelButton, confirmButton);
      dialog.append(title, body, notesHeading, notesList, note, actions);
      confirmButton.focus();
    } else {
      title.textContent = "Wixy is up to date";
      const count = loaded?.count ?? null;
      body.textContent =
        count !== null
          ? `You're using the latest version (v${count}).`
          : "You're using the latest version.";
      const closeButton = document.createElement("button");
      closeButton.type = "button";
      closeButton.className = "wx-version-dialog-cancel";
      closeButton.textContent = "Close";
      closeButton.addEventListener("click", closeDialog);
      actions.append(closeButton);
      dialog.append(title, body, actions);
      closeButton.focus();
    }

    backdrop.appendChild(dialog);
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) closeDialog();
    });
    document.addEventListener("keydown", onDialogKeydown);
    document.body.appendChild(backdrop);
  }

  return {
    element: badge,
    check,
    teardown(): void {
      if (backdrop !== null) closeDialog();
    },
  };
}
