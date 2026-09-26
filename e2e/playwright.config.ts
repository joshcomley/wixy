import { defineConfig } from "@playwright/test";
import { availableParallelism } from "node:os";

// Each worker boots its OWN isolated fixture server (fixtures.ts) on a free port and gives the
// specs their `baseURL`, so there is no shared port, server or draft overlay to collide on and
// two sessions on one box can run the suite side by side. Set WIXY_E2E_PYTHON to the
// interpreter to launch fixture_server.py with (default "python3", right on CI's ubuntu-latest;
// locally this repo's convention is a specific pythoncore-3.14 install, see the project
// CLAUDE.md).
//
// Workers are capped, never "auto": each one is a Chromium plus a Python server (plus ffmpeg and
// image work in some specs), so they must leave real headroom. Default = 3/4 of the cores,
// capped at 4: 3 on a 4-vCPU CI runner, 4 on a big box. At 4 workers on 4 vCPUs the server-side
// photo bake behind section-panel's "align a photo pair" save ran past its 5 s wait (measured on
// CI). WIXY_E2E_WORKERS overrides; `1` reproduces the old fully serial run for debugging.
const DEFAULT_WORKERS = Math.min(4, Math.max(1, Math.floor(availableParallelism() * 0.75)));
const WORKERS = Number(process.env["WIXY_E2E_WORKERS"] ?? DEFAULT_WORKERS);

export default defineConfig({
  testDir: "./tests",
  // Tests WITHIN a spec file stay serial (they share that file's server state and several depend
  // on each other's ordering); whole files are what get handed to a free worker.
  fullyParallel: false,
  workers: WORKERS,
  reporter: "list",
});
