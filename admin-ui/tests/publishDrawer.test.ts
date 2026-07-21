import { describe, expect, it, vi } from "vitest";
import type { AdminApi, PublishJobData, PublishOutcome, PublishPreview } from "../src/api";
import { mountPublishDrawer, type PublishStreamHandle } from "../src/publishDrawer";

function fakeApi(overrides: Partial<AdminApi> = {}): AdminApi {
  return {
    getState: vi.fn(),
    getContent: vi.fn(),
    patchDraft: vi.fn(),
    discardDraft: vi.fn(),
    getMedia: vi.fn(),
    uploadMedia: vi.fn(),
    deleteMedia: vi.fn(),
    getTheme: vi.fn(),
    getPublishPreview: vi.fn(async (): Promise<PublishPreview> => ({
      changes: {},
      opCount: 1,
      validate: { ok: true, errors: [] },
    })),
    publish: vi.fn(async (): Promise<PublishOutcome> => ({ kind: "ok", version: 1, sha: "a".repeat(40) })),
    ...overrides,
  } as AdminApi;
}

function noopStream(): PublishStreamHandle {
  return { close: () => {} };
}

describe("mountPublishDrawer", () => {
  it("shows 'No content edits to review' when the preview has none", async () => {
    const drawer = mountPublishDrawer({
      api: fakeApi({
        getPublishPreview: vi.fn(async (): Promise<PublishPreview> => ({
          changes: {},
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
    await Promise.resolve();
    await Promise.resolve();

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
    await Promise.resolve();
    await Promise.resolve();

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
    await Promise.resolve();
    await Promise.resolve();

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
    await Promise.resolve();
    await Promise.resolve();

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
    await Promise.resolve();
    await Promise.resolve();

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
    await Promise.resolve();
    await Promise.resolve();

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
    await Promise.resolve();
    await Promise.resolve();

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

  it("shows validate errors when the preview isn't ok", async () => {
    const api = fakeApi({
      getPublishPreview: vi.fn(async () => ({
        changes: {},
        opCount: 1,
        validate: {
          ok: false,
          errors: [{ code: "missing-image", message: "image file 'x.jpg' does not exist", file: "content/index.json" }],
        },
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
    await Promise.resolve();
    await Promise.resolve();

    expect(drawer.element.querySelector(".wx-diff-validate li")?.textContent).toBe(
      "content/index.json: image file 'x.jpg' does not exist",
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
    await Promise.resolve();
    await Promise.resolve();

    const input = drawer.element.querySelector<HTMLInputElement>(".wx-field-row input");
    expect(input?.value).toBe("Content update via Wixy editor");
  });

  it("confirming calls api.publish with the message and expectedRev, then reports success", async () => {
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
    await Promise.resolve();
    await Promise.resolve();

    drawer.element.querySelector<HTMLButtonElement>(".wx-publish-confirm")?.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(publish).toHaveBeenCalledWith("Content update via Wixy editor", 5);
    expect(drawer.element.querySelector(".wx-publish-progress")?.textContent).toBe(
      "Published as version 7.",
    );
    expect(onPublished).toHaveBeenCalledOnce();
  });

  it("a conflict outcome re-enables the form and shows the message", async () => {
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
    await Promise.resolve();
    await Promise.resolve();

    const confirmButton = drawer.element.querySelector<HTMLButtonElement>(".wx-publish-confirm");
    confirmButton?.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(confirmButton?.disabled).toBe(false);
    expect(drawer.element.querySelector(".wx-publish-error")?.textContent).toBe(
      "expected rev 5, overlay is at rev 6",
    );
  });

  it("a failed outcome shows the pipeline's error message inline", async () => {
    const api = fakeApi({
      publish: vi.fn(async () => ({ kind: "failed" as const, message: "git tag failed: ..." })),
    });
    const drawer = mountPublishDrawer({
      api,
      expectedRev: 0,
      upstream: [],
      onClose: vi.fn(),
      onPublished: vi.fn(),
      openStream: noopStream,
    });
    await Promise.resolve();
    await Promise.resolve();

    drawer.element.querySelector<HTMLButtonElement>(".wx-publish-confirm")?.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(drawer.element.querySelector(".wx-publish-error")?.textContent).toBe(
      "git tag failed: ...",
    );
  });

  it("streams stage updates from the injected openStream while publishing", async () => {
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
    await Promise.resolve();
    await Promise.resolve();

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

    expect(drawer.element.querySelector(".wx-publish-progress")?.textContent).toBe(
      "Publishing… (building)",
    );
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
    await Promise.resolve();
    await Promise.resolve();

    drawer.element.querySelector<HTMLButtonElement>(".wx-publish-confirm")?.click();
    drawer.teardown();

    expect(close).toHaveBeenCalled();
  });
});
