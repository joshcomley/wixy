// The publish review drawer (spec/05-editor.md §5): the draft diff grouped by
// page (old -> new text/image/theme entries), upstream commits since the
// published SHA, and a message field. Confirm kicks off `POST /api/admin/
// publish`; progress streams via SSE through `pulling -> merging ->
// committing -> building -> verifying -> swapping -> done` (or a failure
// state — the draft stays intact and the site untouched, spec/04 §5 step 6).
// decisions/00089: confirm also fires `onPublishStarted` synchronously so the
// SHELL's status-bar watch owns run/completion feedback even if this drawer
// is closed mid-publish.
//
// decisions/00095: a blocked draft (validate.ok === false) renders a calm
// "Publishing is paused" panel instead of the reviewable diff+confirm UI —
// no raw validator output, ever. "Fix it for me" calls the deterministic
// self-heal endpoint; "Send a report" is the escape hatch when that isn't
// enough. Confirming a publish swaps the WHOLE drawer body through running/
// success/failure states — never an inline spinner + a raw error `<pre>`.

import type {
  AdminApi,
  PublishJobData,
  PublishPreview,
  RepairOutcome,
  UpstreamCommit,
} from "./api";
import { renderDiffGroups } from "./diffView";
import { PUBLISH_STAGE_LABELS } from "./publishStages";
import { setButtonBusy, setButtonIdle } from "./spinnerButton";

const DEFAULT_MESSAGE = "Content update via Wixy editor";

export interface PublishStreamHandle {
  close(): void;
}

