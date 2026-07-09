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
  fullyParallel: false, // one shared fixture server + draft overlay — tests must not race each other
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
