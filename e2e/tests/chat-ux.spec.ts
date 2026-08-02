// E2E 7 (spec/08-testing-acceptance.md §2): "new conversation → scripted fake
// replies incl. tool-activity rows + status dot transitions; send-retry on
// injected 502; offline banner on fake-cmd stop."
//
// Drives the REAL admin chat panel (milestone 10) against fixture_server.py's
// real FakeCmdServer (wixy_server/tests/fake_cmd.py) — the same double the
// Python unit suite uses, wired in via /test/chat/* fixture-only endpoints
// (never imported by product code, mirroring E2E 6's own
// /test/simulate-upstream-commit pattern). This is the LAST flow of the
// suite by design (`/test/chat/stop-fake-cmd` is a one-way action; safe only
// because no other spec file touches chat/cmd — see fixture_server.py's own
// note).

import { expect, test } from "@playwright/test";
import { trackConsoleErrors } from "./helpers";

interface FakeMessage {
  index: number;
  role: string;
  kind: string;
  text: string | null;
  timestamp: string;
  tool_name: string | null;
  truncated: boolean;
}

function convIdFromUrl(url: string): string {
  const match = /\/admin\/chat\/([^/]+)$/.exec(url);
  if (!match?.[1]) throw new Error(`expected a conversation id in the URL, got: ${url}`);
  return match[1];
}

