import { expect, test } from "@playwright/test";

// Replaced by the real fixture-server E2E flows in milestone 7+ (spec/08 §2).
test("playwright wiring smoke", async ({ page }) => {
  await page.setContent("<h1>Wixy</h1>");
  await expect(page.locator("h1")).toHaveText("Wixy");
});
