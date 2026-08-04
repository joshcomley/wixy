import { describe, expect, it, vi } from "vitest";
import type {
  AdminApi,
  PublishJobData,
  PublishOutcome,
  PublishPreview,
  RepairOutcome,
  SendReportOutcome,
  StateResponse,
} from "../src/api";
import {
  mountPublishDrawer,
  type PublishDrawer,
  type PublishDrawerDeps,
  type PublishStreamHandle,
} from "../src/publishDrawer";

/** A `GET /api/admin/state` snapshot whose only interesting field is the
 * `publishJob` the drawer's reconcile reads (decisions/00114) — `null` is "no
 * job on the server at all", the shape that means an unresolved publish really
 * did fail. */
function stateWithJob(job: PublishJobData | null): StateResponse {
  return {
    project: { slug: "ca", name: "Cottage Aesthetics", domain: "ca.example" },
    pages: [],
    draft: { rev: 5, opCount: 1 },
    live: { version: 28, sha: "c".repeat(40) },
    upstream: { aheadOfPublished: [], fetchedAt: null },
    publishJob: job,
    chats: [],
    adminSections: [],
    chatAttachmentsSupported: true,
  };
}

function jobData(overrides: Partial<PublishJobData> = {}): PublishJobData {
  return {
    id: "job-current",
    stage: "done",
    log: [],
    version: 29,
    error: null,
    isRunning: false,
    ...overrides,
  };
}

function fakeApi(overrides: Partial<AdminApi> = {}): AdminApi {
  return {
    getState: vi.fn(async () => stateWithJob(null)),
    getContent: vi.fn(),
    patchDraft: vi.fn(),
    discardDraft: vi.fn(),
    getMedia: vi.fn(),
    uploadMedia: vi.fn(),
    deleteMedia: vi.fn(),
    getTheme: vi.fn(),
    getPublishPreview: vi.fn(
      async (): Promise<PublishPreview> => ({
        changes: {},
        mediaChanges: { replaced: [], deleted: [] },
        opCount: 1,
        validate: { ok: true, errors: [] },
      }),
    ),
    publish: vi.fn(async (): Promise<PublishOutcome> => ({ kind: "ok", version: 1, sha: "a".repeat(40) })),
    repairDraft: vi.fn(
      async (): Promise<RepairOutcome> => ({
        kind: "ok",
        rev: 1,
        actions: [],
        validate: { ok: true, errors: [] },
      }),
    ),
    sendReport: vi.fn(async (): Promise<SendReportOutcome> => ({ emailed: true })),
    ...overrides,
  } as AdminApi;
}

function noopStream(): PublishStreamHandle {
  return { close: () => {} };
}

