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
  const match = /#\/chat\/([^/]+)$/.exec(url);
  if (!match?.[1]) throw new Error(`expected a conversation id in the URL, got: ${url}`);
  return match[1];
}

test.describe("E2E 7: chat UX", () => {
  test("new conversation, scripted replies with a tool row, status dot transitions, send-retry on 502, and the offline banner", async ({
    page,
  }) => {
    const consoleErrors = trackConsoleErrors(page);

    // -- New conversation ---------------------------------------------------
    await page.goto("/admin#/chat");
    await page.waitForSelector(".wx-chat-list-view");
    await expect(page.locator(".wx-chat-empty")).toBeVisible();

    await page.click(".wx-chat-new-button");
    await page.fill(".wx-chat-compose-input", "please make the hero title warmer");
    const createResponse = page.waitForResponse(
      (res) => res.url().endsWith("/api/admin/chat/conversations") && res.request().method() === "POST",
    );
    await page.click(".wx-chat-compose-actions button");
    await createResponse;

    await page.waitForURL(/#\/chat\/.+/);
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
    await page.waitForURL(/#\/chat\/.+/);

    // The detail view's own live status strip (a SEPARATE signal from the
    // list dot above — decisions/00034 decision 2) also appears once ready.
    await page.waitForSelector(".wx-chat-status-strip:not([hidden])", { timeout: 10_000 });

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

    // -- Offline banner on fake-cmd stop (spec/06 §3) ------------------------
    await expect(page.locator(".wx-chat-offline-banner")).toBeHidden();
    await page.request.post("/test/chat/stop-fake-cmd");
    await page.waitForSelector(".wx-chat-offline-banner:not([hidden])", { timeout: 15_000 });
    await expect(page.locator(".wx-chat-offline-banner")).toContainText("offline");

    expect(consoleErrors).toEqual([]);
  });
});
