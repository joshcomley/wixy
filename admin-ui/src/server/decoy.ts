// The "Server" panel's DISGUISE (spec/server-chat/00-brief.md §6): a real
// server-status readout, shown locked by default with no visible entry
// point into the chat underneath it. R13: "The decoy shows only real server
// data" — every row below is a live read of the existing admin API, never
// placeholder/fake text once loaded (only the brief skeleton state, before
// the first load answers, is synthetic).
//
// Deliberately reuses the EXISTING `/api/admin/system/status` and
// `/api/version` routes (the same ones Settings > System already reads) —
// not a new `/api/admin/server/*` endpoint: this page must look and behave
// like an ordinary admin status page to a bystander, backed by real,
// already-authenticated data.

import type { AdminApi } from "../api";

export interface DecoyDeps {
  api: Pick<AdminApi, "getSystemStatus" | "getServerVersion">;
  win?: Window;
}

export interface DecoyView {
  readonly element: HTMLElement;
  teardown(): void;
}

const ROW_LABELS = [
  "Status",
  "Uptime",
  "Engine",
  "Edition",
  "Disk free",
  "Last publish",
  "Backups",
  "Media processing",
] as const;
type RowLabel = (typeof ROW_LABELS)[number];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

function formatWhen(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
}

function formatUptime(startedAtEpochS: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor(nowMs / 1000 - startedAtEpochS));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function mountDecoy(deps: DecoyDeps): DecoyView {
  const win = deps.win ?? window;

  const root = document.createElement("div");
  root.className = "wx-srv-decoy";

  const heading = document.createElement("h2");
  heading.className = "wx-srv-decoy-title";
  heading.textContent = "Server";
  root.appendChild(heading);

  const rows = document.createElement("dl");
  rows.className = "wx-srv-decoy-rows";
  root.appendChild(rows);

  const valueEls = new Map<RowLabel, HTMLElement>();
  for (const label of ROW_LABELS) {
    const row = document.createElement("div");
    row.className = "wx-srv-decoy-row";
    const dt = document.createElement("dt");
    dt.className = "wx-srv-decoy-label";
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.className = "wx-srv-decoy-value wx-srv-decoy-skeleton";
    row.append(dt, dd);
    rows.appendChild(row);
    valueEls.set(label, dd);
  }

  function setValue(label: RowLabel, text: string): void {
    const el = valueEls.get(label);
    if (el === undefined) return;
    el.textContent = text;
    el.classList.remove("wx-srv-decoy-skeleton");
  }

  let cancelled = false;

  async function load(): Promise<void> {
    try {
      const [status, version] = await Promise.all([deps.api.getSystemStatus(), deps.api.getServerVersion()]);
      if (cancelled) return;
      setValue("Status", "Online");
      setValue(
        "Uptime",
        status.server !== undefined ? formatUptime(status.server.startedAt, Date.now()) : "—",
      );
      const versionLabel = version?.count !== null && version?.count !== undefined ? `v${version.count}` : "v?";
      const shaLabel = status.engine.currentSha !== null ? ` · ${status.engine.currentSha.slice(0, 7)}` : "";
      setValue("Engine", `${versionLabel}${shaLabel}`);
      setValue("Edition", status.engine.edition);
      setValue("Disk free", formatBytes(status.diskUsage.freeBytes));
      setValue(
        "Last publish",
        status.lastPublish === null
          ? "Never"
          : `Version ${status.lastPublish.version}, ${formatWhen(status.lastPublish.when)}`,
      );
      setValue(
        "Backups",
        status.backup.lastAttemptAt === null
          ? "Never run"
          : status.backup.stale
            ? "Stale"
            : status.backup.ok === false
              ? "Failed"
              : `OK, ${formatWhen(status.backup.lastAttemptAt)}`,
      );
      setValue(
        "Media processing",
        status.server === undefined ? "—" : status.server.mediaProcessing === "ok" ? "OK" : "Unavailable",
      );
    } catch {
      if (cancelled) return;
      setValue("Status", "Unreachable");
    }
  }

  void load();

  return {
    element: root,
    teardown(): void {
      cancelled = true;
    },
  };
}