test.describe("E2E 7: chat UX", () => {
  test("new conversation, scripted replies with a tool row, status dot transitions, send-retry on 502, and the offline banner", async ({
    page,
  }) => {
    // decisions/00110 roughly doubled this flow's legs (echo, thumbnails +
    // lightbox, layout invariants, jump pill, auto-grow, new-conversation
    // attachments) — the default 30s test timeout is genuinely too short now.
    test.setTimeout(120_000);
    const consoleErrors = trackConsoleErrors(page);

    // -- New conversation ---------------------------------------------------
    await page.goto("/admin/chat");
    await page.waitForSelector(".wx-chat-list-view");
    await expect(page.locator(".wx-chat-empty")).toBeVisible();

    await page.click(".wx-chat-new-button");
    await page.fill(".wx-chat-compose-input", "please make the hero title warmer");
    const createResponse = page.waitForResponse(
      (res) => res.url().endsWith("/api/admin/chat/conversations") && res.request().method() === "POST",
    );
    await page.click(".wx-chat-compose-actions button");
    await createResponse;

    await page.waitForURL(/\/admin\/chat\/.+/);
    const convId = convIdFromUrl(page.url());

    // -- Status dot transitions: pending (at creation) -> ready (once settled) --
    // fixture_server.py's FakeCmdState(default_ready_after_polls=1) combined
    // with the client's own fast test-config poll interval resolves readiness
    // within ~0.2-0.4s of creation — too narrow a window to reliably still
    // observe "pending" after a UI round-trip (navigate away, wait, navigate
    // back), so "pending" is asserted from the CREATE response body itself
    // (a synchronous fact at the moment of creation, no race) rather than by
    // racing the UI to catch a transient state.
    const createBody = (await createResponse.then((r) => r.json())) as { status: string };
    expect(createBody.status).toBe("pending");

    await page.click(".wx-chat-back-link");
    await page.waitForSelector(".wx-chat-list-view");
    await expect(page.locator(".wx-chat-dot").first()).toHaveClass(/wx-chat-dot-ready/, {
      timeout: 10_000,
    });

    await page.click(".wx-chat-list-title");
    await page.waitForURL(/\/admin\/chat\/.+/);

    // decisions/00097: the detail view's work banner is a SEPARATE signal
    // from the list dot above (decisions/00034 decision 2) — but unlike the
    // old always-shown status strip, it stays hidden with nothing actionable
    // to report (no fresh activity, no send in flight, no open task list).
    await expect(page.locator(".wx-chat-work-banner")).toBeHidden();

    // -- Scripted fake reply with a wixy-tasks block (decisions/00097) ------
    const taskMessages: FakeMessage[] = [
      {
        index: 0,
        role: "user",
        kind: "text",
        text: "please make the hero title warmer",
        timestamp: "2026-07-10T00:00:00Z",
        tool_name: null,
        truncated: false,
      },
      {
        index: 1,
        role: "assistant",
        kind: "text",
        text:
          "I'll warm up the hero title now.\n\n" +
          '```wixy-tasks\n{"tasks": [{"label": "Warm up the hero title", "status": "doing"}]}\n```',
        timestamp: "2026-07-10T00:00:01Z",
        tool_name: null,
        truncated: false,
      },
    ];
    const setTaskMessagesResponse = await page.request.post("/test/chat/set-messages", {
      data: { convId, messages: taskMessages },
    });
    expect(setTaskMessagesResponse.status()).toBe(200);

    // The raw block never reaches the bubble — only the plain sentence does.
    await expect(page.locator(".wx-chat-bubble-assistant")).toContainText(
      "I'll warm up the hero title now.",
    );
    await expect(page.locator(".wx-chat-bubble-assistant")).not.toContainText("wixy-tasks");

    await expect(page.locator(".wx-chat-work-banner")).toBeVisible();
    await expect(page.locator(".wx-chat-work-banner")).toContainText("Working on your tasks");
    await expect(page.locator(".wx-chat-tasks-header")).toHaveText("Tasks · 0 of 1 done");
    await expect(page.locator(".wx-chat-task")).toContainText("Warm up the hero title");

    // The list view's own row pulse is a SEPARATE, server-cached signal
    // (decisions/00097's WorkingCache) driven purely by cmd's own `activity`
    // field — an ENUM ("active"/"idle"/"done"/"unknown", decisions/00099,
    // 00100), NOT a timestamp — NOT by the task-block content the detail view
    // just used, so it needs its own scripted fact to observe through the
    // real UI.
    await page.request.post("/test/chat/set-activity", {
      data: { convId, activity: "active" },
    });
    await page.click(".wx-chat-back-link");
    await expect(page.locator(".wx-chat-dot").first()).toHaveClass(/wx-chat-dot-working/, {
      timeout: 10_000,
    });
    await expect(page.locator(".wx-chat-list-note")).toContainText("working");
    await page.request.post("/test/chat/set-activity", { data: { convId, activity: "idle" } });

    await page.click(".wx-chat-list-title");
    await page.waitForURL(/\/admin\/chat\/.+/);

    // Marking the task done clears the working state and shows all-done.
    const doneMessages: FakeMessage[] = [
      taskMessages[0] as FakeMessage,
      {
        index: 1,
        role: "assistant",
        kind: "text",
        text:
          "Done — the hero title is warmer now.\n\n" +
          '```wixy-tasks\n{"tasks": [{"label": "Warm up the hero title", "status": "done"}]}\n```',
        timestamp: "2026-07-10T00:00:02Z",
        tool_name: null,
        truncated: false,
      },
    ];
    await page.request.post("/test/chat/set-messages", { data: { convId, messages: doneMessages } });
    await expect(page.locator(".wx-chat-work-banner")).toContainText("All tasks completed", {
      timeout: 10_000,
    });

    // -- Scripted fake reply incl. a collapsed tool-activity row -------------
    const scriptedMessages: FakeMessage[] = [
      {
        index: 0,
        role: "user",
        kind: "text",
        text: "please make the hero title warmer",
        timestamp: "2026-07-10T00:00:00Z",
        tool_name: null,
        truncated: false,
      },
      {
        index: 1,
        role: "assistant",
        kind: "tool_use",
        text: "Edit content/index.json",
        timestamp: "2026-07-10T00:00:01Z",
        tool_name: "Edit",
        truncated: false,
      },
      {
        index: 2,
        role: "assistant",
        kind: "tool_result",
        text: "ok",
        timestamp: "2026-07-10T00:00:02Z",
        tool_name: null,
        truncated: false,
      },
      {
        index: 3,
        role: "assistant",
        kind: "text",
        text: "Done! I made **hero.title** warmer.",
        timestamp: "2026-07-10T00:00:03Z",
        tool_name: null,
        truncated: false,
      },
    ];
    const setMessagesResponse = await page.request.post("/test/chat/set-messages", {
      data: { convId, messages: scriptedMessages },
    });
    expect(setMessagesResponse.status()).toBe(200);
    expect((await setMessagesResponse.json()) as { ok: boolean }).toEqual({ ok: true });

    await page.waitForSelector(".wx-chat-tool-row");
    await expect(page.locator(".wx-chat-tool-summary")).toHaveText("⚙ 2 actions");
    await expect(page.locator(".wx-chat-bubble-assistant strong")).toHaveText("hero.title");

    // Collapsed by default; expands on click (spec/06 §1's "expandable, monospace").
    await expect(page.locator(".wx-chat-tool-details")).toBeHidden();
    await page.click(".wx-chat-tool-summary");
    await expect(page.locator(".wx-chat-tool-details")).toBeVisible();
    await expect(page.locator(".wx-chat-tool-details")).toContainText("Edit content/index.json");
    await expect(page.locator(".wx-chat-tool-details")).toContainText("[tool_result] ok");

    // -- Image attachment: real upload -> chip -> send (decisions/00103) ----
    // The attach button only appears once GET /api/admin/state's
    // chatAttachmentsSupported resolves true (the fake cmd backend via
    // CmdAIBackend, same as production's fleet edition) — a real network
    // round-trip, so it isn't necessarily painted the instant the page loads.
    await expect(page.locator(".wx-chat-attach-button")).toBeVisible({ timeout: 10_000 });
    const uploadResponse = page.waitForResponse(
      (res) => res.url().includes(`/chat/conversations/${convId}/attachments`) && res.request().method() === "POST",
    );
    await page.locator('.wx-chat-composer input[type="file"]').setInputFiles("fixtures/tiny-second-image.jpg");
    const uploaded = await uploadResponse;
    expect(uploaded.status()).toBe(200);
    const uploadedBody = (await uploaded.json()) as { attachmentId: string };

    await expect(page.locator(".wx-chat-attachment-chip")).toHaveCount(1);
    await expect(page.locator(".wx-chat-send-button")).toBeEnabled();

    await page.fill(".wx-chat-composer-input", "what's in this photo?");
    const attachedSendRequest = page.waitForRequest(
      (req) => req.url().includes(`/chat/conversations/${convId}/messages`) && req.method() === "POST",
    );
    await page.click(".wx-chat-send-button");
    const attachedSent = await attachedSendRequest;
    const attachedBody = attachedSent.postDataJSON() as { attachmentIds: string[] };
    expect(attachedBody.attachmentIds).toEqual([uploadedBody.attachmentId]);

    // The chip row clears once the send that referenced it succeeds.
    await expect(page.locator(".wx-chat-attachment-chip")).toHaveCount(0);
    await expect(page.locator(".wx-chat-composer-input")).toHaveValue("");

    // -- Send-retry on an injected 502 (spec/06 §3) --------------------------
    await page.request.post("/test/chat/set-send-status", { data: { convId, statusCode: 502 } });

    const firstSendRequest = page.waitForRequest(
      (req) => req.url().includes(`/chat/conversations/${convId}/messages`) && req.method() === "POST",
    );
    await page.fill(".wx-chat-composer-input", "thanks, one more tweak please");
    await page.click(".wx-chat-send-button");
    const firstSent = await firstSendRequest;
    const firstBody = firstSent.postDataJSON() as { idempotencyKey: string };

    await expect(page.locator(".wx-chat-composer-error")).toBeVisible();
    // Bubble-level error, composer keeps the text (spec/06 §3's exact wording).
    await expect(page.locator(".wx-chat-composer-input")).toHaveValue("thanks, one more tweak please");

    await page.request.post("/test/chat/set-send-status", { data: { convId, statusCode: 202 } });
    const retrySendRequest = page.waitForRequest(
      (req) => req.url().includes(`/chat/conversations/${convId}/messages`) && req.method() === "POST",
    );
    await page.click(".wx-chat-send-button");
    const retrySent = await retrySendRequest;
    const retryBody = retrySent.postDataJSON() as { idempotencyKey: string };

    // The whole point of the key: a manual retry reuses the SAME one (spec/06
    // §3: "manual retry with the same idempotency key") — not a fresh one.
    expect(retryBody.idempotencyKey).toBe(firstBody.idempotencyKey);
    await expect(page.locator(".wx-chat-composer-error")).toBeHidden();
    await expect(page.locator(".wx-chat-composer-input")).toHaveValue("");

    // -- decisions/00110: the echo paints instantly, then reconciles ---------
    await page.fill(".wx-chat-composer-input", "and make it cosier too");
    await page.click(".wx-chat-send-button");
    // The echo is visible IMMEDIATELY (dimmed, "sending…") — before the next
    // stream tick could possibly have delivered the server copy. (The earlier
    // legs' sends also still have echoes: this fake never streams those user
    // turns back, so only their 30s expiry would clear them — the point here
    // is THIS send's echo.)
    const echo = page.locator(".wx-chat-echo", { hasText: "and make it cosier too" });
    await expect(echo).toBeVisible();
    await expect(echo).toContainText("sending…");
    // Stream back ALL the user turns this fake never echoed (the two earlier
    // sends' too) — every outstanding echo reconciles away, leaving the later
    // legs with a clean, server-driven thread.
    const echoReconcileMessages: FakeMessage[] = [
      ...scriptedMessages,
      {
        index: 4,
        role: "user",
        kind: "text",
        text: "what's in this photo?",
        timestamp: "2026-07-10T00:00:04Z",
        tool_name: null,
        truncated: false,
      },
      {
        index: 5,
        role: "user",
        kind: "text",
        text: "thanks, one more tweak please",
        timestamp: "2026-07-10T00:00:05Z",
        tool_name: null,
        truncated: false,
      },
      {
        index: 6,
        role: "user",
        kind: "text",
        text: "and make it cosier too",
        timestamp: "2026-07-10T00:00:06Z",
        tool_name: null,
        truncated: false,
      },
    ];
    await page.request.post("/test/chat/set-messages", { data: { convId, messages: echoReconcileMessages } });
    // The server copy replaces the echo — one real bubble, no echoes left.
    await expect(echo).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator(".wx-chat-echo")).toHaveCount(0);
    await expect(
      page.locator(".wx-chat-bubble-user", { hasText: "and make it cosier too" }),
    ).toHaveCount(1);

    // -- decisions/00110: footer-text attachments render as thumbnails --------
    // A driver-routed send leaves cmd's `Attachments:` footer in the read-back
    // text — that raw machine path is what the operator saw rendered as prose.
    // It must now be stripped server-side and render as a thumbnail from
    // wixy's bytes proxy (the fake serves real WEBP bytes through it).
    const footerMessages: FakeMessage[] = [
      ...echoReconcileMessages,
      {
        index: 7,
        role: "user",
        kind: "text",
        text:
          "what do you see in this one?\n\nAttachments:\n" +
          `@C:\\Users\\josh\\.claude\\cmd-uploads\\${uploadedBody.attachmentId}\\converted.webp (640x480)`,
        timestamp: "2026-07-10T00:00:07Z",
        tool_name: null,
        truncated: false,
      },
    ];
    await page.request.post("/test/chat/set-messages", { data: { convId, messages: footerMessages } });
    const footerBubble = page.locator(".wx-chat-bubble-user").last();
    await expect(footerBubble).toContainText("what do you see in this one?", { timeout: 10_000 });
    await expect(footerBubble).not.toContainText("Attachments:");
    await expect(footerBubble).not.toContainText("cmd-uploads");
    const thumb = footerBubble.locator(".wx-chat-att-thumb img");
    await expect(thumb).toHaveCount(1);
    await expect(thumb).toHaveAttribute("src", new RegExp(`/api/admin/chat/uploads/${uploadedBody.attachmentId}/bytes`));
    // The proxied bytes really load (the fake serves a genuine 8x8 WEBP).
    await expect(thumb).toHaveJSProperty("naturalWidth", 8, { timeout: 10_000 });

    // Tap → lightbox with the full image; ✕ closes it again.
    await footerBubble.locator(".wx-chat-att-thumb").click();
    await expect(page.locator(".wx-chat-lightbox")).toBeVisible();
    await expect(page.locator(".wx-chat-lightbox img")).toHaveAttribute(
      "src",
      new RegExp(`/api/admin/chat/uploads/${uploadedBody.attachmentId}/bytes`),
    );
    await page.click(".wx-chat-lightbox-close");
    await expect(page.locator(".wx-chat-lightbox")).toHaveCount(0);

    // -- decisions/00110: layout invariants — one scroll region, pinned composer
    // Fill the thread well past overflowing so the scroll behavior is real.
    const longMessages: FakeMessage[] = Array.from({ length: 40 }, (_, i) => ({
      index: i,
      role: i % 2 === 0 ? "user" : "assistant",
      kind: "text",
      text: `filler message number ${i} — enough text to make the thread genuinely tall enough to overflow`,
      timestamp: `2026-07-10T00:01:${String(i).padStart(2, "0")}Z`,
      tool_name: null,
      truncated: false,
    }));
    await page.request.post("/test/chat/set-messages", { data: { convId, messages: longMessages } });
    await expect(page.locator(".wx-chat-bubble").last()).toContainText("filler message number 39", { timeout: 10_000 });

    // The THREAD scrolls internally; the shell's main region does NOT (that
    // was the double-scroll). The composer is fully on-screen without any
    // scrolling — the whole point of the pinned layout.
    const metrics = await page.evaluate(() => {
      const thread = document.querySelector<HTMLElement>(".wx-chat-thread")!;
      const main = document.querySelector<HTMLElement>(".wx-main")!;
      const composer = document.querySelector<HTMLElement>(".wx-chat-composer")!;
      const rect = composer.getBoundingClientRect();
      return {
        threadScrollable: thread.scrollHeight > thread.clientHeight + 1,
        mainScrolls: main.scrollHeight > main.clientHeight + 1,
        composerTop: rect.top,
        composerBottom: rect.bottom,
        viewportHeight: window.innerHeight,
      };
    });
    expect(metrics.threadScrollable).toBe(true);
    expect(metrics.mainScrolls).toBe(false);
    expect(metrics.composerTop).toBeGreaterThanOrEqual(0);
    expect(metrics.composerBottom).toBeLessThanOrEqual(metrics.viewportHeight);

    // Scrolled up reading history, a new arrival surfaces the jump pill —
    // never yanks you down; clicking it lands you back at the newest message.
    await page.locator(".wx-chat-thread").evaluate((el) => el.scrollTo(0, 0));
    const oneMore: FakeMessage[] = [
      ...longMessages,
      {
        index: 40,
        role: "assistant",
        kind: "text",
        text: "one more late arrival",
        timestamp: "2026-07-10T00:02:00Z",
        tool_name: null,
        truncated: false,
      },
    ];
    await page.request.post("/test/chat/set-messages", { data: { convId, messages: oneMore } });
    await expect(page.locator(".wx-chat-jump-pill")).toBeVisible({ timeout: 10_000 });
    const stillUpTop = await page.locator(".wx-chat-thread").evaluate((el) => el.scrollTop);
    expect(stillUpTop).toBeLessThan(50);
    await page.click(".wx-chat-jump-pill");
    await expect(page.locator(".wx-chat-bubble").last()).toContainText("one more late arrival");
    const atBottom = await page.locator(".wx-chat-thread").evaluate(
      (el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 2,
    );
    expect(atBottom).toBe(true);

    // -- decisions/00110: the composer auto-grows with long input -------------
    const before = await page.locator(".wx-chat-composer-input").evaluate((el) => (el as HTMLElement).offsetHeight);
    await page.fill(".wx-chat-composer-input", "line one\nline two\nline three\nline four\nline five\nline six");
    const after = await page.locator(".wx-chat-composer-input").evaluate((el) => (el as HTMLElement).offsetHeight);
    expect(after).toBeGreaterThan(before);
    // …and never beyond the cap (180px content + padding), with internal
    // scrolling past it.
    const capped = await page.locator(".wx-chat-composer-input").evaluate((el) => (el as HTMLElement).offsetHeight);
    expect(capped).toBeLessThanOrEqual(200);
    await page.fill(".wx-chat-composer-input", "");

    // -- decisions/00110: attachments in the NEW-conversation flow ------------
    // The operator's exact complaint: "when you start a chat, you can't attach
    // an image." The shared composer backs the list view's compose box too.
    await page.click(".wx-chat-back-link");
    await page.waitForSelector(".wx-chat-list-view");
    await page.click(".wx-chat-new-button");
    await expect(page.locator(".wx-chat-compose-box .wx-chat-attach-button")).toBeVisible({ timeout: 10_000 });
    await page.locator('.wx-chat-compose-box input[type="file"]').setInputFiles("fixtures/tiny-second-image.jpg");
    await expect(page.locator(".wx-chat-compose-box .wx-chat-attachment-chip")).toHaveCount(1);
    await page.fill(".wx-chat-compose-input", "please describe this photo");
    const secondCreate = page.waitForRequest(
      (req) => req.url().endsWith("/api/admin/chat/conversations") && req.method() === "POST",
    );
    await page.click(".wx-chat-compose-actions button");
    const secondCreateBody = (await secondCreate).postDataJSON() as { firstMessage?: string; attachmentIds?: string[] };
    expect(secondCreateBody.firstMessage).toBe("please describe this photo");
    expect(secondCreateBody.attachmentIds).toHaveLength(1);
    await page.waitForURL(/\/admin\/chat\/.+/);
    // And the new conversation keeps the pinned-composer layout (it is, after
    // all, the same view).
    const secondMetrics = await page.evaluate(() => {
      const composer = document.querySelector<HTMLElement>(".wx-chat-composer")!;
      const rect = composer.getBoundingClientRect();
      return { bottom: rect.bottom, viewportHeight: window.innerHeight };
    });
    expect(secondMetrics.bottom).toBeLessThanOrEqual(secondMetrics.viewportHeight);

    // Back into the FIRST conversation for the offline leg (its messages are
    // the scripted ones; the fake cmd is shared). The fresh second
    // conversation (still provisioning, title unreadable) is row 1, so the
    // original conversation is the SECOND row — never a title-text match,
    // which would race its own readiness poll.
    await page.click(".wx-chat-back-link");
    await page.waitForSelector(".wx-chat-list-view");
    await page.locator(".wx-chat-list-row").nth(1).locator(".wx-chat-list-title").click();
    await page.waitForURL(new RegExp(`/admin/chat/${convId}$`));

    // -- Offline banner on fake-cmd stop (spec/06 §3) ------------------------
    // The offline banner surfaces only on a genuine POLL failure — hidden
    // while the stream is healthy (this conversation's scripted messages have
    // been flowing the whole time, so hidden here is a real assertion, not a
    // default state).
    await expect(page.locator(".wx-chat-bubble").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".wx-chat-offline-banner")).toBeHidden();
    await page.request.post("/test/chat/stop-fake-cmd");
    await page.waitForSelector(".wx-chat-offline-banner:not([hidden])", { timeout: 15_000 });
    await expect(page.locator(".wx-chat-offline-banner")).toContainText("offline");

    expect(consoleErrors).toEqual([]);
  });
});