const BLOCKED_PREVIEW: PublishPreview = {
  changes: { gallery: [{ key: "gallery.sliders", kind: "list", old: [], new: [] }] },
  mediaChanges: { replaced: [], deleted: [] },
  opCount: 1,
  validate: {
    ok: false,
    errors: [
      { code: "schema", message: "gallery.sliders[0]: missing required property 'cat'", file: "content/gallery.json" },
    ],
  },
};

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("mountPublishDrawer — reviewable state", () => {
  it("renders the media-changes section when media replacements/deletions are staged", async () => {
    const drawer = mountPublishDrawer({
      api: fakeApi({
        getPublishPreview: vi.fn(async (): Promise<PublishPreview> => ({
          changes: {},
          mediaChanges: { replaced: ["hero.jpg"], deleted: ["unused.png"] },
          opCount: 2,
          validate: { ok: true, errors: [] },
        })),
      }),
      expectedRev: 0,
      upstream: [],
      onClose: vi.fn(),
      onPublished: vi.fn(),
      openStream: noopStream,
    });
    await flush();

    const section = drawer.element.querySelector(".wx-diff-media");
    expect(section).not.toBeNull();
    expect(section?.textContent).toContain("2 media changes");
    expect(section?.textContent).toContain("hero.jpg — replaced");
    expect(section?.textContent).toContain("unused.png — deleted");
    // and Publish stays enabled (opCount includes the media changes)
    const confirm = drawer.element.querySelector<HTMLButtonElement>(".wx-publish-confirm");
    expect(confirm?.disabled).toBe(false);
  });

  it("shows 'No content edits to review' when the preview has none", async () => {
    const drawer = mountPublishDrawer({
      api: fakeApi({
        getPublishPreview: vi.fn(async (): Promise<PublishPreview> => ({
          changes: {},
          mediaChanges: { replaced: [], deleted: [] },
          opCount: 1, // e.g. a staged page op — content changes alone can be empty
          validate: { ok: true, errors: [] },
        })),
      }),
      expectedRev: 0,
      upstream: [],
      onClose: vi.fn(),
      onPublished: vi.fn(),
      openStream: noopStream,
    });
    await flush();

    expect(drawer.element.querySelector(".wx-diff-empty")?.textContent).toBe(
      "No content edits to review.",
    );
  });

  it("disables Publish with a hint when there is nothing to ship (no staged changes, no upstream)", async () => {
    const publish = vi.fn();
    const drawer = mountPublishDrawer({
      api: fakeApi({
        getPublishPreview: vi.fn(async (): Promise<PublishPreview> => ({
          changes: {},
          mediaChanges: { replaced: [], deleted: [] },
          opCount: 0,
          validate: { ok: true, errors: [] },
        })),
        publish,
      }),
      expectedRev: 0,
      upstream: [],
      onClose: vi.fn(),
      onPublished: vi.fn(),
      openStream: noopStream,
    });
    await flush();

    const confirmButton = drawer.element.querySelector<HTMLButtonElement>(".wx-publish-confirm");
    expect(confirmButton?.disabled).toBe(true);
    expect(drawer.element.querySelector(".wx-publish-empty-hint")?.textContent).toContain(
      "Nothing to publish",
    );
    confirmButton?.click();
    await Promise.resolve();
    expect(publish).not.toHaveBeenCalled();
  });

  it("keeps Publish enabled when only upstream commits are pending (they merge on publish)", async () => {
    const drawer = mountPublishDrawer({
      api: fakeApi({
        getPublishPreview: vi.fn(async (): Promise<PublishPreview> => ({
          changes: {},
          mediaChanges: { replaced: [], deleted: [] },
          opCount: 0,
          validate: { ok: true, errors: [] },
        })),
      }),
      expectedRev: 0,
      upstream: [{ sha: "abc123", subject: "fix typo", author: "AI", when: "2026-01-01" }],
      onClose: vi.fn(),
      onPublished: vi.fn(),
      openStream: noopStream,
    });
    await flush();

    expect(
      drawer.element.querySelector<HTMLButtonElement>(".wx-publish-confirm")?.disabled,
    ).toBe(false);
    expect(drawer.element.querySelector(".wx-publish-empty-hint")).toBeNull();
  });

  it("keeps Publish enabled when staged page ops leave the content diff empty", async () => {
    const drawer = mountPublishDrawer({
      api: fakeApi(), // default preview: changes {}, opCount 1
      expectedRev: 0,
      upstream: [],
      onClose: vi.fn(),
      onPublished: vi.fn(),
      openStream: noopStream,
    });
    await flush();

    expect(
      drawer.element.querySelector<HTMLButtonElement>(".wx-publish-confirm")?.disabled,
    ).toBe(false);
    expect(drawer.element.querySelector(".wx-publish-empty-hint")).toBeNull();
  });

  it("renders diff entries grouped by page/global/theme", async () => {
    const api = fakeApi({
      getPublishPreview: vi.fn(async () => ({
        changes: {
          index: [{ key: "hero.title", kind: "text", old: "Old", new: "New" }],
          theme: [{ key: "colors.cream", kind: "theme", old: "#FFF", new: "#000" }],
        },
        mediaChanges: { replaced: [], deleted: [] },
        opCount: 2,
        validate: { ok: true, errors: [] },
      })),
    });
    const drawer = mountPublishDrawer({
      api,
      expectedRev: 0,
      upstream: [],
      onClose: vi.fn(),
      onPublished: vi.fn(),
      openStream: noopStream,
    });
    await flush();

    const groups = drawer.element.querySelectorAll(".wx-diff-group");
    expect(groups).toHaveLength(2);
    const rows = drawer.element.querySelectorAll(".wx-diff-row");
    expect(rows).toHaveLength(2);
    expect(drawer.element.querySelector(".wx-diff-key")?.textContent).toBe("hero.title");
  });

  it("renders an image thumbnail for img/bg kind entries instead of raw JSON", async () => {
    const api = fakeApi({
      getPublishPreview: vi.fn(async () => ({
        changes: {
          index: [
            {
              key: "hero.bg",
              kind: "bg",
              old: { src: "images/old.jpg", alt: "Old" },
              new: { src: "/admin/draft-media/new.jpg", alt: "New" },
            },
          ],
        },
        mediaChanges: { replaced: [], deleted: [] },
        opCount: 1,
        validate: { ok: true, errors: [] },
      })),
    });
    const drawer = mountPublishDrawer({
      api,
      expectedRev: 0,
      upstream: [],
      onClose: vi.fn(),
      onPublished: vi.fn(),
      openStream: noopStream,
    });
    await flush();

    const thumbs = drawer.element.querySelectorAll<HTMLImageElement>(".wx-diff-thumb");
    expect(thumbs).toHaveLength(2);
    expect(thumbs[0]?.src).toContain("images/old.jpg");
    expect(thumbs[1]?.src).toContain("/admin/draft-media/new.jpg");
  });

  it("shows updates made outside the editor (layman wording for upstream commits) when present", async () => {
    const drawer = mountPublishDrawer({
      api: fakeApi(),
      expectedRev: 0,
      upstream: [{ sha: "abc123", subject: "fix typo", author: "AI", when: "2026-01-01" }],
      onClose: vi.fn(),
      onPublished: vi.fn(),
      openStream: noopStream,
    });
    await flush();

    expect(drawer.element.querySelector(".wx-diff-upstream h4")?.textContent).toBe(
      "1 update made outside the editor",
    );
    expect(drawer.element.querySelector(".wx-diff-upstream li")?.textContent).toBe(
      "fix typo — AI",
    );
    // The plain-English explainer — what these ARE and that publishing covers
    // them — is what makes the section understandable to a non-technical owner.
    expect(drawer.element.querySelector(".wx-diff-upstream-note")?.textContent).toContain(
      "Publishing takes everything live",
    );
  });

  it("the message field is pre-filled with the spec default", async () => {
    const drawer = mountPublishDrawer({
      api: fakeApi(),
      expectedRev: 0,
      upstream: [],
      onClose: vi.fn(),
      onPublished: vi.fn(),
      openStream: noopStream,
    });
    await flush();

    const input = drawer.element.querySelector<HTMLInputElement>(".wx-field-row input");
    expect(input?.value).toBe("Content update via Wixy editor");
  });

  it("closing calls onClose", async () => {
    const onClose = vi.fn();
    const drawer = mountPublishDrawer({
      api: fakeApi(),
      expectedRev: 0,
      upstream: [],
      onClose,
      onPublished: vi.fn(),
      openStream: noopStream,
    });
    drawer.element.querySelector<HTMLButtonElement>(".wx-drawer-close")?.click();
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("mountPublishDrawer — blocked state (decisions/00095)", () => {
  it("renders a calm blocked panel with no raw validator output", async () => {
    const drawer = mountPublishDrawer({
      api: fakeApi({ getPublishPreview: vi.fn(async () => BLOCKED_PREVIEW) }),
      expectedRev: 0,
      upstream: [],
      onClose: vi.fn(),
      onPublished: vi.fn(),
      openStream: noopStream,
    });
    await flush();

    expect(drawer.element.querySelector(".wx-publish-blocked h4")?.textContent).toBe(
      "Publishing is paused",
    );
    expect(drawer.element.querySelector(".wx-publish-blocked-body")?.textContent).toContain(
      "Your live site is unaffected",
    );
    // Never the raw validator error text anywhere in the drawer.
    expect(drawer.element.textContent).not.toContain("missing required property");
    expect(drawer.element.textContent).not.toContain("gallery.sliders[0]");
    // No diff/confirm UI while blocked — publishing would just 422.
    expect(drawer.element.querySelector(".wx-publish-confirm")).toBeNull();
    expect(drawer.element.querySelector(".wx-diff-groups")).toBeNull();
  });

  it("Fix it for me: on full success, toasts the actions and re-renders unblocked", async () => {
    const onToast = vi.fn();
    const getPublishPreview = vi
      .fn<() => Promise<PublishPreview>>()
      .mockResolvedValueOnce(BLOCKED_PREVIEW)
      .mockResolvedValueOnce({
        changes: {},
        mediaChanges: { replaced: [], deleted: [] },
        opCount: 0,
        validate: { ok: true, errors: [] },
      });
    const repairDraft = vi.fn(
      async (): Promise<RepairOutcome> => ({
        kind: "ok",
        rev: 5,
        actions: ["Restored the 'Before & After' page to its last published version."],
        validate: { ok: true, errors: [] },
      }),
    );
    const drawer = mountPublishDrawer({
      api: fakeApi({ getPublishPreview, repairDraft }),
      expectedRev: 3,
      upstream: [],
      onClose: vi.fn(),
      onPublished: vi.fn(),
      onToast,
      openStream: noopStream,
    });
    await flush();

    drawer.element.querySelector<HTMLButtonElement>(".wx-publish-fix")?.click();
    await flush();
    await flush();

    expect(repairDraft).toHaveBeenCalledWith(3);
    expect(getPublishPreview).toHaveBeenCalledTimes(2); // initial load + post-fix refetch
    expect(onToast).toHaveBeenCalledWith(
      "Fixed — ready to publish. Restored the 'Before & After' page to its last published version.",
      "info",
    );
    // Re-rendered unblocked: the reviewable UI is back, blocked panel gone.
    expect(drawer.element.querySelector(".wx-publish-blocked")).toBeNull();
    expect(drawer.element.querySelector(".wx-diff-groups")).not.toBeNull();
  });

  it("Fix it for me: a later publish uses the rev the repair advanced to, not the drawer's original", async () => {
    const getPublishPreview = vi
      .fn<() => Promise<PublishPreview>>()
      .mockResolvedValueOnce(BLOCKED_PREVIEW)
      .mockResolvedValueOnce({
        changes: {},
        mediaChanges: { replaced: [], deleted: [] },
        opCount: 1,
        validate: { ok: true, errors: [] },
      });
    const repairDraft = vi.fn(
      async (): Promise<RepairOutcome> => ({
        kind: "ok",
        rev: 5,
        actions: [],
        validate: { ok: true, errors: [] },
      }),
    );
    const publish = vi.fn(async (): Promise<PublishOutcome> => ({ kind: "ok", version: 9, sha: "a".repeat(40) }));
    const drawer = mountPublishDrawer({
      api: fakeApi({ getPublishPreview, repairDraft, publish }),
      expectedRev: 3,
      upstream: [],
      onClose: vi.fn(),
      onPublished: vi.fn(),
      openStream: noopStream,
    });
    await flush();

    drawer.element.querySelector<HTMLButtonElement>(".wx-publish-fix")?.click();
    await flush();
    await flush();

    drawer.element.querySelector<HTMLButtonElement>(".wx-publish-confirm")?.click();
    await flush();

    expect(publish).toHaveBeenCalledWith("Content update via Wixy editor", 5);
  });

  it("Fix it for me: a partial fix keeps the drawer blocked and sends the report BY ITSELF (decisions/00114)", async () => {
    const repairDraft = vi.fn(
      async (): Promise<RepairOutcome> => ({
        kind: "ok",
        rev: 5,
        actions: ["Fixed some content in the 'Before & After' page."],
        validate: {
          ok: false,
          errors: [{ code: "binding-error", message: "some upstream template problem" }],
        },
      }),
    );
    const sendReport = vi.fn(async (): Promise<SendReportOutcome> => ({ emailed: true }));
    const drawer = mountPublishDrawer({
      api: fakeApi({
        getPublishPreview: vi.fn(async () => BLOCKED_PREVIEW),
        repairDraft,
        sendReport,
      }),
      expectedRev: 3,
      upstream: [],
      onClose: vi.fn(),
      onPublished: vi.fn(),
      openStream: noopStream,
    });
    await flush();

    drawer.element.querySelector<HTMLButtonElement>(".wx-publish-fix")?.click();
    await flush();
    await flush();

    expect(drawer.element.querySelector(".wx-publish-blocked-body")?.textContent).toContain(
      "couldn't fix everything automatically",
    );
    // The report went out unprompted, carrying the validator detail as its note.
    expect(sendReport).toHaveBeenCalledWith(
      "publish-validate",
      "binding-error: some upstream template problem",
    );
    expect(drawer.element.querySelector(".wx-publish-report-status")?.textContent).toBe(
      "Your developer has been told what went wrong.",
    );
    // Nothing left for her to press — this is a dead end, not a choice.
    expect(drawer.element.querySelector(".wx-publish-report")).toBeNull();
    expect(drawer.element.querySelector(".wx-publish-fix")).toBeNull();
    // Still never the raw validator text in front of the owner.
    expect(drawer.element.textContent).not.toContain("some upstream template problem");
  });

  it("Fix it for me: a repair conflict/failure toasts an error and re-enables the buttons", async () => {
    const onToast = vi.fn();
    const repairDraft = vi.fn(
      async (): Promise<RepairOutcome> => ({ kind: "conflict", message: "expected rev 3, overlay is at rev 4" }),
    );
    const drawer = mountPublishDrawer({
      api: fakeApi({ getPublishPreview: vi.fn(async () => BLOCKED_PREVIEW), repairDraft }),
      expectedRev: 3,
      upstream: [],
      onClose: vi.fn(),
      onPublished: vi.fn(),
      onToast,
      openStream: noopStream,
    });
    await flush();

    drawer.element.querySelector<HTMLButtonElement>(".wx-publish-fix")?.click();
    await flush();
    await flush();

    expect(onToast).toHaveBeenCalledWith(
      "That didn't work — please send a report instead.",
      "error",
    );
    // Never the raw conflict detail shown anywhere.
    expect(drawer.element.textContent).not.toContain("overlay is at rev");
    const fixButton = drawer.element.querySelector<HTMLButtonElement>(".wx-publish-fix");
    expect(fixButton?.disabled).toBe(false);
  });

  it("Send a report: toasts 'sent' when emailed, calls the server with the right context", async () => {
    const onToast = vi.fn();
    const sendReport = vi.fn(async (): Promise<SendReportOutcome> => ({ emailed: true }));
    const drawer = mountPublishDrawer({
      api: fakeApi({ getPublishPreview: vi.fn(async () => BLOCKED_PREVIEW), sendReport }),
      expectedRev: 0,
      upstream: [],
      onClose: vi.fn(),
      onPublished: vi.fn(),
      onToast,
      openStream: noopStream,
    });
    await flush();

    drawer.element.querySelector<HTMLButtonElement>(".wx-publish-report")?.click();
    await flush();

    expect(sendReport).toHaveBeenCalledWith("publish-validate");
    expect(onToast).toHaveBeenCalledWith("Report sent to your developer.", "info");
  });

  it("Send a report: toasts 'saved' (not 'sent') when email is unconfigured", async () => {
    const onToast = vi.fn();
    const drawer = mountPublishDrawer({
      api: fakeApi({
        getPublishPreview: vi.fn(async () => BLOCKED_PREVIEW),
        sendReport: vi.fn(async (): Promise<SendReportOutcome> => ({ emailed: false })),
      }),
      expectedRev: 0,
      upstream: [],
      onClose: vi.fn(),
      onPublished: vi.fn(),
      onToast,
      openStream: noopStream,
    });
    await flush();

    drawer.element.querySelector<HTMLButtonElement>(".wx-publish-report")?.click();
    await flush();

    expect(onToast).toHaveBeenCalledWith("Report saved for your developer.", "info");
  });
});

describe("mountPublishDrawer — publish running/success/failure states", () => {
  it("confirming spins into a running state and notifies onPublishStarted immediately (decisions/00089)", async () => {
    let resolvePublish: ((outcome: PublishOutcome) => void) | null = null;
    const publish = vi.fn(
      () => new Promise<PublishOutcome>((resolve) => { resolvePublish = resolve; }),
    );
    const onPublishStarted = vi.fn();
    const drawer = mountPublishDrawer({
      api: fakeApi({ publish }),
      expectedRev: 0,
      upstream: [],
      onClose: vi.fn(),
      onPublished: vi.fn(),
      onPublishStarted,
      openStream: noopStream,
    });
    await flush();

    const confirm = drawer.element.querySelector<HTMLButtonElement>(".wx-publish-confirm")!;
    confirm.click();

    // Synchronous with the click — the shell's status-bar watch must be armed
    // before any await, so closing the drawer at any point still completes.
    expect(onPublishStarted).toHaveBeenCalledOnce();
    expect(drawer.element.querySelector(".wx-publish-running")).not.toBeNull();
    expect(drawer.element.querySelector(".wx-publish-state-heading")?.textContent).toBe(
      "Publishing your site…",
    );
    // The old per-button spinner/confirm UI is gone — the whole body swapped.
    expect(drawer.element.querySelector(".wx-publish-confirm")).toBeNull();

    resolvePublish!({ kind: "ok", version: 7, sha: "a".repeat(40) });
    await flush();
    await flush();

    expect(drawer.element.querySelector(".wx-publish-success")).not.toBeNull();
  });

  it("streams live stage captions from the injected openStream while publishing", async () => {
    const captured: { deliver: ((job: PublishJobData) => void) | null } = { deliver: null };
    const openStream = vi.fn((onUpdate: (job: PublishJobData) => void) => {
      captured.deliver = onUpdate;
      return { close: vi.fn() };
    });
    const drawer = mountPublishDrawer({
      api: fakeApi(),
      expectedRev: 0,
      upstream: [],
      onClose: vi.fn(),
      onPublished: vi.fn(),
      openStream,
    });
    await flush();

    drawer.element.querySelector<HTMLButtonElement>(".wx-publish-confirm")?.click();
    expect(openStream).toHaveBeenCalled();
    captured.deliver?.({
      id: "job-1",
      stage: "building",
      log: [],
      version: null,
      error: null,
      isRunning: true,
    });

    expect(drawer.element.querySelector(".wx-publish-state-caption")?.textContent).toBe(
      "Building the site…",
    );
  });

  it("a successful publish shows the version and calls onPublished", async () => {
    const publish = vi.fn(async () => ({ kind: "ok" as const, version: 7, sha: "b".repeat(40) }));
    const onPublished = vi.fn();
    const drawer = mountPublishDrawer({
      api: fakeApi({ publish }),
      expectedRev: 5,
      upstream: [],
      onClose: vi.fn(),
      onPublished,
      openStream: noopStream,
    });
    await flush();

    drawer.element.querySelector<HTMLButtonElement>(".wx-publish-confirm")?.click();
    await flush();
    await flush();

    expect(publish).toHaveBeenCalledWith("Content update via Wixy editor", 5);
    expect(drawer.element.querySelector(".wx-publish-state-heading")?.textContent).toBe(
      "Your site is live.",
    );
    expect(drawer.element.querySelector(".wx-publish-state-caption")?.textContent).toBe(
      "Version 7",
    );
    expect(onPublished).toHaveBeenCalledOnce();
    expect(onPublished).toHaveBeenCalledWith(7);
  });

  it("a conflict outcome shows the calm failure state, never the raw detail", async () => {
    const api = fakeApi({
      publish: vi.fn(async () => ({ kind: "conflict" as const, message: "expected rev 5, overlay is at rev 6" })),
    });
    const drawer = mountPublishDrawer({
      api,
      expectedRev: 5,
      upstream: [],
      onClose: vi.fn(),
      onPublished: vi.fn(),
      openStream: noopStream,
    });
    await flush();

    drawer.element.querySelector<HTMLButtonElement>(".wx-publish-confirm")?.click();
    await flush();
    await flush();

    expect(drawer.element.querySelector(".wx-publish-failure")).not.toBeNull();
    expect(drawer.element.querySelector(".wx-publish-state-heading")?.textContent).toBe(
      "Publishing didn't work this time.",
    );
    expect(drawer.element.textContent).not.toContain("overlay is at rev 6");
  });

  it("a failed (502) outcome shows the calm failure state and sends the report BY ITSELF (decisions/00114)", async () => {
    const sendReport = vi.fn(async (): Promise<SendReportOutcome> => ({ emailed: true }));
    const api = fakeApi({
      publish: vi.fn(async () => ({ kind: "failed" as const, message: "git tag failed: some git stderr" })),
      sendReport,
    });
    const drawer = mountPublishDrawer({
      api,
      expectedRev: 0,
      upstream: [],
      onClose: vi.fn(),
      onPublished: vi.fn(),
      openStream: noopStream,
    });
    await flush();

    drawer.element.querySelector<HTMLButtonElement>(".wx-publish-confirm")?.click();
    await flush();
    await flush();
    await flush();

    expect(drawer.element.querySelector(".wx-publish-blocked-body")?.textContent).toContain(
      "your edits are safe",
    );
    expect(drawer.element.textContent).not.toContain("git tag failed");
    expect(drawer.element.querySelector(".wx-publish-fix")?.textContent).toBe("Try again");
    // No button press needed — the diagnostic went out with the technical
    // reason attached as its note, and she's told so in her own language.
    expect(sendReport).toHaveBeenCalledWith("publish-failed", "git tag failed: some git stderr");
    expect(drawer.element.querySelector(".wx-publish-report-status")?.textContent).toBe(
      "Your developer has been told what went wrong.",
    );
    expect(drawer.element.querySelector(".wx-publish-report")).toBeNull();
  });

  it("the automatic report falling over leaves a manual Send a report button (decisions/00114)", async () => {
    const api = fakeApi({
      publish: vi.fn(async () => ({ kind: "failed" as const, message: "boom" })),
      sendReport: vi.fn(async (): Promise<SendReportOutcome> => {
        throw new Error("offline");
      }),
    });
    const drawer = mountPublishDrawer({
      api,
      expectedRev: 0,
      upstream: [],
      onClose: vi.fn(),
      onPublished: vi.fn(),
      openStream: noopStream,
    });
    await flush();

    drawer.element.querySelector<HTMLButtonElement>(".wx-publish-confirm")?.click();
    await flush();
    await flush();
    await flush();

    expect(drawer.element.querySelector(".wx-publish-report")?.textContent).toBe("Send a report");
    expect(drawer.element.querySelector(".wx-publish-report-status")?.textContent).toBe("");
  });

  it("Try again (after a failure) re-fetches the preview and returns to the reviewable state", async () => {
    const getPublishPreview = vi
      .fn<() => Promise<PublishPreview>>()
      .mockResolvedValueOnce({
        changes: {},
        mediaChanges: { replaced: [], deleted: [] },
        opCount: 1,
        validate: { ok: true, errors: [] },
      })
      .mockResolvedValueOnce({
        changes: {},
        mediaChanges: { replaced: [], deleted: [] },
        opCount: 1,
        validate: { ok: true, errors: [] },
      });
    const api = fakeApi({
      getPublishPreview,
      publish: vi.fn(async () => ({ kind: "failed" as const, message: "boom" })),
    });
    const drawer = mountPublishDrawer({
      api,
      expectedRev: 0,
      upstream: [],
      onClose: vi.fn(),
      onPublished: vi.fn(),
      openStream: noopStream,
    });
    await flush();

    drawer.element.querySelector<HTMLButtonElement>(".wx-publish-confirm")?.click();
    await flush();
    await flush();

    drawer.element.querySelector<HTMLButtonElement>(".wx-publish-fix")?.click();
    await flush();

    expect(getPublishPreview).toHaveBeenCalledTimes(2);
    expect(drawer.element.querySelector(".wx-diff-groups")).not.toBeNull();
  });

  it("a network-error rejection also lands in the calm failure state", async () => {
    const api = fakeApi({ publish: vi.fn(async () => { throw new Error("network down"); }) });
    const drawer = mountPublishDrawer({
      api,
      expectedRev: 0,
      upstream: [],
      onClose: vi.fn(),
      onPublished: vi.fn(),
      openStream: noopStream,
    });
    await flush();

    drawer.element.querySelector<HTMLButtonElement>(".wx-publish-confirm")?.click();
    await flush();
    await flush();

    expect(drawer.element.querySelector(".wx-publish-failure")).not.toBeNull();
    expect(drawer.element.textContent).not.toContain("network down");
  });

  it("onPublishSettled fires once the publish POST settles, in every outcome", async () => {
    const onPublishSettled = vi.fn();
    const api = fakeApi({
      publish: vi.fn(async () => ({ kind: "failed" as const, message: "boom" })),
    });
    const drawer = mountPublishDrawer({
      api,
      expectedRev: 0,
      upstream: [],
      onClose: vi.fn(),
      onPublished: vi.fn(),
      onPublishSettled,
      openStream: noopStream,
    });
    await flush();

    drawer.element.querySelector<HTMLButtonElement>(".wx-publish-confirm")?.click();
    await flush();
    await flush();

    expect(onPublishSettled).toHaveBeenCalledOnce();
  });

  it("teardown closes an in-flight stream", async () => {
    const close = vi.fn();
    const openStream = vi.fn(() => ({ close }));
    const drawer = mountPublishDrawer({
      api: fakeApi(),
      expectedRev: 0,
      upstream: [],
      onClose: vi.fn(),
      onPublished: vi.fn(),
      openStream,
    });
    await flush();

    drawer.element.querySelector<HTMLButtonElement>(".wx-publish-confirm")?.click();
    drawer.teardown();

    expect(close).toHaveBeenCalled();
  });
});

// The 2026-08-03 incident (decisions/00114): Purdi published from a phone, the
// site went live as version 29 — and the drawer said "Publishing didn't work
// this time." The POST had been aborted at the old blanket 10s timeout and
// blindly re-sent; the server answered the second one 409 and the drawer read
// THAT as the outcome. The publish JOB is the source of truth, not the POST.
describe("mountPublishDrawer — the outcome comes from the JOB, not the POST (decisions/00114)", () => {
  function mountAndConfirm(
    api: AdminApi,
    extra: {
      priorJobId?: string | null;
      onPublished?: (version: number) => void;
      openStream?: PublishDrawerDeps["openStream"];
    } = {},
  ): PublishDrawer {
    return mountPublishDrawer({
      api,
      expectedRev: 5,
      upstream: [],
      onClose: vi.fn(),
      onPublished: extra.onPublished ?? vi.fn(),
      openStream: extra.openStream ?? noopStream,
      ...(extra.priorJobId !== undefined ? { priorJobId: extra.priorJobId } : {}),
    });
  }

  /** A hand-driven stand-in for the SSE stream — `emit` pushes a job snapshot
   * into the drawer exactly as `EventSource` would. Held on an object so TS
   * doesn't narrow it to `null` (it's only ever assigned inside the callback). */
  function fakeStream(): {
    open: NonNullable<PublishDrawerDeps["openStream"]>;
    emit: (job: PublishJobData) => void;
  } {
    const holder: { onUpdate: ((job: PublishJobData) => void) | null } = { onUpdate: null };
    return {
      open: (onUpdate) => {
        holder.onUpdate = onUpdate;
        return { close: () => {} };
      },
      emit: (job) => holder.onUpdate?.(job),
    };
  }

  it("a 409 whose job actually reached done shows SUCCESS, not the failure state", async () => {
    const onPublished = vi.fn();
    const api = fakeApi({
      publish: vi.fn(async () => ({
        kind: "conflict" as const,
        message: "expected rev 165, overlay is at rev 166",
      })),
      getState: vi.fn(async () => stateWithJob(jobData({ id: "job-29", version: 29 }))),
    });
    const drawer = mountAndConfirm(api, { priorJobId: "job-28", onPublished });
    await flush();

    drawer.element.querySelector<HTMLButtonElement>(".wx-publish-confirm")?.click();
    await flush();
    await flush();
    await flush();

    expect(drawer.element.querySelector(".wx-publish-failure")).toBeNull();
    expect(drawer.element.querySelector(".wx-publish-state-heading")?.textContent).toBe(
      "Your site is live.",
    );
    expect(drawer.element.querySelector(".wx-publish-state-caption")?.textContent).toBe("Version 29");
    expect(onPublished).toHaveBeenCalledWith(29);
  });

  it("a POST lost to the network whose job reached done also shows SUCCESS", async () => {
    const api = fakeApi({
      publish: vi.fn(async () => {
        throw new Error("The operation was aborted");
      }),
      getState: vi.fn(async () => stateWithJob(jobData({ id: "job-30", version: 30 }))),
    });
    const drawer = mountAndConfirm(api, { priorJobId: null });
    await flush();

    drawer.element.querySelector<HTMLButtonElement>(".wx-publish-confirm")?.click();
    await flush();
    await flush();
    await flush();

    expect(drawer.element.querySelector(".wx-publish-state-heading")?.textContent).toBe(
      "Your site is live.",
    );
  });

  it("a PREVIOUS publish's leftover done job is never read as this one's success", async () => {
    const onPublished = vi.fn();
    const api = fakeApi({
      publish: vi.fn(async () => ({ kind: "conflict" as const, message: "a publish is already running" })),
      // The server keeps the last job forever — this is the one that was
      // already there when the drawer opened, so it proves nothing.
      getState: vi.fn(async () => stateWithJob(jobData({ id: "job-28", version: 28 }))),
    });
    const drawer = mountAndConfirm(api, { priorJobId: "job-28", onPublished });
    await flush();

    drawer.element.querySelector<HTMLButtonElement>(".wx-publish-confirm")?.click();
    await flush();
    await flush();
    await flush();

    expect(drawer.element.querySelector(".wx-publish-failure")).not.toBeNull();
    expect(onPublished).not.toHaveBeenCalled();
  });

  it("a job still running keeps the running state — an unresolved POST is not a failure", async () => {
    const api = fakeApi({
      publish: vi.fn(async () => ({ kind: "conflict" as const, message: "a publish is already running" })),
      getState: vi.fn(async () =>
        stateWithJob(jobData({ id: "job-31", stage: "building", version: null, isRunning: true })),
      ),
    });
    const drawer = mountAndConfirm(api, { priorJobId: null });
    await flush();

    drawer.element.querySelector<HTMLButtonElement>(".wx-publish-confirm")?.click();
    await flush();
    await flush();
    await flush();

    expect(drawer.element.querySelector(".wx-publish-running")).not.toBeNull();
    expect(drawer.element.querySelector(".wx-publish-failure")).toBeNull();
    drawer.teardown(); // stops the reconcile poll
  });

  it("the stream's terminal done event settles the drawer even if the POST never resolves", async () => {
    const stream = fakeStream();
    const onPublished = vi.fn();
    const api = fakeApi({
      publish: vi.fn(() => new Promise<never>(() => {})), // never settles
    });
    const drawer = mountAndConfirm(api, {
      priorJobId: "job-28",
      onPublished,
      openStream: stream.open,
    });
    await flush();

    drawer.element.querySelector<HTMLButtonElement>(".wx-publish-confirm")?.click();
    await flush();
    stream.emit(jobData({ id: "job-29", stage: "building", version: null, isRunning: true }));
    expect(drawer.element.querySelector(".wx-publish-state-caption")?.textContent).toBe(
      "Building the site…",
    );

    stream.emit(jobData({ id: "job-29", version: 29 }));
    await flush();

    expect(drawer.element.querySelector(".wx-publish-state-heading")?.textContent).toBe(
      "Your site is live.",
    );
    expect(onPublished).toHaveBeenCalledWith(29);
  });

  it("the stream's terminal failed event settles the drawer into the failure state", async () => {
    const stream = fakeStream();
    const sendReport = vi.fn(async (): Promise<SendReportOutcome> => ({ emailed: true }));
    const api = fakeApi({ publish: vi.fn(() => new Promise<never>(() => {})), sendReport });
    const drawer = mountAndConfirm(api, {
      priorJobId: null,
      openStream: stream.open,
    });
    await flush();

    drawer.element.querySelector<HTMLButtonElement>(".wx-publish-confirm")?.click();
    await flush();
    stream.emit(jobData({ id: "job-32", stage: "failed", version: null, error: "push rejected" }));
    await flush();
    await flush();

    expect(drawer.element.querySelector(".wx-publish-failure")).not.toBeNull();
    expect(drawer.element.textContent).not.toContain("push rejected");
    expect(sendReport).toHaveBeenCalledWith("publish-failed", "push rejected");
  });

  it("the stream's leftover terminal event from a PREVIOUS publish is ignored", async () => {
    const stream = fakeStream();
    const onPublished = vi.fn();
    const api = fakeApi({ publish: vi.fn(() => new Promise<never>(() => {})) });
    const drawer = mountAndConfirm(api, {
      priorJobId: "job-28",
      onPublished,
      openStream: stream.open,
    });
    await flush();

    drawer.element.querySelector<HTMLButtonElement>(".wx-publish-confirm")?.click();
    await flush();
    // The server's still-parked record of the LAST publish, delivered the
    // instant the stream opens — before this publish's own job exists.
    stream.emit(jobData({ id: "job-28", version: 28 }));
    await flush();

    expect(drawer.element.querySelector(".wx-publish-running")).not.toBeNull();
    expect(onPublished).not.toHaveBeenCalled();
  });
});
