// The publish review drawer (spec/05-editor.md §5): the draft diff grouped by
// page (old -> new text/image/theme entries), upstream commits since the
// published SHA, the builder-validate result, and a message field. Confirm
// kicks off `POST /api/admin/publish`; progress streams via SSE through
// `pulling -> merging -> committing -> building -> verifying -> swapping ->
// done` (or a failure state with the full error log inline — the draft stays
// intact and the site untouched, spec/04 §5 step 6, so there's nothing to
// reset client-side on failure beyond re-enabling the form).

import type { AdminApi, PublishJobData, PublishPreview, UpstreamCommit } from "./api";
import { renderDiffGroups } from "./diffView";

const DEFAULT_MESSAGE = "Content update via Wixy editor";

export interface PublishStreamHandle {
  close(): void;
}

export interface PublishDrawerDeps {
  api: AdminApi;
  expectedRev: number;
  upstream: UpstreamCommit[];
  onClose: () => void;
  onPublished: () => void;
  /** Overridable for tests — a real `EventSource` needs neither jsdom support
   * nor a live server to verify the drawer's own rendering/state logic. */
  openStream?: (onUpdate: (job: PublishJobData) => void) => PublishStreamHandle;
}

export interface PublishDrawer {
  element: HTMLElement;
  teardown(): void;
}

function defaultOpenStream(onUpdate: (job: PublishJobData) => void): PublishStreamHandle {
  const source = new EventSource("/api/admin/publish/stream");
  source.onmessage = (event: MessageEvent<string>) => {
    try {
      const data = JSON.parse(event.data) as { stage: PublishJobData["stage"] | null };
      if (data.stage === null) return; // no job yet — nothing to report
      onUpdate(data as PublishJobData);
    } catch {
      // A malformed/partial event is never fatal — the next one carries the
      // full current state again (routes_admin_api.publish_stream always
      // emits a full snapshot, never a delta).
    }
  };
  return { close: () => source.close() };
}

function renderUpstream(upstream: UpstreamCommit[]): HTMLElement | null {
  if (upstream.length === 0) return null;
  const wrap = document.createElement("div");
  wrap.className = "wx-diff-upstream";
  const title = document.createElement("h4");
  title.textContent =
    upstream.length === 1 ? "1 upstream commit" : `${upstream.length} upstream commits`;
  wrap.appendChild(title);
  const list = document.createElement("ul");
  for (const commit of upstream) {
    const item = document.createElement("li");
    item.textContent = `${commit.subject} — ${commit.author}`;
    list.appendChild(item);
  }
  wrap.appendChild(list);
  return wrap;
}

function renderValidate(preview: PublishPreview): HTMLElement | null {
  if (preview.validate.ok) return null;
  const wrap = document.createElement("div");
  wrap.className = "wx-diff-validate";
  const title = document.createElement("h4");
  title.textContent = "Validation problems";
  wrap.appendChild(title);
  const list = document.createElement("ul");
  for (const error of preview.validate.errors) {
    const item = document.createElement("li");
    item.textContent = error.file !== undefined ? `${error.file}: ${error.message}` : error.message;
    list.appendChild(item);
  }
  wrap.appendChild(list);
  return wrap;
}

export function mountPublishDrawer(deps: PublishDrawerDeps): PublishDrawer {
  const openStream = deps.openStream ?? defaultOpenStream;

  const root = document.createElement("div");
  root.className = "wx-drawer wx-drawer-wide";

  const header = document.createElement("div");
  header.className = "wx-drawer-header";
  const heading = document.createElement("h3");
  heading.textContent = "Review & publish";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "wx-drawer-close";
  closeButton.textContent = "×";
  closeButton.setAttribute("aria-label", "Close");
  closeButton.addEventListener("click", () => deps.onClose());
  header.append(heading, closeButton);
  root.appendChild(header);

  const body = document.createElement("div");
  body.className = "wx-drawer-body";
  body.textContent = "Loading…";
  root.appendChild(body);

  let cancelled = false;
  let streamHandle: PublishStreamHandle | null = null;

  function renderLoaded(preview: PublishPreview): void {
    body.innerHTML = "";

    const upstreamEl = renderUpstream(deps.upstream);
    if (upstreamEl !== null) body.appendChild(upstreamEl);

    const validateEl = renderValidate(preview);
    if (validateEl !== null) body.appendChild(validateEl);

    body.appendChild(renderDiffGroups(preview.changes, { emptyText: "No draft changes." }));

    const messageRow = document.createElement("label");
    messageRow.className = "wx-field-row";
    const messageLabel = document.createElement("span");
    messageLabel.textContent = "Message";
    const messageInput = document.createElement("input");
    messageInput.type = "text";
    messageInput.value = DEFAULT_MESSAGE;
    messageRow.append(messageLabel, messageInput);
    body.appendChild(messageRow);

    const progress = document.createElement("div");
    progress.className = "wx-publish-progress";
    progress.hidden = true;
    body.appendChild(progress);

    const errorBox = document.createElement("pre");
    errorBox.className = "wx-publish-error";
    errorBox.hidden = true;
    body.appendChild(errorBox);

    const confirmButton = document.createElement("button");
    confirmButton.type = "button";
    confirmButton.className = "wx-publish-confirm";
    confirmButton.textContent = "Publish";
    body.appendChild(confirmButton);

    function resetToIdle(): void {
      confirmButton.disabled = false;
      messageInput.disabled = false;
      progress.hidden = true;
    }

    confirmButton.addEventListener("click", () => {
      confirmButton.disabled = true;
      messageInput.disabled = true;
      errorBox.hidden = true;
      progress.hidden = false;
      progress.textContent = "Publishing… (pulling)";

      streamHandle = openStream((job) => {
        if (cancelled) return;
        progress.textContent = job.stage === "done" ? "Published." : `Publishing… (${job.stage})`;
      });

      deps.api
        .publish(messageInput.value, deps.expectedRev)
        .then((outcome) => {
          if (cancelled) return;
          streamHandle?.close();
          streamHandle = null;
          if (outcome.kind === "ok") {
            progress.textContent = `Published as version ${outcome.version}.`;
            deps.onPublished();
            return;
          }
          resetToIdle();
          errorBox.hidden = false;
          errorBox.textContent = outcome.message;
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          streamHandle?.close();
          streamHandle = null;
          resetToIdle();
          errorBox.hidden = false;
          errorBox.textContent = error instanceof Error ? error.message : "Publish failed.";
        });
    });
  }

  deps.api
    .getPublishPreview()
    .then((preview) => {
      if (cancelled) return;
      renderLoaded(preview);
    })
    .catch(() => {
      if (cancelled) return;
      body.textContent = "Couldn't load the publish preview.";
    });

  return {
    element: root,
    teardown(): void {
      cancelled = true;
      streamHandle?.close();
    },
  };
}
