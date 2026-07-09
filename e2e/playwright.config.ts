import { defineConfig } from "@playwright/test";

const PORT = 8799;

// The interpreter to launch fixture_server.py with. Defaults to "python3" (correct
// on CI's ubuntu-latest runner after actions/setup-python — verified there is no
// bare "python"/"python3" alias trap on Linux the way Windows's Microsoft Store stub
// is). Override locally via WIXY_E2E_PYTHON when the right interpreter isn't on
// PATH under that name (this repo's own convention: pythoncore-3.14, a specific
// non-PATH install location — see the project CLAUDE.md).
const PYTHON = process.env.WIXY_E2E_PYTHON ?? "python3";

export default defineConfig({
  testDir: "./tests",
  // One shared fixture server + ONE draft overlay for every spec file — `fullyParallel:
  // false` alone only serializes tests WITHIN a single file; different .spec.ts files
  // still land on separate workers by default and race each other's PATCH /api/admin/
  // draft calls against the same overlay rev (a real 409 found the moment a SECOND spec
  // file existed alongside concurrent-editing.spec.ts — invisible before that with only
  // one file to run). `workers: 1` is what actually guarantees global seriality; revisit
  // if the suite ever grows enough to need per-file isolated fixture servers instead.
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
  },
  webServer: {
    command: `${PYTHON} fixture_server.py`,
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
