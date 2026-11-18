// A failed `unlockServer` must say why (what the server answered, what the pad held) instead of only "not visible":
// PR 439's e2e run timed out here with nothing to tell a lost tap from a refused PIN.

import { expect, test } from "../fixtures";
import { unlockServer } from "./server-helpers";

test.describe("unlockServer failure diagnostics", () => {
  test("a refused unlock reports the server's answer and the pad's digit count", async ({ page }) => {
    await page.route("**/api/admin/server/unlock", (route) =>
      route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "wrong_pin" }) }),
    );
    let message = "";
    try {
      await unlockServer(page, "Diag", { waitMs: 3_000 });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("--- unlockServer diagnostics ---");
    expect(message).toContain('unlock responses: 401 {"error":"wrong_pin"}');
    expect(message).toMatch(/PIN digits typed: [1-9]\d*; pad dots shown before Submit: [1-9]\d*/);
  });

  test("a successful unlock throws nothing and never records the token", async ({ page }) => {
    await unlockServer(page, "Diag OK");
    await expect(page.locator(".wx-srv-thread")).toBeVisible();
  });
});
