import { defineConfig } from "@playwright/test";

// Fixture-server-backed E2E flows (spec/08-testing-acceptance.md §2) land in milestone 7
// onward. This config + the smoke test below only prove the CI wiring for now.
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL: "about:blank",
  },
});