export interface PublishDrawerDeps {
  api: AdminApi;
  expectedRev: number;
  upstream: UpstreamCommit[];
  onClose: () => void;
  onPublished: (version: number) => void;
  /** Fired synchronously the moment a publish is kicked off (before any await)
   * — the shell arms its own status-bar watch on it, so closing this drawer
   * mid-publish never loses progress/completion feedback (decisions/00089). */
  onPublishStarted?: () => void;
  /** Fired when the publish POST settles in ANY outcome (ok / conflict /
   * failed / network error — even mid-teardown) — the shell drops its
   * in-flight bridge flag on it; crucially that includes the 409-conflict
   * path, where no job ever starts server-side (decisions/00089). */
  onPublishSettled?: () => void;
  /** Surfaces a transient confirmation the same way the shell's own status
   * toasts do (decisions/00095's Fix-it-for-me / Send-a-report outcomes) —
   * injected rather than a direct shell.ts import, so this module stays
   * shell-agnostic and unit-testable without a real toast region. */
  onToast?: (message: string, variant?: "error" | "info") => void;
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

function renderMediaChanges(mediaChanges: { replaced: string[]; deleted: string[] }): HTMLElement | null {
  if (mediaChanges.replaced.length === 0 && mediaChanges.deleted.length === 0) return null;
  const wrap = document.createElement("div");
  wrap.className = "wx-diff-media";
  const count = mediaChanges.replaced.length + mediaChanges.deleted.length;
  const title = document.createElement("p");
  title.className = "wx-diff-media-title";
  title.textContent = count === 1 ? "1 media change" : `${count} media changes`;
  wrap.appendChild(title);
  const list = document.createElement("ul");
  for (const name of mediaChanges.replaced) {
    const li = document.createElement("li");
    li.textContent = `↻ ${name} — replaced`;
    list.appendChild(li);
  }
  for (const name of mediaChanges.deleted) {
    const li = document.createElement("li");
    li.className = "wx-diff-media-deleted";
    li.textContent = `✕ ${name} — deleted`;
    list.appendChild(li);
  }
  wrap.appendChild(list);
  return wrap;
}

function renderUpstream(upstream: UpstreamCommit[]): HTMLElement | null {
  if (upstream.length === 0) return null;
  const wrap = document.createElement("div");
  wrap.className = "wx-diff-upstream";
  const title = document.createElement("h4");
  title.textContent =
    upstream.length === 1
      ? "1 update made outside the editor"
      : `${upstream.length} updates made outside the editor`;
  wrap.appendChild(title);
  // Plain-English framing for a non-technical site owner (decisions/00081):
  // these are real changes to the site that just didn't go through this
  // editor, and publishing takes them live too — nothing extra to do.
  const note = document.createElement("p");
  note.className = "wx-diff-upstream-note";
  note.textContent =
    "These changes were made for you outside this editor — for example by the AI assistant " +
    "or your developer. Publishing takes everything live in one go.";
  wrap.appendChild(note);
  const list = document.createElement("ul");
  for (const commit of upstream) {
    const item = document.createElement("li");
    item.textContent = `${commit.subject} — ${commit.author}`;
    list.appendChild(item);
  }
  wrap.appendChild(list);
  return wrap;
}

const BLOCKED_MESSAGE =
  "Some recent changes have a technical problem, so publishing is paused. " +
  "You can fix this automatically, or send a report to your developer. Your live site is unaffected.";
const BLOCKED_MESSAGE_AFTER_PARTIAL_FIX =
  "We couldn't fix everything automatically — please send a report.";
const FAILURE_BODY = "Nothing changed on your live site, and your edits are safe.";

export function mountPublishDrawer(deps: PublishDrawerDeps): PublishDrawer {
  const openStream = deps.openStream ?? defaultOpenStream;
  const onToast = deps.onToast ?? ((): void => {});

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
  // May advance past deps.expectedRev after a successful in-drawer repair —
  // every subsequent server call (another repair, the eventual publish) must
  // use the LATEST known rev, not the one this drawer opened with.
  let currentRev = deps.expectedRev;
  let stageCaption: HTMLElement | null = null;

  function renderLoaded(preview: PublishPreview): void {
    if (!preview.validate.ok) {
      renderBlocked(preview);
    } else {
      renderReviewable(preview);
    }
  }

  async function refetchAndRender(): Promise<void> {
    const fresh = await deps.api.getPublishPreview();
    if (cancelled) return;
    renderLoaded(fresh);
  }

  // -- Blocked state (decisions/00095) -----------------------------------------

  function renderBlocked(preview: PublishPreview): void {
    body.innerHTML = "";

    const upstreamEl = renderUpstream(deps.upstream);
    if (upstreamEl !== null) body.appendChild(upstreamEl);
    const mediaEl = renderMediaChanges(preview.mediaChanges);
    if (mediaEl !== null) body.appendChild(mediaEl);

    const panel = document.createElement("div");
    panel.className = "wx-publish-blocked";
    const panelHeading = document.createElement("h4");
    panelHeading.textContent = "Publishing is paused";
    const message = document.createElement("p");
    message.className = "wx-publish-blocked-body";
    message.textContent = BLOCKED_MESSAGE;

    const actions = document.createElement("div");
    actions.className = "wx-publish-blocked-actions";
    const fixButton = document.createElement("button");
    fixButton.type = "button";
    fixButton.className = "wx-publish-fix";
    fixButton.textContent = "Fix it for me";
    const reportButton = document.createElement("button");
    reportButton.type = "button";
    reportButton.className = "wx-publish-report";
    reportButton.textContent = "Send a report";
    actions.append(fixButton, reportButton);

    panel.append(panelHeading, message, actions);
    body.appendChild(panel);

    fixButton.addEventListener("click", () => {
      void handleFix();
    });
    reportButton.addEventListener("click", () => {
      void handleReport("publish-validate", reportButton, "Send a report");
    });

    async function handleFix(): Promise<void> {
      fixButton.disabled = true;
      reportButton.disabled = true;
      setButtonBusy(fixButton, "Fixing…");
      let outcome: RepairOutcome;
      try {
        outcome = await deps.api.repairDraft(currentRev);
      } catch {
        resetFixButton();
        onToast("That didn't work — please send a report instead.", "error");
        return;
      }
      if (cancelled) return;
      if (outcome.kind !== "ok") {
        resetFixButton();
        onToast("That didn't work — please send a report instead.", "error");
        return;
      }
      currentRev = outcome.rev;
      if (outcome.validate.ok) {
        onToast(
          outcome.actions.length > 0
            ? `Fixed — ready to publish. ${outcome.actions.join("; ")}`
            : "Fixed — ready to publish.",
          "info",
        );
        await refetchAndRender();
        return;
      }
      // Still blocked — the deterministic repair couldn't fully clear it
      // (e.g. a template/binding problem from an upstream commit).
      message.textContent = BLOCKED_MESSAGE_AFTER_PARTIAL_FIX;
      resetFixButton();
      reportButton.classList.add("wx-publish-report-emphasized");
    }

    function resetFixButton(): void {
      setButtonIdle(fixButton, "Fix it for me");
      fixButton.disabled = false;
      reportButton.disabled = false;
    }

    // The Publish button never renders while blocked — publishing against
    // known-bad content would just 422 (the calm preflight rejection).
  }

  async function handleReport(
    context: string,
    triggerButton: HTMLButtonElement,
    idleLabel: string,
  ): Promise<void> {
    triggerButton.disabled = true;
    setButtonBusy(triggerButton, "Sending…");
    try {
      const outcome = await deps.api.sendReport(context);
      if (cancelled) return;
      onToast(
        outcome.emailed ? "Report sent to your developer." : "Report saved for your developer.",
        "info",
      );
    } catch {
      if (cancelled) return;
      onToast("Couldn't send the report — please try again.", "error");
    } finally {
      if (!cancelled) {
        setButtonIdle(triggerButton, idleLabel);
        triggerButton.disabled = false;
      }
    }
  }

  // -- Reviewable state (unblocked — the normal diff + confirm UI) ------------

  function renderReviewable(preview: PublishPreview): void {
    body.innerHTML = "";

    const upstreamEl = renderUpstream(deps.upstream);
    if (upstreamEl !== null) body.appendChild(upstreamEl);

    const mediaEl = renderMediaChanges(preview.mediaChanges);
    if (mediaEl !== null) body.appendChild(mediaEl);

    body.appendChild(
      renderDiffGroups(preview.changes, { emptyText: "No content edits to review." }),
    );

    const messageRow = document.createElement("label");
    messageRow.className = "wx-field-row";
    const messageLabel = document.createElement("span");
    messageLabel.textContent = "Message";
    const messageInput = document.createElement("input");
    messageInput.type = "text";
    messageInput.value = DEFAULT_MESSAGE;
    messageRow.append(messageLabel, messageInput);
    body.appendChild(messageRow);

    const confirmButton = document.createElement("button");
    confirmButton.type = "button";
    confirmButton.className = "wx-publish-confirm";
    confirmButton.textContent = "Publish";
    body.appendChild(confirmButton);

    // decisions/00071 — with no staged changes AND no upstream commits to
    // merge, a publish records a version that changes nothing (the live SHA
    // is simply re-ledgered), which reads as a broken history entry. The
    // server refuses it (422); the drawer makes the same call visible up
    // front by disabling Publish with the reason next to it. Upstream
    // commits alone keep it enabled — merging them IS the change.
    if (preview.opCount === 0 && deps.upstream.length === 0) {
      confirmButton.disabled = true;
      const hint = document.createElement("p");
      hint.className = "wx-publish-empty-hint";
      hint.textContent = "Nothing to publish — make an edit first.";
      body.appendChild(hint);
    }

    confirmButton.addEventListener("click", () => {
      // Before ANY await: the shell arms its status-bar watch from this, so
      // the run's feedback no longer depends on this drawer staying open
      // (decisions/00089, Inv 25).
      deps.onPublishStarted?.();
      renderRunning();

      streamHandle = openStream((job) => {
        if (cancelled) return;
        setStageCaption(PUBLISH_STAGE_LABELS[job.stage]);
      });

      deps.api
        .publish(messageInput.value, currentRev)
        .then((outcome) => {
          if (cancelled) return;
          streamHandle?.close();
          streamHandle = null;
          if (outcome.kind === "ok") {
            renderSuccess(outcome.version);
            deps.onPublished(outcome.version);
            return;
          }
          renderFailure();
        })
        .catch(() => {
          if (cancelled) return;
          streamHandle?.close();
          streamHandle = null;
          renderFailure();
        })
        .finally(() => {
          // NOT cancelled-gated: the shell's in-flight bridge must drop even
          // when this drawer was torn down mid-publish.
          deps.onPublishSettled?.();
        });
    });
  }

  // -- Running / success / failure states --------------------------------------
  // A publish attempt swaps the WHOLE drawer body through these three states
  // (decisions/00095) — never an inline spinner on the confirm button plus a
  // raw error `<pre>` (the server's technical detail lives in the log and
  // the report bundle, never in front of the owner).

  function setStageCaption(text: string): void {
    if (stageCaption !== null) stageCaption.textContent = text;
  }

  function renderRunning(): void {
    body.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "wx-publish-running";
    const spinner = document.createElement("span");
    spinner.className = "wx-spinner wx-publish-state-spinner";
    spinner.setAttribute("aria-hidden", "true");
    const runningHeading = document.createElement("p");
    runningHeading.className = "wx-publish-state-heading";
    runningHeading.textContent = "Publishing your site…";
    const caption = document.createElement("p");
    caption.className = "wx-publish-state-caption";
    caption.textContent = PUBLISH_STAGE_LABELS.pulling;
    stageCaption = caption;
    wrap.append(spinner, runningHeading, caption);
    body.appendChild(wrap);
  }

  function renderSuccess(version: number): void {
    body.innerHTML = "";
    stageCaption = null;
    const wrap = document.createElement("div");
    wrap.className = "wx-publish-success";
    const icon = document.createElement("span");
    icon.className = "wx-publish-state-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "✓";
    const successHeading = document.createElement("p");
    successHeading.className = "wx-publish-state-heading";
    successHeading.textContent = "Your site is live.";
    const versionLine = document.createElement("p");
    versionLine.className = "wx-publish-state-caption";
    versionLine.textContent = `Version ${version}`;
    wrap.append(icon, successHeading, versionLine);
    body.appendChild(wrap);
  }

  function renderFailure(): void {
    body.innerHTML = "";
    stageCaption = null;
    const wrap = document.createElement("div");
    wrap.className = "wx-publish-failure";
    const failureHeading = document.createElement("p");
    failureHeading.className = "wx-publish-state-heading";
    failureHeading.textContent = "Publishing didn't work this time.";
    const failureBody = document.createElement("p");
    failureBody.className = "wx-publish-blocked-body";
    failureBody.textContent = FAILURE_BODY;

    const actions = document.createElement("div");
    actions.className = "wx-publish-blocked-actions";
    const retryButton = document.createElement("button");
    retryButton.type = "button";
    retryButton.className = "wx-publish-fix";
    retryButton.textContent = "Try again";
    retryButton.addEventListener("click", () => {
      void refetchAndRender();
    });
    const reportButton = document.createElement("button");
    reportButton.type = "button";
    reportButton.className = "wx-publish-report";
    reportButton.textContent = "Send a report";
    reportButton.addEventListener("click", () => {
      void handleReport("publish-failed", reportButton, "Send a report");
    });
    actions.append(retryButton, reportButton);

    wrap.append(failureHeading, failureBody, actions);
    body.appendChild(wrap);
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
