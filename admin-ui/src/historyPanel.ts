// The `#/history` panel (spec/05-editor.md §5): the publish ledger newest-first
// — version #, when, message, author (editor/AI/mixed), SHA, changed-file
// summary. Per-row actions: View (opens that build read-only at
// `/admin/versions/<n>/…`) and Restore (typed confirmation, then
// `POST /api/admin/restore` — spec/04 §5-6: instant live swap + draft reset to
// that version, recorded as a new version).

import type { AdminApi, PublishesEntry } from "./api";

const RESTORE_CONFIRM_PHRASE = "RESTORE";

export interface HistoryPanelDeps {
  api: AdminApi;
  onRestored: () => void;
}

export interface HistoryPanel {
  element: HTMLElement;
  teardown(): void;
}

function formatWhen(iso: string): string {
  const parsed = new Date(iso);
  // Medium-date/short-time keeps the value compact — on narrow viewports the
  // timestamp shares the stacked row layout with the other fields (same
  // trade the pages table made for its last-modified column).
  return Number.isNaN(parsed.getTime())
    ? iso
    : parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function authorLabel(entry: PublishesEntry): string {
  if (entry.action === "restore") return "restore";
  if (entry.source === "editor") return "editor";
  if (entry.source === "upstream") return "AI";
  if (entry.source === "mixed") return "mixed";
  return "—";
}

function messageLabel(entry: PublishesEntry): string {
  if (entry.action === "restore") return `Restore of version ${entry.of ?? "?"}`;
  return entry.message ?? "—";
}

function changedSummary(entry: PublishesEntry): string {
  if (entry.changed === undefined) return "—";
  const parts = Object.entries(entry.changed).map(([file, keys]) => `${file} (${keys.length})`);
  return parts.length > 0 ? parts.join(", ") : "—";
}

export function mountHistoryPanel(deps: HistoryPanelDeps): HistoryPanel {
  const root = document.createElement("div");
  root.className = "wx-history-panel";

  const heading = document.createElement("h2");
  heading.textContent = "History";
  root.appendChild(heading);

  const body = document.createElement("div");
  body.textContent = "Loading…";
  root.appendChild(body);

  let cancelled = false;

  function renderConfirmRow(entry: PublishesEntry, onDone: () => void): HTMLTableRowElement {
    const tr = document.createElement("tr");
    tr.className = "wx-history-confirm-row";
    const td = document.createElement("td");
    td.colSpan = 7;
    tr.appendChild(td);

    const row = document.createElement("div");
    row.className = "wx-history-confirm";
    td.appendChild(row);

    const prompt = document.createElement("span");
    prompt.textContent = `Type ${RESTORE_CONFIRM_PHRASE} to confirm reverting the live site to version ${entry.version}:`;
    row.appendChild(prompt);

    const input = document.createElement("input");
    input.type = "text";
    row.appendChild(input);

    const confirmButton = document.createElement("button");
    confirmButton.type = "button";
    confirmButton.textContent = "Confirm restore";
    confirmButton.disabled = true;
    row.appendChild(confirmButton);

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.textContent = "Cancel";
    cancelButton.addEventListener("click", () => onDone());
    row.appendChild(cancelButton);

    const errorEl = document.createElement("span");
    errorEl.className = "wx-history-error";
    errorEl.hidden = true;
    row.appendChild(errorEl);

    input.addEventListener("input", () => {
      confirmButton.disabled = input.value !== RESTORE_CONFIRM_PHRASE;
    });

    confirmButton.addEventListener("click", () => {
      confirmButton.disabled = true;
      input.disabled = true;
      deps.api
        .restore(entry.version)
        .then((outcome) => {
          if (cancelled) return;
          if (outcome.kind === "ok") {
            deps.onRestored();
            onDone();
            return;
          }
          confirmButton.disabled = false;
          input.disabled = false;
          errorEl.hidden = false;
          errorEl.textContent = outcome.message;
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          confirmButton.disabled = false;
          input.disabled = false;
          errorEl.hidden = false;
          errorEl.textContent = error instanceof Error ? error.message : "Restore failed.";
        });
    });

    return tr;
  }

  function renderTable(entries: PublishesEntry[]): void {
    body.innerHTML = "";
    if (entries.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = "Nothing published yet.";
      body.appendChild(empty);
      return;
    }

    const table = document.createElement("table");
    table.className = "wx-history-table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const label of ["Version", "When", "Message", "Author", "SHA", "Changed", ""]) {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const entry of entries) {
      const row = document.createElement("tr");
      row.dataset["version"] = String(entry.version);
      if (entry.live) row.classList.add("wx-history-live");

      // Per-cell classes + data-label attributes are what the narrow-viewport
      // stylesheet hooks onto to restack each row as a compact list item
      // (version line, timestamp line, message line, one wrapping meta line,
      // buttons at the bottom — the pages table's pattern). On wide viewports
      // nothing matches them and the table renders unchanged.
      const version = document.createElement("td");
      version.className = "wx-history-cell-version";
      version.textContent = entry.live ? `${entry.version} (live)` : String(entry.version);
      row.appendChild(version);

      const when = document.createElement("td");
      when.className = "wx-history-cell-when";
      when.textContent = formatWhen(entry.when);
      row.appendChild(when);

      const message = document.createElement("td");
      message.className = "wx-history-cell-message";
      message.textContent = messageLabel(entry);
      row.appendChild(message);

      const author = document.createElement("td");
      author.className = "wx-history-cell-meta";
      author.dataset["label"] = "Author";
      author.textContent = authorLabel(entry);
      row.appendChild(author);

      const sha = document.createElement("td");
      sha.className = "wx-history-cell-meta";
      sha.dataset["label"] = "SHA";
      sha.textContent = entry.sha.slice(0, 8);
      row.appendChild(sha);

      const changed = document.createElement("td");
      changed.className = "wx-history-cell-meta";
      changed.dataset["label"] = "Changed";
      changed.textContent = changedSummary(entry);
      row.appendChild(changed);

      const actions = document.createElement("td");
      actions.className = "wx-history-cell-actions";
      const viewLink = document.createElement("a");
      viewLink.className = "wx-history-view";
      viewLink.textContent = "View";
      viewLink.href = `/admin/versions/${entry.version}/index.html`;
      viewLink.target = "_blank";
      viewLink.rel = "noopener noreferrer";
      actions.appendChild(viewLink);

      const restoreButton = document.createElement("button");
      restoreButton.type = "button";
      restoreButton.className = "wx-history-restore";
      restoreButton.textContent = "Restore";
      actions.appendChild(restoreButton);
      row.appendChild(actions);

      let confirmRow: HTMLTableRowElement | null = null;
      restoreButton.addEventListener("click", () => {
        if (confirmRow !== null) return;
        confirmRow = renderConfirmRow(entry, () => {
          confirmRow?.remove();
          confirmRow = null;
        });
        row.after(confirmRow);
      });

      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    body.appendChild(table);
  }

  deps.api
    .getPublishes()
    .then((entries) => {
      if (cancelled) return;
      renderTable(entries);
    })
    .catch(() => {
      if (cancelled) return;
      body.textContent = "Couldn't load publish history.";
    });

  return {
    element: root,
    teardown(): void {
      cancelled = true;
    },
  };
}
