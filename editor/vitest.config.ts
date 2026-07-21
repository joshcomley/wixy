import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
  },
  server: {
    fs: {
      // tests/markdownText.test.ts loads the SHARED parity fixture at
      // ../builder/tests/fixtures/markdown-inline.json (Inv 20) — one level
      // above this package's root, which vite's default fs.strict allow-list
      // rejects in CI (no workspace root up there).
      allow: [".."],
    },
  },
});
