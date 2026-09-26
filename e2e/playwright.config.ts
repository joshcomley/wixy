import { defineConfig } from "@playwright/test";

// Each worker boots its OWN isolated fixture server (fixtures.ts) on a free port and gives the
// specs their `baseURL`, so there is no shared port, server or draft overlay to collide on and
// two sessions on one box can run the suite side by side. Set WIXY_E2E_PYTHON to the
// interpreter to launch fixture_server.py with (default "python3", right on CI's ubuntu-latest;
// locally this repo's convention is a specific pythoncore-3.14 install, see the project
// CLAUDE.md).
//
// Workers are capped, never "auto" (each one is a Chromium plus a Python server, and the suite is
// timing-sensitive on a loaded box). WIXY_E2E_WORKERS overrides the cap; `1` reproduces the old
// fully serial run for debugging.
const WORKERS = Number(process.env["WIXY_E2E_WORKERS"] ?? "4");

export default defineConfig({
  testDir: "./tests",
  // Tests WITHIN a spec file stay serial (they share that file's server state and several depend
  // on each other's ordering); whole files are what get handed to a free worker.
  fullyParallel: false,
  workers: WORKERS,
  reporter: "list",
});
