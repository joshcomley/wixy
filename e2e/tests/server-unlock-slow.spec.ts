// The Cookout specs' shared `unlockServer` helper must outlast a slow unlock round trip. On a loaded CI runner the
// post-PIN round trip took longer than the helper's old 5 s wait and the whole toasted sandwich spec failed there
// (PR 431 run). This spec delays the unlock response by 6 s, longer than that old wait and far inside
// LOADED_WAIT_MS, and asserts the helper still gets through: red on a 5 s wait, green on LOADED_WAIT_MS.

import { expect, test } from "../fixtures";
import { unlockServer } from "./cookout-helpers";

const SLOW_UNLOCK_MS = 6_000;

test("unlockServer waits out a slow unlock round trip", async ({ page }) => {
  test.setTimeout(90_000);
  await page.route("**/unlock", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, SLOW_UNLOCK_MS));
    await route.continue();
  });
  await unlockServer(page, "Alice");
  await expect(page.locator(".wx-srv-thread")).toBeVisible();
});
